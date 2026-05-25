/**
 * pty-watchdog.mjs — Phase 4-T1 §3 minimal daemon watchdog.
 *
 * Responsibilities:
 *   1. Track daemon respawn attempts on a rolling 60s window.
 *   2. Enforce a budget of 3 respawns per window; escalate on overrun.
 *   3. On daemon crash + empty pty.list, respawn affected agents via an
 *      externally-provided restart callback. process-manager does NOT
 *      respawn PTYs directly — the watchdog owns that decision.
 *
 * Escalation uses the existing State system (db.setState) with
 *   field  = "pty_daemon.status"
 *   value  = "escalated"
 *   reason = "respawn_loop"
 *
 * `resetDaemonEscalation()` clears the escalated state after manual or
 * CEO-driven intervention.
 */

import { EventEmitter } from 'node:events';
import {
  WATCHDOG_RESPAWN_WINDOW_MS,
  WATCHDOG_RESPAWN_BUDGET,
} from './ipc-protocol.mjs';

let _respawnTimestamps = [];
let _escalated = false;
let _escalationReason = null;
let _setStateFn = null;           // injected (db.setState or mock)
let _restartAgentFn = null;       // injected (process-manager.startAgent or mock)
let _notifyCallback = null;       // injected (sse push / log)

// ── Round 3 Appendix: double-respawn dedupe (Gap α-adjacent) ────────
// Two code paths in index.mjs both end up calling pm.startAgent(agentId)
// after a daemon crash:
//   Path 1: onAgentsNeedRespawn(ids) listener loops and calls
//           pm.startAgent directly.
//   Path 2: initDaemonWatchdog({restartAgent}) → requestAgentRestarts
//           → _restartAgentFn(id) → pm.startAgent
// Both fire from the SAME requestAgentRestarts() call, so without
// coordination the same id is respawned twice, racing the half-
// transaction family that Gap α exposes. This module-scoped Set is
// the shared dedupe bookkeeping. Both paths share the same Set because
// this module is a singleton, re-exported via daemon-launcher.mjs.
const _restartingAgents = new Set();

/**
 * Coalesce concurrent respawn requests for the same agent. If a call
 * for `agentId` is already in flight, subsequent calls return
 * immediately with `{skipped: true}` and log a warning.
 *
 * NOTE: this is belt-and-suspenders coordination. The underlying
 * `pm.startAgent` is expected to have its own idempotency, but the
 * Gap α static audit flagged a genuine window where the SIGKILL
 * daemon restart scenario produced duplicate `cleanupStaleProcEntry`
 * log lines per agent, proving the race is reachable in practice.
 *
 * @param {string}   agentId
 * @param {(id:string)=>Promise<any>} doRestart  restart fn to invoke
 * @returns {Promise<{skipped: boolean, result?: any, error?: Error}>}
 */
export async function dedupeRestartAgent(agentId, doRestart) {
  if (!agentId || typeof doRestart !== 'function') {
    return { skipped: false, error: new Error('dedupeRestartAgent: invalid args') };
  }
  if (_restartingAgents.has(agentId)) {
    console.error(
      '[WATCHDOG] skip double-respawn for agent=%s (already in flight)',
      agentId,
    );
    return { skipped: true };
  }
  _restartingAgents.add(agentId);
  try {
    const result = await doRestart(agentId);
    return { skipped: false, result };
  } catch (err) {
    return { skipped: false, error: err };
  } finally {
    _restartingAgents.delete(agentId);
  }
}

/**
 * Pre-claim a batch of agent ids before fanning out to the event
 * emitter. Any id already in the Set is returned as "alreadyClaimed"
 * and should be skipped by the caller's fan-out loop. This is the
 * mechanism that lets requestAgentRestarts dedupe the emit path (which
 * goes out to async listeners we can't await) against the injected-fn
 * path (which we control directly).
 *
 * Caller MUST call releaseRestartClaims(claimed) after the async work
 * settles, otherwise ids will leak in the Set.
 *
 * @param {string[]} agentIds
 * @returns {{claimed: string[], alreadyClaimed: string[]}}
 */
export function claimRestartBatch(agentIds) {
  const claimed = [];
  const alreadyClaimed = [];
  for (const id of agentIds) {
    if (!id) continue;
    if (_restartingAgents.has(id)) {
      alreadyClaimed.push(id);
    } else {
      _restartingAgents.add(id);
      claimed.push(id);
    }
  }
  return { claimed, alreadyClaimed };
}

