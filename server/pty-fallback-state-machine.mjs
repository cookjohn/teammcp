/**
 * pty-fallback-state-machine.mjs — Phase 4-T1 §2 three-stage IPC fallback.
 *
 * Wraps the raw pty-daemon-client transport with the connected → degraded →
 * reconnecting → {connected, failed} state machine. Lives above the
 * transport-level auto-reconnect (which continues to handle the first
 * reconnect attempt), and decides when to escalate to "handle off to
 * watchdog" versus "keep retrying."
 *
 * The state machine is a singleton per server process — process-manager
 * shares it via the exported getFallbackState / onFallbackStateChange API.
 */

import { EventEmitter } from 'node:events';
import {
  FALLBACK_WRITE_BUFFER_PER_HANDLE,
  FALLBACK_WRITE_BUFFER_TOTAL,
  FALLBACK_RECONNECT_BASE_MS,
  FALLBACK_RECONNECT_MAX_ATTEMPTS,
  ERR_DAEMON_UNREACHABLE,
} from './ipc-protocol.mjs';

export const STATE_CONNECTED    = 'connected';
export const STATE_DEGRADED     = 'degraded';
export const STATE_RECONNECTING = 'reconnecting';
export const STATE_FAILED       = 'failed';

const _emitter = new EventEmitter();
_emitter.setMaxListeners(0);

let _state = STATE_CONNECTED;
let _reconnectAttempts = 0;
let _reconnectTimer = null;

// handleId → { chunks: Buffer[], byteLength, pendingResize: {cols,rows}|null }
const _writeBuffers = new Map();
let _totalBufferedBytes = 0;

// clientRequestId → { params } — spawn requests to replay on reconnect
const _pendingSpawns = new Map();

// In-flight non-write requests — rejected with DAEMON_UNREACHABLE on DEGRADED
// id → { reject, method }
const _inflightRequests = new Map();

// GAP β FIX (Phase 4-T1): handleId → agentId registry so the reconnect-time
// drain path in pty-daemon-client.mjs can route buffered writes through
// writeToPty(agentId, data). Populated by spawn-pty-via-daemon.mjs at
// spawn time and cleared on handle exit/kill. Without this, the drain
// path cannot know which agent owns a buffered handle.
const _handleAgentMap = new Map();

export function getFallbackState() {
  return _state;
}

export function onFallbackStateChange(listener) {
  _emitter.on('state', listener);
  return () => _emitter.off('state', listener);
}

function _setState(next, reason) {
  if (_state === next) return;
  const prev = _state;
  _state = next;
  _emitter.emit('state', { prev, next, reason });
}

/**
 * Register an in-flight request so it can be rejected on transition to
 * DEGRADED. `id` is the client-side request id (JSON-RPC id or any handle).
 * GAP γ FIX: `method` parameter (optional) is kept for debug/logging so
 * we can see WHICH non-write request got rejected with DAEMON_UNREACHABLE.
 */
export function registerInflight(id, rejectFn, method) {
  _inflightRequests.set(id, { reject: rejectFn, method: method || null });
}

export function resolveInflight(id) {
  _inflightRequests.delete(id);
}

/**
 * GAP γ FIX: test/debug hook — returns a snapshot of currently-tracked
 * in-flight request ids and their methods.
 */
export function listInflight() {
  return Array.from(_inflightRequests.entries()).map(([id, v]) => ({
    id,
    method: v.method,
  }));
}

// ── GAP β FIX: handle → agent registry ────────────────────────

/**
 * Record that `handleId` belongs to `agentId`. Called by
 * spawn-pty-via-daemon.mjs immediately after a successful spawn so the
 * reconnect drain path can send buffered writes via
 * writeToPty(agentId, data).
 */
export function registerHandleAgent(handleId, agentId) {
  if (!handleId || !agentId) return;
  _handleAgentMap.set(handleId, agentId);
}

export function unregisterHandleAgent(handleId) {
  _handleAgentMap.delete(handleId);
}

export function getHandleAgent(handleId) {
  return _handleAgentMap.get(handleId) || null;
}

/**
 * GAP β FIX: list all handles that currently have buffered data (writes
 * or coalesced resize). Each entry carries the agentId if it was
 * registered via registerHandleAgent. Used by pty-daemon-client.mjs on
 * successful reconnect to drive `drainHandleBuffer` for each.
 */
export function listBufferedHandles() {
  const out = [];
  for (const [handleId, entry] of _writeBuffers) {
    if (entry.chunks.length === 0 && !entry.pendingResize) continue;
    out.push({
      handleId,
      agentId: _handleAgentMap.get(handleId) || null,
      bufferedBytes: entry.byteLength,
      chunkCount: entry.chunks.length,
      hasPendingResize: !!entry.pendingResize,
    });
  }
  return out;
}

/**
 * Transition: CONNECTED → DEGRADED.
 * Called when watchdog miss threshold reached or transport ECONNRESET / EOF.
 * Rejects all in-flight non-write requests per spec §2.2 B5.
 */
