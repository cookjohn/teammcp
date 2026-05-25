/**
 * spawn-pty-via-daemon.mjs — Phase 4-T1 §4 sole entry point for agent
 * PTY creation. Replaces the local `pty.spawn()` call at
 * process-manager-impl-win.mjs:586 with an IPC round-trip to pty-daemon.
 *
 * NO local fallback path (per PM: "不保留本地 spawn 降级路径").
 *
 * Returns a DaemonPtyHandle that implements the subset of node-pty's IPty
 * interface that process-manager actually uses: .pid, .kill(), .onExit(),
 * .write(), .resize(), .onData().
 *
 * Fire-and-forget writes/acks; async kill/resize/reattach.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  spawnPty,
  killPtyWithReason,
  resizePty,
  writeToPty,
  onPtyOutput,
  onPtyExit,
  isConnected,
} from './pty-daemon-client.mjs';
import {
  bufferWrite,
  bufferResize,
  rememberSpawn,
  forgetSpawn,
  getFallbackState,
  STATE_CONNECTED,
  STATE_DEGRADED,
  STATE_RECONNECTING,
  // GAP β FIX (Phase 4-T1): register handleId→agentId so the reconnect
  // drain path in pty-daemon-client.mjs can route buffered writes via
  // writeToPty(agentId, data). Previously there was no mapping and
  // drainHandleBuffer had zero call sites.
  registerHandleAgent,
  unregisterHandleAgent,
} from './pty-fallback-state-machine.mjs';

// agentId → DaemonPtyHandle (for routing pty.data/pty.exit events)
const _handlesByAgent = new Map();

/**
 * DaemonPtyHandle — proxy object for a remote PTY owned by the daemon.
 * API-compatible with the subset of node-pty IPty that process-manager uses.
 */
class DaemonPtyHandle {
  constructor({ agentId, handleId, pid, spawnTimestamp }) {
    this.agentId = agentId;
    this.handleId = handleId;
    this.pid = pid;
    this.spawnTimestamp = spawnTimestamp;
    this._events = new EventEmitter();
    this._events.setMaxListeners(0);
    this._killed = false;
    this._health = 'connected';
  }

  get health() { return this._health; }
  get isConnected() { return isConnected(); }

  _setHealth(h) { this._health = h; }

  /**
   * Send input to the PTY. Fire-and-forget per spec §1.2. During DEGRADED
   * state, writes are buffered by the fallback state machine.
   */
  write(data) {
    const state = getFallbackState();
    if (state === STATE_DEGRADED || state === STATE_RECONNECTING) {
      bufferWrite(this.handleId, data);
      return;
    }
    // Fire-and-forget — the client layer wraps writeToPty.
    writeToPty(this.agentId, typeof data === 'string' ? data : data.toString()).catch(() => {});
  }

  /**
   * Resize the PTY. During DEGRADED, coalesces to the latest value.
   */
  async resize(cols, rows) {
    const state = getFallbackState();
    if (state === STATE_DEGRADED || state === STATE_RECONNECTING) {
      bufferResize(this.handleId, cols, rows);
      return;
    }
    return resizePty(this.agentId, cols, rows);
  }

  /**
   * Kill the PTY. Resolves once the daemon has acknowledged the kill
   * (the underlying process may still be exiting — a subsequent
   * `pty.exit` event fires).
   */
  async kill(reason) {
    this._killed = true;
    // GAP β FIX: unregister the handle→agent mapping on kill.
    try { unregisterHandleAgent(this.handleId); } catch {}
    try {
      await killPtyWithReason(this.agentId, reason || 'user_stop');
    } catch {
      // On DEGRADED/FAILED states, kill may not reach the daemon. That's
      // acceptable — the handle is being torn down anyway.
    }
  }

  /**
   * Register a listener for stdout/stderr chunks.
   */
  onData(listener) {
    this._events.on('data', listener);
    return { dispose: () => this._events.off('data', listener) };
  }

  /**
   * Register a one-shot exit listener.
   */
  onExit(listener) {
    this._events.once('exit', listener);
    return { dispose: () => this._events.off('exit', listener) };
  }

  _emitData(buf) {
    this._events.emit('data', buf);
  }

  _emitExit(exitCode, signal, reason) {
    this._events.emit('exit', { exitCode, signal, reason });
  }
}

// ── Global event routing ───────────────────────────────────────

let _routingWired = false;