/**
 * Release claims acquired via claimRestartBatch. Safe to call on an
 * empty array or ids that are no longer present.
 */
export function releaseRestartClaims(agentIds) {
  if (!Array.isArray(agentIds)) return;
  for (const id of agentIds) _restartingAgents.delete(id);
}

/**
 * Test/debug helper — returns a snapshot of in-flight ids.
 */
export function getRestartingAgents() {
  return Array.from(_restartingAgents);
}

// BUG 3 FIX (Phase 4-T1, Option A): event bus for lost-agent respawn.
// External consumers (process-manager layer, spawn-pty-via-daemon, tests)
// subscribe via onAgentsNeedRespawn() and implement the actual restart
// logic. The event fires BEFORE the injected _restartAgentFn path, so
// respawn can happen even if initWatchdog() has not been called yet.
const _emitter = new EventEmitter();
_emitter.setMaxListeners(0);

/**
 * Subscribe to 'agentsNeedRespawn' events. Listener receives the list of
 * lost agent ids. This is the PRIMARY hook point for Scenario C (daemon
 * crash + agents respawn under Option A semantics).
 *
 * @param {(lostAgentIds: string[]) => void|Promise<void>} listener
 * @returns {() => void} unsubscribe fn
 */
export function onAgentsNeedRespawn(listener) {
  _emitter.on('agentsNeedRespawn', listener);
  return () => _emitter.off('agentsNeedRespawn', listener);
}

/**
 * Wire the watchdog with external dependencies. Called once at server start.
 */
export function initWatchdog({ setState, restartAgent, notify }) {
  _setStateFn = setState || null;
  _restartAgentFn = restartAgent || null;
  _notifyCallback = notify || null;
}

function _pruneWindow(now) {
  const cutoff = now - WATCHDOG_RESPAWN_WINDOW_MS;
  _respawnTimestamps = _respawnTimestamps.filter(ts => ts >= cutoff);
}

/**
 * Record one respawn attempt. Returns { allowed, remaining, escalated }.
 * If budget is exhausted, sets the escalated state and returns allowed=false.
 */
export function recordRespawn() {
  if (_escalated) {
    return { allowed: false, remaining: 0, escalated: true };
  }
  const now = Date.now();
  _pruneWindow(now);
  if (_respawnTimestamps.length >= WATCHDOG_RESPAWN_BUDGET) {
    _escalated = true;
    _escalationReason = 'respawn_loop';
    _publishEscalation();
    return { allowed: false, remaining: 0, escalated: true };
  }
  _respawnTimestamps.push(now);
  return {
    allowed: true,
    remaining: WATCHDOG_RESPAWN_BUDGET - _respawnTimestamps.length,
    escalated: false,
  };
}

function _publishEscalation() {
  const meta = {
    respawn_timestamps: [..._respawnTimestamps],
    escalated_at: new Date().toISOString(),
  };
  if (typeof _setStateFn === 'function') {
    try {
      _setStateFn({
        field: 'pty_daemon.status',
        value: 'escalated',
        reason: _escalationReason,
        meta,
      });
    } catch (err) {
      console.error('[watchdog] setState escalation failed:', err.message);
    }
  }
  if (typeof _notifyCallback === 'function') {
    try {
      _notifyCallback({
        type: 'pty_daemon_escalated',
        reason: _escalationReason,
        meta,
      });
    } catch {}
  }
  console.error('[watchdog] ESCALATED: respawn loop detected —', JSON.stringify(meta));
}

/**
 * Clear the escalated state after manual intervention. Intended for CEO or
 * a human operator; not callable from process-manager directly.
 */
export async function resetDaemonEscalation(reason) {
  if (!_escalated) return;
  _escalated = false;
  _escalationReason = null;
  _respawnTimestamps = [];

  if (typeof _setStateFn === 'function') {
    try {
      _setStateFn({
        field: 'pty_daemon.status',
        value: 'ok',
        reason: reason || 'manual_reset',
        meta: { reset_at: new Date().toISOString() },
      });
    } catch (err) {
      console.error('[watchdog] setState reset failed:', err.message);
    }
  }
  console.log('[watchdog] Escalation reset:', reason || 'manual_reset');
}

export function isEscalated() {
  return _escalated;
}