export function enterDegraded(reason) {
  if (_state !== STATE_CONNECTED && _state !== STATE_RECONNECTING) {
    // already degraded or failed — ignore
    return;
  }
  _setState(STATE_DEGRADED, reason || 'watchdog_miss');

  for (const [id, entry] of _inflightRequests) {
    const err = new Error('DAEMON_UNREACHABLE');
    err.code = ERR_DAEMON_UNREACHABLE;
    err.category = 'transport';
    err.retryable = true;
    try { entry.reject(err); } catch {}
  }
  _inflightRequests.clear();
}

/**
 * Buffer a write for a degraded handle. Returns true if buffered, false if
 * the total bound was exceeded (oldest chunk evicted).
 */
export function bufferWrite(handleId, chunk) {
  if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(String(chunk));
  let entry = _writeBuffers.get(handleId);
  if (!entry) {
    entry = { chunks: [], byteLength: 0, pendingResize: null };
    _writeBuffers.set(handleId, entry);
  }

  // First evict oldest from THIS handle until per-handle bound satisfies.
  while (entry.byteLength + chunk.length > FALLBACK_WRITE_BUFFER_PER_HANDLE
      && entry.chunks.length > 0) {
    const old = entry.chunks.shift();
    entry.byteLength -= old.length;
    _totalBufferedBytes -= old.length;
  }

  // Then evict globally (oldest across all handles) to satisfy total bound.
  // We walk handles in insertion order, which gives approximate FIFO.
  while (_totalBufferedBytes + chunk.length > FALLBACK_WRITE_BUFFER_TOTAL) {
    let evicted = false;
    for (const [h, e] of _writeBuffers) {
      if (e.chunks.length === 0) continue;
      const old = e.chunks.shift();
      e.byteLength -= old.length;
      _totalBufferedBytes -= old.length;
      evicted = true;
      if (_totalBufferedBytes + chunk.length <= FALLBACK_WRITE_BUFFER_TOTAL) break;
    }
    if (!evicted) break; // nothing left to evict — chunk itself is too big
  }

  // If the incoming chunk is larger than the total bound, drop it entirely.
  if (chunk.length > FALLBACK_WRITE_BUFFER_TOTAL) {
    return false;
  }

  entry.chunks.push(chunk);
  entry.byteLength += chunk.length;
  _totalBufferedBytes += chunk.length;
  return true;
}

/**
 * Coalesce a resize — only the latest value per handle is kept.
 */
export function bufferResize(handleId, cols, rows) {
  let entry = _writeBuffers.get(handleId);
  if (!entry) {
    entry = { chunks: [], byteLength: 0, pendingResize: null };
    _writeBuffers.set(handleId, entry);
  }
  entry.pendingResize = { cols, rows };
}

/**
 * Drain all buffered writes/resizes for a handle in FIFO order.
 * Caller provides async write/resize callbacks.
 *
 * GAP β FIX: the previous implementation had a latent bug where, on a
 * mid-way write failure, the WHOLE entry was deleted and _totalBufferedBytes
 * was decremented by the full original byteLength — meaning chunks that
 * had NOT been written were silently lost and the accounting was correct
 * only because it assumed full delete. The fix shifts successfully-written
 * chunks off `entry.chunks` as they drain, so a partial drain leaves the
 * remaining chunks buffered with correct accounting for a retry on the
 * next reconnect.
 */
export async function drainHandleBuffer(handleId, { write, resize }) {
  const entry = _writeBuffers.get(handleId);
  if (!entry) return { writes: 0, resized: false, remaining: 0, error: null };

  let writes = 0;
  let drainError = null;
  // Shift-and-write so failures leave the remaining queue intact.
  while (entry.chunks.length > 0) {
    const chunk = entry.chunks[0];
    try {
      await write(chunk);
      entry.chunks.shift();
      entry.byteLength -= chunk.length;
      _totalBufferedBytes -= chunk.length;
      writes++;
    } catch (err) {
      drainError = err;
      break;
    }
  }

  // If everything drained, also drain any coalesced resize, then drop
  // the empty entry. If drain was partial, keep the entry for retry.
  let resized = false;
  if (entry.chunks.length === 0) {
    if (entry.pendingResize && typeof resize === 'function') {
      try {
        await resize(entry.pendingResize.cols, entry.pendingResize.rows);
        resized = true;
        entry.pendingResize = null;
      } catch (err) {
        drainError = drainError || err;
      }
    }
    if (entry.chunks.length === 0 && !entry.pendingResize) {
      _writeBuffers.delete(handleId);
    }
  }

  return {
    writes,
    resized,
    remaining: entry.chunks.length,
    error: drainError,
  };
}

/**
 * GAP β FIX: drain every buffered handle using the provided
 * `writeByAgent(agentId, chunk) => Promise` and
 * `resizeByAgent(agentId, cols, rows) => Promise` callbacks. Returns a
 * summary array so the caller can log per-handle results. If any handle
 * still has remaining chunks after drain, `ok` is false for that entry
 * and the caller should consider re-entering DEGRADED so the state
 * machine can retry on the next reconnect.
 *
 * Handles without a registered agent mapping are reported as
 * `{ok: false, reason: 'no_agent_mapping'}` and their buffer is LEFT
 * INTACT (we cannot route the data anywhere sensible).
 */