function wireEventRouting() {
  if (_routingWired) return;
  _routingWired = true;

  // Use the v1.0 pty.output event shape (agent, buf). The v1.1 (handleId,
  // seq, credit-gated) shape exists in the protocol spec but pty-daemon-
  // client.mjs only emits v1.0 events; v1.1 wiring is T2 scope. Since
  // _handlesByAgent is one-handle-per-agent, agent name is sufficient
  // to route — no handleId filter needed.
  onPtyOutput((agent, buf) => {
    const h = _handlesByAgent.get(agent);
    if (h) h._emitData(buf);
  });

  // pty.exit emitted by pty-daemon-client.mjs is (agent, exitCode, signal,
  // timestamp). No `reason` field in the v1.0 client signal — the daemon
  // DOES include it in the notification body, but the client extractor
  // (pty-daemon-client.mjs:480) drops it. _emitExit just uses null reason.
  onPtyExit((agent, exitCode, signal /*, timestamp */) => {
    const h = _handlesByAgent.get(agent);
    if (h) {
      // GAP β FIX: clear the handle→agent mapping on exit so stale
      // entries don't linger in the fallback state machine's registry.
      try { unregisterHandleAgent(h.handleId); } catch {}
      h._emitExit(exitCode, signal, null);
      _handlesByAgent.delete(agent);
    }
  });
}

/**
 * Spawn a PTY via the daemon. This is the ONLY supported entry point for
 * agent PTY creation from process-manager — there is no local fallback.
 *
 * @param {string} agentId   Agent short name.
 * @param {string} shell     Absolute path to the shell binary.
 * @param {string[]} args    Arguments.
 * @param {{cwd: string, env: object, cols?: number, rows?: number, clientRequestId?: string}} options
 * @returns {Promise<DaemonPtyHandle>}
 */
export async function spawnPtyViaDaemon(agentId, shell, args, options = {}) {
  wireEventRouting();

  if (!isConnected()) {
    const err = new Error('DAEMON_UNREACHABLE: PTY Daemon not connected');
    err.code = 'DAEMON_UNREACHABLE';
    throw err;
  }

  const clientRequestId = options.clientRequestId || ('req-' + randomUUID());
  const spawnParams = {
    agent: agentId,
    cmd: shell,
    args,
    cwd: options.cwd,
    env: options.env,
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    clientRequestId,
  };

  // Remember the spawn in the fallback state machine so that if IPC drops
  // between send and response, the reconnect path can replay it with the
  // same clientRequestId (idempotency §1.1 B6).
  rememberSpawn(clientRequestId, spawnParams);

  let result;
  try {
    result = await spawnPty(agentId, shell, args, {
      cwd: spawnParams.cwd,
      env: spawnParams.env,
      cols: spawnParams.cols,
      rows: spawnParams.rows,
      clientRequestId,
    });
  } catch (err) {
    forgetSpawn(clientRequestId);
    const wrapped = new Error(`SPAWN_FAILED: ${err.message}`);
    wrapped.code = 'SPAWN_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  // Successful spawn — the idempotency record lives on the daemon side;
  // the local record was only needed to survive an in-flight drop.
  forgetSpawn(clientRequestId);

  const handle = new DaemonPtyHandle({
    agentId,
    handleId: result.handleId,
    pid: result.pid,
    spawnTimestamp: result.spawnTimestamp,
  });
  _handlesByAgent.set(agentId, handle);

  // GAP β FIX: record handleId → agentId so the fallback state machine's
  // reconnect drain path knows which agent owns each buffered handle.
  registerHandleAgent(result.handleId, agentId);

  return handle;
}

/**
 * Build a synthetic DaemonPtyHandle for an agent that was already running
 * inside the daemon BEFORE this server process started. Used by the
 * server-side reattach loop in index.mjs after `subscribeAll()` — when a
 * server restart finds the daemon alive with N agents, we need proxy
 * objects so process-manager's `processes` map and the WS terminal
 * bridge can address them.
 *
 * The caller is responsible for re-seeding scrollback if desired
 * (pty.scrollback RPC) — this helper only wires up the routing object.
 */
export function makeReattachHandle({ agentId, handleId, pid }) {
  wireEventRouting();
  const handle = new DaemonPtyHandle({
    agentId,
    handleId,
    pid,
    spawnTimestamp: null,
  });
  _handlesByAgent.set(agentId, handle);
  registerHandleAgent(handleId, agentId);
  return handle;
}

/**
 * Test hook: look up an existing handle by agent id (used by the reconnect
 * path to reattach after a transient IPC drop).
 */
export function getHandleByAgent(agentId) {
  return _handlesByAgent.get(agentId);
}

export function _testClearHandles() {
  _handlesByAgent.clear();
  _routingWired = false;
}