/**
 * Called after a successful daemon reconnect where pty.list returned
 * empty (or fewer handles than the server tracked). For each agent the
 * server believed was alive, the watchdog:
 *   1. Emits 'agentsNeedRespawn' with the full lost-agent list
 *      (BUG 3 FIX: this fires regardless of whether _restartAgentFn is
 *       injected — subscribers via onAgentsNeedRespawn() handle respawn).
 *   2. Calls the injected _restartAgentFn for each lost agent if wired.
 *
 * Option A semantics (Phase 4-T1 §3 Scenario C redefinition):
 *   - Daemon crash kills all conpty handles (Windows constraint).
 *   - Watchdog respawns daemon.
 *   - Server-side agent tracker reports the lost list.
 *   - This function signals "respawn these from scratch" — agent runtime
 *     state (e.g. Claude session context) is lost, only the process
 *     supervision layer recovers.
 *
 * CALLER WIRING HOOK: at least one of
 *   a) initWatchdog({ restartAgent }) at server start, or
 *   b) onAgentsNeedRespawn(listener) subscription
 * must be in place for Scenario C to pass end-to-end. Without either,
 * this function logs the lost list and returns — recovery will not
 * occur but the event is observable.
 */
export async function requestAgentRestarts(lostAgentIds) {
  if (!Array.isArray(lostAgentIds) || lostAgentIds.length === 0) {
    return [];
  }

  // Always log and emit, even if no restart function is wired. This is
  // the "signal emitted" minimum guarantee for Bug 3.
  console.log(
    `[watchdog] Lost ${lostAgentIds.length} agent(s) after daemon respawn; ` +
    `emitting agentsNeedRespawn:`,
    lostAgentIds,
  );

  // Round 3 Appendix (Gap α-adjacent double-respawn dedupe):
  // Pre-claim the batch in the shared _restartingAgents Set BEFORE the
  // emit. This guarantees that Path 2 (injected _restartAgentFn loop
  // below) will not re-enter a respawn already in flight, and — once
  // index.mjs is updated in a follow-up commit to route its listener
  // body through dedupeRestartAgent — Path 1 (the onAgentsNeedRespawn
  // listener) will also observe the claim and skip duplicates.
  //
  // Any id that is "alreadyClaimed" here came from a concurrent
  // requestAgentRestarts call (rare but possible under rapid successive
  // daemon crashes). We skip those in the injected-fn loop too.
  const { claimed, alreadyClaimed } = claimRestartBatch(lostAgentIds);
  if (alreadyClaimed.length > 0) {
    console.error(
      '[WATCHDOG] skip double-respawn for %d agent(s) (already in flight): %j',
      alreadyClaimed.length,
      alreadyClaimed,
    );
  }

  try {
    _emitter.emit('agentsNeedRespawn', [...lostAgentIds]);
  } catch (err) {
    console.error('[watchdog] agentsNeedRespawn listener failed:', err?.message);
  }

  if (!_restartAgentFn) {
    console.warn(
      '[watchdog] No restartAgent function injected via initWatchdog(); ' +
      'relying on onAgentsNeedRespawn() subscribers to handle recovery.',
    );
    // Release our claims immediately — without an injected fn, the
    // listener (Path 1) is the only respawn path, and without a
    // deduped listener wrapper there's nothing for the Set to guard.
    // Holding the claim would pin ids indefinitely and block any
    // subsequent requestAgentRestarts for the same ids.
    releaseRestartClaims(claimed);
    return lostAgentIds.map(id => ({
      id,
      restarted: false,
      reason: 'no_restart_fn_wired',
    }));
  }

  const results = [];
  try {
    for (const id of lostAgentIds) {
      if (_escalated) {
        results.push({ id, restarted: false, reason: 'escalated' });
        continue;
      }
      // If this id was claimed by a concurrent caller (not us), skip
      // the injected-fn invocation — the other caller owns it.
      if (!claimed.includes(id)) {
        results.push({ id, restarted: false, reason: 'already_in_flight' });
        continue;
      }
      try {
        await _restartAgentFn(id);
        results.push({ id, restarted: true });
      } catch (err) {
        results.push({ id, restarted: false, reason: err?.message || 'error' });
      }
    }
  } finally {
    // Release every claim we acquired, regardless of individual outcomes.
    releaseRestartClaims(claimed);
  }
  return results;
}

/**
 * Test hook — wipe internal state.
 */
export function resetForTest() {
  _respawnTimestamps = [];
  _escalated = false;
  _escalationReason = null;
  _setStateFn = null;
  _restartAgentFn = null;
  _notifyCallback = null;
  _restartingAgents.clear();
  _emitter.removeAllListeners('agentsNeedRespawn');
}

export const _test = {
  windowSize: () => _respawnTimestamps.length,
  peek: () => [..._respawnTimestamps],
};