export async function drainAllBuffers({ writeByAgent, resizeByAgent }) {
  const buffered = listBufferedHandles();
  const results = [];

  for (const info of buffered) {
    const { handleId, agentId } = info;
    if (!agentId) {
      results.push({
        handleId,
        agentId: null,
        ok: false,
        reason: 'no_agent_mapping',
        writes: 0,
        resized: false,
        remaining: info.chunkCount,
      });
      continue;
    }

    const r = await drainHandleBuffer(handleId, {
      write: (chunk) => writeByAgent(agentId, chunk),
      resize: resizeByAgent
        ? (cols, rows) => resizeByAgent(agentId, cols, rows)
        : undefined,
    });

    results.push({
      handleId,
      agentId,
      ok: r.remaining === 0 && !r.error,
      writes: r.writes,
      resized: r.resized,
      remaining: r.remaining,
      error: r.error ? (r.error.message || String(r.error)) : null,
    });
  }

  return results;
}

/**
 * Remember a spawn request that was in-flight or scheduled while degraded,
 * so it can be re-issued on reconnect using the same clientRequestId
 * (idempotency per §1.1 B6).
 */
export function rememberSpawn(clientRequestId, params) {
  if (!clientRequestId) return;
  _pendingSpawns.set(clientRequestId, { params });
}

export function forgetSpawn(clientRequestId) {
  if (!clientRequestId) return;
  _pendingSpawns.delete(clientRequestId);
}

export function listPendingSpawns() {
  return Array.from(_pendingSpawns.entries()).map(([id, v]) => ({ id, ...v }));
}

/**
 * Backoff schedule per §2.3: 30s, 60s, 120s, 240s, 480s.
 */
export function getReconnectDelay(attempt) {
  // attempt is 1-based
  return FALLBACK_RECONNECT_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
}

/**
 * Schedule the next reconnect attempt. Caller provides the actual attempt
 * function (returning Promise<boolean>). Stops after MAX_ATTEMPTS and
 * transitions to FAILED.
 */
export function scheduleReconnect(attemptFn, onFail) {
  if (_reconnectTimer) return;
  if (_state !== STATE_DEGRADED && _state !== STATE_RECONNECTING) return;

  _reconnectAttempts++;
  if (_reconnectAttempts > FALLBACK_RECONNECT_MAX_ATTEMPTS) {
    _setState(STATE_FAILED, 'max_reconnect_attempts_exhausted');
    _reconnectAttempts = 0;
    if (typeof onFail === 'function') {
      try { onFail(); } catch {}
    }
    return;
  }

  const delay = getReconnectDelay(_reconnectAttempts);
  _setState(STATE_RECONNECTING, `attempt_${_reconnectAttempts}`);

  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    let ok = false;
    try {
      ok = await attemptFn(_reconnectAttempts);
    } catch {
      ok = false;
    }
    if (ok) {
      _reconnectAttempts = 0;
      _setState(STATE_CONNECTED, 'reconnected');
    } else {
      // Stay in RECONNECTING flavor and try again
      scheduleReconnect(attemptFn, onFail);
    }
  }, delay);
}

export function cancelReconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}

/**
 * Return the state machine to CONNECTED (e.g. after a successful explicit
 * reconnect from outside the schedule). Resets counters.
 */
export function markConnected() {
  cancelReconnect();
  _reconnectAttempts = 0;
  _setState(STATE_CONNECTED, 'explicit_connect');
}

/**
 * BUG 2 FIX (Phase 4-T1): Signal the state machine that an out-of-band
 * reconnect attempt is now in progress (e.g. the legacy transport-level
 * _scheduleReconnect in pty-daemon-client.mjs). This is used when the
 * legacy reconnect owns the timing instead of the state machine's own
 * scheduleReconnect. Only valid from DEGRADED or RECONNECTING.
 */
export function markReconnecting(reason) {
  if (_state !== STATE_DEGRADED && _state !== STATE_RECONNECTING) return;
  _setState(STATE_RECONNECTING, reason || 'external_reconnect');
}

/**
 * Reset to initial state. Used by unit tests and during shutdown.
 */
export function resetForTest() {
  cancelReconnect();
  _state = STATE_CONNECTED;
  _reconnectAttempts = 0;
  _writeBuffers.clear();
  _totalBufferedBytes = 0;
  _pendingSpawns.clear();
  _inflightRequests.clear();
  _handleAgentMap.clear();
  _emitter.removeAllListeners('state');
}

// Internal getters for unit tests
export const _test = {
  getTotalBuffered: () => _totalBufferedBytes,
  getWriteBuffer: (h) => _writeBuffers.get(h),
  getAttempts: () => _reconnectAttempts,
  getInflightCount: () => _inflightRequests.size,
  getHandleAgentMap: () => new Map(_handleAgentMap),
};
