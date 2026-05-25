/**
 * pty-daemon-ipc.mjs — IPC Server (JSON-RPC 2.0 over Named Pipe / Unix Socket)
 *
 * Transport:
 *   Windows: Named Pipe \\.\pipe\teammcp-pty-{uid} (dev: \\.\pipe\teammcp-pty-dev-{uid})
 *   macOS/Linux: Unix Socket ~/.teammcp/pty-daemon.sock
 *
 * Protocol: Newline-delimited JSON-RPC 2.0 (v1.1 per ipc-protocol.mjs).
 *
 * NB4 (§1.0.5): the Windows named pipe is created via Node's net.createServer
 * and currently has no SDDL / peer SID validation — both require a native
 * addon. As a pure-Node mitigation, the daemon generates a 32-byte secret at
 * startup (pipe-token.mjs) and requires the client to echo it in the
 * handshake. Missing or mismatched → PEER_REJECTED.
 */

import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tokensEqual } from './pipe-token.mjs';

// ── Fix B: nonce+HMAC handshake challenge (defense-in-depth) ──
//
// On top of the existing pipe-token handshake, clients may optionally
// include a random `nonce` and a `mac = HMAC-SHA256(token, nonce)` in
// their handshake params. The daemon recomputes the MAC using its own
// copy of the pipe token and rejects on mismatch. This prevents a
// PASSIVE observer (who recorded a handshake off the wire but cannot
// read the pipe-token file) from replaying that handshake, because
// the nonce changes per handshake. It does NOT prevent a same-user
// attacker who can call readClientToken() — they can compute a valid
// MAC themselves. Fix B is defense-in-depth for the interim file-based
// NB4 mitigation, NOT a replacement for it. See §1.0.5 Fix B.
//
// Key derivation (consistent with H5 computeIdentityChallengeMac):
//   key  = Buffer.from(tokenHex, 'hex')      // raw 32-byte key
//   data = Buffer.from(nonceHex, 'utf-8')    // 32 ASCII-hex chars
//   mac  = createHmac('sha256', key).update(data).digest('hex')  // 64 hex
//
// Client-side token read MUST be fresh per handshake (no module
// cache) because daemon respawn can rotate the token file — policy
// already documented in §1.0.5.
const FIX_B_NONCE_BYTES = 16;                 // 128-bit nonce
const FIX_B_NONCE_HEX_RE = /^[0-9a-f]{32}$/;  // 32 lowercase hex chars

function computeTokenMac(tokenHex, nonceHex) {
  const key = Buffer.from(tokenHex, 'hex');
  const data = Buffer.from(nonceHex, 'utf-8');
  return createHmac('sha256', key).update(data).digest('hex');
}

function freshHandshakeNonce() {
  return randomBytes(FIX_B_NONCE_BYTES).toString('hex');
}
// H5 identity-challenge helpers live in pty-daemon.mjs. Static import
// would create a circular dependency (pty-daemon.mjs imports
// createIPCServer from this file). We use a lazy dynamic import cached
// on first use — ESM guarantees the module is fully initialized by the
// time the first IPC client request arrives, since createIPCServer
// is called after pty-daemon.mjs's top-level init completes.
let _identityHelpersPromise = null;
async function _loadIdentityHelpers() {
  if (!_identityHelpersPromise) {
    _identityHelpersPromise = import('./pty-daemon.mjs').then((m) => ({
      getDaemonIdentityToken: m.getDaemonIdentityToken,
      computeIdentityChallengeMac: m.computeIdentityChallengeMac,
      freshDaemonNonce: m.freshDaemonNonce,
    }));
  }
  return _identityHelpersPromise;
}
import {
  PROTOCOL_VERSION,
  ERR_PARSE,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_INVALID_PARAMS,
  ERR_INTERNAL,
  ERR_VERSION_MISMATCH,
  ERR_PEER_REJECTED,
  ERR_FLOW_CONTROL_OVERFLOW,
  ERR_AGENT_ALREADY_RUNNING,
  ERR_SPAWN_FAILED,
  ERR_HANDLE_NOT_FOUND,
} from './ipc-protocol.mjs';

const PREFIX = '[pty-ipc]';
const SERVER_VERSION = '1.1.0';

// H5: identity challenge RPC method name. One-shot oracle used by
// daemon-launcher.mjs verifyDaemonIdentity — NOT part of the normal
// pipe-token handshake flow. Runs before handshakeComplete.
const IDENTITY_CHALLENGE_METHOD = 'identity.challenge';
const CLIENT_NONCE_HEX_RE = /^[0-9a-f]{32}$/i;

// Output merge window (ms) — only used for v1.0 pty.output fallback path.
const OUTPUT_MERGE_WINDOW = 50;

// Rate limits (bytes per second, pre-encoding) — applied to v1.0 path only.
// v1.1 enforces end-to-end backpressure via credits.
const RATE_LIMIT_PER_AGENT = 200 * 1024;
const RATE_LIMIT_GLOBAL = 1024 * 1024;

// ── IPC hardening constants (Round 3 High findings) ────────────
// Pre-auth DoS / FD exhaustion / idle-socket hardening. These bounds
// are intentionally well above expected real usage (1-2 concurrent
// clients, a few KB per handshake) so legitimate clients are never
// impacted but a malicious peer cannot drive the daemon into OOM or
// fd exhaustion.
const INPUT_BUFFER_MAX_BYTES = 64 * 1024;   // H1: per-client inputBuffer cap
const MAX_CONNECTIONS = 32;                 // H2: concurrent socket cap
const IDLE_HANDSHAKE_TIMEOUT_MS = 30_000;   // H2: pre-handshake idle timeout

// ── Handshake observability counters (NB4 / Fix C + Round 3) ───
// Module-level stats reset on daemon process start. Exposed via
// getHandshakeStats() for diagnostics / security review evidence.
const HANDSHAKE_RECENT_CAP = 16;
const handshakeStats = {
  accepted: 0,
  rejectedNoToken: 0,           // client sent handshake without pipeToken field
  rejectedBadToken: 0,          // wrong token value
  rejectedBadMac: 0,            // nonce/HMAC challenge failure (Fix B — wired when Fix B lands)
  rejectedMalformed: 0,         // handshake JSON/schema invalid (presence check only; #8 regex conditional on T2)
  rejectedOversizedBuffer: 0,   // #1: pre-auth client sent > INPUT_BUFFER_MAX_BYTES without a newline
  rejectedMaxConn: 0,           // #2: incoming connection refused because server at MAX_CONNECTIONS
  rejectedIdleTimeout: 0,       // #2: socket idle > IDLE_HANDSHAKE_TIMEOUT_MS without completing handshake
  rejectedInGrace: 0,           // #12: bytes arrived on an already-rejected socket during the reject flush window
  rejectedDuplicate: 0,         // #7: second handshake on an already-handshaken connection
  loggedSuppressed: 0,          // #6: [IPC]/[HANDSHAKE] log lines dropped by the per-second rate limiter
  internalErrorsSanitized: 0,   // #11: rpcError exception-payload sanitizer engagement count
  firstFailAt: null,            // ISO timestamp of earliest failure (reset on process start)
  lastFailAt: null,             // ISO timestamp of most recent failure
  recentFailures: [],           // rolling last 16 { ts, reason, peerPid? } entries
};

// #6: console.error rate limiter for [HANDSHAKE] / [IPC] log paths.
// Under a flood of bad handshakes, stderr and log aggregators would
// otherwise drown the signal from the counters themselves. Cap is 10
// log lines per rolling second; further lines increment
// `handshakeStats.loggedSuppressed` and emit one rate-limit-engaged
// notice on transition from OK → suppressing. Counters and
// client.destroy() are NOT rate-limited — only the log output.
const LOG_RATE_LIMIT_PER_SEC = 10;
const _logRateState = {
  windowStart: 0,
  windowCount: 0,
  suppressingNoticeEmitted: false,
};
function _rateLimitedError(...args) {
  const now = Date.now();
  if (now - _logRateState.windowStart >= 1000) {
    _logRateState.windowStart = now;
    _logRateState.windowCount = 0;
    _logRateState.suppressingNoticeEmitted = false;
  }
  if (_logRateState.windowCount < LOG_RATE_LIMIT_PER_SEC) {
    _logRateState.windowCount++;
    try { console.error(...args); } catch { /* ignore */ }
    return;
  }
  // Over cap this window — drop the line, bump suppressed counter.
  handshakeStats.loggedSuppressed++;
  if (!_logRateState.suppressingNoticeEmitted) {
    _logRateState.suppressingNoticeEmitted = true;
    try {
      console.error('[IPC] log rate-limit engaged, suppressing details, see getHandshakeStats()');
    } catch { /* ignore */ }
  }
}

// #11: exception-payload sanitizer. Exceptions bubbling out of request
// handlers carry `err.message` and `err.stack` which may contain
// absolute file paths, variable names, and call-stack internals. We
// must not leak those to a potentially malicious peer — the wire
// response gets a canonical code + static message only, while the
// full error still goes to local logs for ops observability.
function _sanitizeErrorForWire(code, err) {
  handshakeStats.internalErrorsSanitized++;
  try {
    console.error('[IPC] internal error sanitized before wire response:', err && (err.stack || err.message || err));
  } catch { /* ignore */ }
  return rpcError(null, code, 'Internal error (details in server log)', {
    category: 'internal',
    retryable: false,
  });
}

// Test-only helpers for the #6 log rate limiter so unit tests can
// reset the rolling window between cases and inspect state.
export function _resetLogRateLimiterForTest() {
  _logRateState.windowStart = 0;
  _logRateState.windowCount = 0;
  _logRateState.suppressingNoticeEmitted = false;
}
export function _getLogRateLimitState() {
  return {
    windowStart: _logRateState.windowStart,
    windowCount: _logRateState.windowCount,
    suppressingNoticeEmitted: _logRateState.suppressingNoticeEmitted,
    cap: LOG_RATE_LIMIT_PER_SEC,
  };
}

// #11 test helper — returns the wire string a sanitized error would
// produce, without actually throwing / routing an exception through
// the request handler. Used to assert that no err.message / err.stack
// leaks onto the wire.
export function _sanitizeErrorForTest(code, err) {
  return _sanitizeErrorForWire(code, err);
}

// #6 test helper — drive the rate limiter from tests without standing
// up a real server. Mirrors the production call shape exactly.
export function _rateLimitedErrorForTest(...args) {
  _rateLimitedError(...args);
}

// H5 test helper — drive the identity.challenge handler without
// standing up a full IPC server. Mirrors the logic in
// handleIdentityChallenge exactly; if that handler's logic changes,
// keep this in sync. The handler under test reads
// `globalThis._daemonIdentityToken`; tests should set and clear it.
//
// Returns the wire string (JSON-RPC envelope) the handler would have
// sent on the socket. Tests parse it and assert on fields.
export async function _handleIdentityChallengeForTest(params, id = 1) {
  let captured = null;
  const fakeClient = {
    id: 0,
    send(data) { captured = data; },
    socket: { writable: true, destroyed: false, destroy() {}, pause() {}, end() {} },
  };
  // Inline copy of the handler body so tests do not need a live
  // createIPCServer closure. Any behavioural drift between this and
  // the production handler is a test bug.
  const helpers = await _loadIdentityHelpers();
  let token;
  try {
    token = helpers.getDaemonIdentityToken();
  } catch {
    fakeClient.send(rpcError(id, ERR_INTERNAL, 'Internal error (details in server log)', { category: 'internal', retryable: false }));
    return captured;
  }
  if (!token) {
    fakeClient.send(rpcError(id, ERR_METHOD_NOT_FOUND, 'Method not found: identity.challenge', { category: 'protocol', retryable: false }));
    return captured;
  }
  const clientNonce = params && params.clientNonce;
  if (typeof clientNonce !== 'string' || !CLIENT_NONCE_HEX_RE.test(clientNonce)) {
    handshakeStats.rejectedMalformed++;
    _recordHandshakeFailure('identity-challenge-bad-nonce');
    fakeClient.send(rpcError(id, ERR_PEER_REJECTED, 'Invalid clientNonce (expected 32 hex chars)', { category: 'protocol', retryable: false }));
    return captured;
  }
  let daemonNonce;
  let mac;
  try {
    daemonNonce = helpers.freshDaemonNonce();
    mac = helpers.computeIdentityChallengeMac(clientNonce, daemonNonce);
  } catch {
    fakeClient.send(rpcError(id, ERR_INTERNAL, 'Internal error (details in server log)', { category: 'internal', retryable: false }));
    return captured;
  }
  if (typeof mac !== 'string' || mac.length !== 64) {
    fakeClient.send(rpcError(id, ERR_METHOD_NOT_FOUND, 'Method not found: identity.challenge', { category: 'protocol', retryable: false }));
    return captured;
  }
  fakeClient.send(rpcResult(id, { daemonNonce, mac }));
  return captured;
}

function _recordHandshakeFailure(reason, peerPid) {
  const ts = new Date().toISOString();
  if (handshakeStats.firstFailAt === null) handshakeStats.firstFailAt = ts;
  handshakeStats.lastFailAt = ts;
  const entry = { ts, reason };
  if (peerPid !== undefined) entry.peerPid = peerPid;
  handshakeStats.recentFailures.push(entry);
  while (handshakeStats.recentFailures.length > HANDSHAKE_RECENT_CAP) {
    handshakeStats.recentFailures.shift();
  }
}

export function getHandshakeStats() {
  return {
    accepted: handshakeStats.accepted,
    rejectedNoToken: handshakeStats.rejectedNoToken,
    rejectedBadToken: handshakeStats.rejectedBadToken,
    rejectedBadMac: handshakeStats.rejectedBadMac,
    rejectedMalformed: handshakeStats.rejectedMalformed,
    rejectedOversizedBuffer: handshakeStats.rejectedOversizedBuffer,
    rejectedMaxConn: handshakeStats.rejectedMaxConn,
    rejectedIdleTimeout: handshakeStats.rejectedIdleTimeout,
    rejectedInGrace: handshakeStats.rejectedInGrace,
    rejectedDuplicate: handshakeStats.rejectedDuplicate,
    loggedSuppressed: handshakeStats.loggedSuppressed,
    internalErrorsSanitized: handshakeStats.internalErrorsSanitized,
    firstFailAt: handshakeStats.firstFailAt,
    lastFailAt: handshakeStats.lastFailAt,
    recentFailures: [...handshakeStats.recentFailures],
  };
}

// Test-only reset helper. Not exported on the public IPC surface; used by
// unit tests to isolate counter assertions between cases.
export function _resetHandshakeStatsForTest() {
  handshakeStats.accepted = 0;
  handshakeStats.rejectedNoToken = 0;
  handshakeStats.rejectedBadToken = 0;
  handshakeStats.rejectedBadMac = 0;
  handshakeStats.rejectedMalformed = 0;
  handshakeStats.rejectedOversizedBuffer = 0;
  handshakeStats.rejectedMaxConn = 0;
  handshakeStats.rejectedIdleTimeout = 0;
  handshakeStats.rejectedInGrace = 0;
  handshakeStats.rejectedDuplicate = 0;
  handshakeStats.loggedSuppressed = 0;
  handshakeStats.internalErrorsSanitized = 0;
  handshakeStats.firstFailAt = null;
  handshakeStats.lastFailAt = null;
  handshakeStats.recentFailures.length = 0;
}

// Test-only simulators so unit tests can exercise the counter paths without
// standing up a full named-pipe server. They mirror the logic at the real
// rejection sites exactly — if those change, keep these in sync.
export function _simulateHandshakeRejectionForTest(reason, peerPid) {
  // Map human-friendly reason aliases to the canonical field names used
  // at the real rejection sites. Tests may pass either the field name
  // or the short reason label.
  const reasonToField = {
    rejectedNoToken: 'rejectedNoToken',
    rejectedBadToken: 'rejectedBadToken',
    rejectedBadMac: 'rejectedBadMac',
    rejectedMalformed: 'rejectedMalformed',
    'malformed-version': 'rejectedMalformed',
    rejectedOversizedBuffer: 'rejectedOversizedBuffer',
    'oversized-buffer': 'rejectedOversizedBuffer',
    rejectedMaxConn: 'rejectedMaxConn',
    'max-connections': 'rejectedMaxConn',
    rejectedIdleTimeout: 'rejectedIdleTimeout',
    'idle-timeout': 'rejectedIdleTimeout',
    rejectedInGrace: 'rejectedInGrace',
    'in-grace': 'rejectedInGrace',
    rejectedDuplicate: 'rejectedDuplicate',
    'duplicate-handshake': 'rejectedDuplicate',
  };
  const field = reasonToField[reason];
  if (!field) throw new Error(`unknown handshake rejection reason: ${reason}`);
  handshakeStats[field]++;
  _recordHandshakeFailure(reason, peerPid);
}

export function _simulateHandshakeAcceptForTest() {
  handshakeStats.accepted++;
}

// Fix B test helpers — exported so unit tests can drive the MAC
// verification path without standing up a live named-pipe server.
// `_simulateFixBHandshakeForTest` mirrors the production
// handleHandshake Fix B branch exactly (post token-check). If that
// branch's logic changes, keep this in sync.
//
// Inputs:
//   daemonToken: hex string representing the daemon's pipeToken
//   params: { nonce?, mac? } — what the client sent
// Returns: { outcome: 'accepted'|'rejected', reason?, stats: <getHandshakeStats snapshot> }
export function _simulateFixBHandshakeForTest(daemonToken, params) {
  const hasNonce = params && params.nonce !== undefined && params.nonce !== null;
  const hasMac = params && params.mac !== undefined && params.mac !== null;
  if (hasNonce !== hasMac) {
    handshakeStats.rejectedMalformed++;
    _recordHandshakeFailure('fix-b-partial-challenge');
    return { outcome: 'rejected', reason: 'fix-b-partial-challenge' };
  }
  if (!hasNonce && !hasMac) {
    // Legacy compat — accept with no MAC check.
    handshakeStats.accepted++;
    return { outcome: 'accepted', reason: 'legacy-no-challenge' };
  }
  const providedNonce = params.nonce;
  const providedMac = params.mac;
  if (typeof providedNonce !== 'string' || !FIX_B_NONCE_HEX_RE.test(providedNonce)) {
    handshakeStats.rejectedMalformed++;
    _recordHandshakeFailure('fix-b-bad-nonce');
    return { outcome: 'rejected', reason: 'fix-b-bad-nonce' };
  }
  if (typeof providedMac !== 'string' || providedMac.length !== 64) {
    handshakeStats.rejectedMalformed++;
    _recordHandshakeFailure('fix-b-bad-mac-format');
    return { outcome: 'rejected', reason: 'fix-b-bad-mac-format' };
  }
  const expectedMac = computeTokenMac(daemonToken, providedNonce);
  if (!tokensEqual(expectedMac, providedMac)) {
    handshakeStats.rejectedBadMac++;
    _recordHandshakeFailure('fix-b-bad-mac');
    return { outcome: 'rejected', reason: 'fix-b-bad-mac' };
  }
  handshakeStats.accepted++;
  return { outcome: 'accepted', reason: 'fix-b-mac-verified' };
}

// Expose the pure helpers for test-vector assertions (formula
// confirmation: hex-decoded 32-byte key, UTF-8 nonce data, SHA-256).
export function _computeTokenMacForTest(tokenHex, nonceHex) {
  return computeTokenMac(tokenHex, nonceHex);
}

export function _freshHandshakeNonceForTest() {
  return freshHandshakeNonce();
}

function log(...args) {
  console.log(PREFIX, new Date().toISOString(), ...args);
}

function logError(...args) {
  console.error(PREFIX, new Date().toISOString(), ...args);
}

// ── JSON-RPC helpers ───────────────────────────────────────────

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', result, id });
}

function rpcError(id, code, message, extra) {
  const err = { code, message };
  if (extra && extra.category) err.category = extra.category;
  if (extra && typeof extra.retryable === 'boolean') err.retryable = extra.retryable;
  if (extra && extra.data !== undefined) err.data = extra.data;
  return JSON.stringify({ jsonrpc: '2.0', error: err, id });
}

function rpcNotification(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

// F12: reject-and-close helper. Replaces the previous pattern
// `client.send(rpcError(...)); setTimeout(() => client.destroy(), 100);`
// which left a 100 ms grace window during which (a) Fix C counters
// could double-count and (b) an attacker could retry. Instead we
//   1. mark the client rejected so any in-flight bytes are dropped
//      into `rejectedInGrace`,
//   2. call `socket.end()` for a graceful half-close that flushes the
//      pending error write but refuses further reads,
//   3. install a backstop `destroy()` after 100 ms in case `end()`
//      never completes (peer not reading).
function _rejectAndClose(client) {
  if (client.rejected) return;
  client.rejected = true;
  client.clearIdleTimer();
  try {
    if (typeof client.socket.pause === 'function') client.socket.pause();
  } catch { /* ignore */ }
  try {
    if (typeof client.socket.end === 'function' && !client.socket.destroyed) {
      client.socket.end();
    }
  } catch { /* ignore */ }
  // Backstop — if the peer never reads the FIN, force-destroy after 100 ms.
  setTimeout(() => {
    try { client.destroy(); } catch { /* ignore */ }
  }, 100);
}

// ── Rate limiter (v1.0 only) ───────────────────────────────────

class RateLimiter {
  constructor() {
    this.agentBuckets = new Map();
    this.globalBytes = 0;
    this.globalLastReset = Date.now();
  }

  canSend(agent, bytes) {
    const now = Date.now();
    if (now - this.globalLastReset >= 1000) {
      this.globalBytes = 0;
      this.globalLastReset = now;
    }
    let bucket = this.agentBuckets.get(agent);
    if (!bucket || now - bucket.lastReset >= 1000) {
      bucket = { bytes: 0, lastReset: now };
      this.agentBuckets.set(agent, bucket);
    }
    if (bucket.bytes + bytes > RATE_LIMIT_PER_AGENT) return false;
    if (this.globalBytes + bytes > RATE_LIMIT_GLOBAL) return false;
    bucket.bytes += bytes;
    this.globalBytes += bytes;
    return true;
  }
}

// ── Client connection state ────────────────────────────────────

class ClientConnection {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.handshakeComplete = false;
    this.negotiatedVersion = null;  // '1.0' or '1.1'
    this.subscribedAgents = new Set();
    this.subscribedAll = false;
    this.inputBuffer = '';
    // F12: once rejected, any further bytes are counted as `rejectedInGrace`
    // and dropped. Prevents both double-count on our side and a grace-window
    // retry on the attacker side.
    this.rejected = false;
    // H2: per-connection idle-handshake timer. Cleared on successful
    // handshake or on reject/close.
    this.idleTimer = null;
  }

  get isV11() {
    return this.negotiatedVersion === '1.1';
  }

  send(data) {
    if (this.socket.writable) {
      this.socket.write(data + '\n');
    }
  }

  isSubscribed(agent) {
    return this.subscribedAll || this.subscribedAgents.has(agent);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  destroy() {
    this.clearIdleTimer();
    this.subscribedAgents.clear();
    this.subscribedAll = false;
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

// ── IPC Server ─────────────────────────────────────────────────

export async function createIPCServer(options) {
  const {
    isDev,
    uid,
    isWindows,
    configDir,
    pipeToken,
    ptyOps,
    setOutputHandler,
    setDataHandler,
    setExitHandler
  } = options;

  let ipcPath;
  if (isWindows) {
    const pipeName = isDev ? `teammcp-pty-dev-${uid}` : `teammcp-pty-${uid}`;
    ipcPath = `\\\\.\\pipe\\${pipeName}`;
  } else {
    ipcPath = join(configDir, 'pty-daemon.sock');
    if (existsSync(ipcPath)) {
      try { unlinkSync(ipcPath); } catch {}
    }
  }

  const clients = new Map();
  let clientIdCounter = 0;
  const rateLimiter = new RateLimiter();

  // ── v1.0 output merge buffers ──────────────────────────────

  const mergeBuffers = new Map();

  function flushMergeBuffer(agent) {
    const mb = mergeBuffers.get(agent);
    if (!mb || mb.chunks.length === 0) return;

    const merged = Buffer.concat(mb.chunks);
    const rawBytes = mb.rawBytes;
    mb.chunks = [];
    mb.rawBytes = 0;

    if (!rateLimiter.canSend(agent, rawBytes)) return;

    const b64 = merged.toString('base64');
    const notification = rpcNotification('pty.output', {
      agent,
      data: b64,
      encoding: 'base64',
    });

    for (const client of clients.values()) {
      if (client.handshakeComplete && !client.isV11 && client.isSubscribed(agent)) {
        client.send(notification);
      }
    }
  }

  // v1.0 path: pty.output with merge window
  if (typeof setOutputHandler === 'function') {
    setOutputHandler((agent, data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

      let mb = mergeBuffers.get(agent);
      if (!mb) {
        mb = { chunks: [], timer: null, rawBytes: 0 };
        mergeBuffers.set(agent, mb);
      }

      mb.chunks.push(buf);
      mb.rawBytes += buf.length;

      if (mb.timer) clearTimeout(mb.timer);
      mb.timer = setTimeout(() => {
        mb.timer = null;
        flushMergeBuffer(agent);
      }, OUTPUT_MERGE_WINDOW);
    });
  }

  // v1.1 path: pty.data per chunk, no merge window (credit-gated).
  if (typeof setDataHandler === 'function') {
    setDataHandler((agent, payload) => {
      const notification = rpcNotification('pty.data', payload);
      for (const client of clients.values()) {
        if (client.handshakeComplete && client.isV11 && client.isSubscribed(agent)) {
          client.send(notification);
        }
      }
    });
  }

  // Wire exit handler — both v1.0 and v1.1 clients receive pty.exit.
  if (typeof setExitHandler === 'function') {
    setExitHandler((agent, exitEvent) => {
      let delivered = false;
      const notification = JSON.stringify(exitEvent);

      if (mergeBuffers.has(agent)) {
        const mb = mergeBuffers.get(agent);
        if (mb.timer) clearTimeout(mb.timer);
        flushMergeBuffer(agent);
        mergeBuffers.delete(agent);
      }

      for (const client of clients.values()) {
        if (client.handshakeComplete && client.isSubscribed(agent)) {
          client.send(notification);
          delivered = true;
        }
      }
      return delivered;
    });
  }

  // ── Request handler ────────────────────────────────────────

  function handleRequest(client, msg) {
    let parsed;
    try {
      parsed = JSON.parse(msg);
    } catch {
      client.send(rpcError(null, ERR_PARSE, 'Parse error', { category: 'protocol', retryable: false }));
      return;
    }

    if (parsed.jsonrpc !== '2.0') {
      client.send(rpcError(parsed.id ?? null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC version', { category: 'protocol', retryable: false }));
      return;
    }

    const { method, params, id } = parsed;

    // H5 / Round 5 Addition 1a: pre-handshake method gate — WHITELIST,
    // not deny-list. Only `handshake` (the method that completes the
    // pipe-token handshake) and `identity.challenge` (the parallel H5
    // auth flow used by daemon-launcher.mjs:verifyDaemonIdentity) are
    // allowed on a pre-handshake connection. Every other method is
    // rejected with ERR_PEER_REJECTED — do not add new methods to
    // this whitelist without a security review.
    //
    // Pre-auth DoS inheritance: identity.challenge connections are
    // still bounded by Round 3 FINAL #1 INPUT_BUFFER_MAX_BYTES=64KB,
    // #2 MAX_CONNECTIONS=32 + 30s idle timeout, and #6 rate-limited
    // error logs. No identity.challenge-specific rate limit needed.
    if (!client.handshakeComplete) {
      if (method === 'handshake') {
        // fall through to dispatch
      } else if (method === IDENTITY_CHALLENGE_METHOD) {
        // fall through to dispatch
      } else {
        client.send(rpcError(id ?? null, ERR_PEER_REJECTED, 'Handshake required', { category: 'protocol', retryable: false }));
        return;
      }
    }

    try {
      switch (method) {
        case 'handshake':
          return handleHandshake(client, params, id);
        case IDENTITY_CHALLENGE_METHOD:
          return handleIdentityChallenge(client, params, id);
        case 'pty.spawn':
          return handlePtySpawn(client, params, id);
        case 'pty.kill':
          return handlePtyKill(client, params, id);
        case 'pty.resize':
          return handlePtyResize(client, params, id);
        case 'pty.write':
          return handlePtyWrite(client, params, id);
        case 'pty.list':
          return handlePtyList(client, params, id);
        case 'pty.status':
          return handlePtyStatus(client, params, id);
        case 'pty.scrollback':
          return handlePtyScrollback(client, params, id);
        case 'pty.subscribe':
          return handlePtySubscribe(client, params, id);
        case 'pty.subscribe_all':
          return handlePtySubscribeAll(client, id);
        case 'pty.unsubscribe':
          return handlePtyUnsubscribe(client, params, id);
        case 'pty.ack':
          // Notification, no response even on error (except FLOW_CONTROL_OVERFLOW).
          return handlePtyAck(client, params, id);
        case 'pty.reattach':
          return handlePtyReattach(client, params, id);
        case 'watchdog.ping':
          return handleWatchdogPing(client, params, id);
        case 'watchdog.pong':
          // Daemon→client pings may get pong back from client; no-op here.
          return;
        case 'ping':
          return handlePing(client, id);
        default:
          client.send(rpcError(id ?? null, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`, { category: 'protocol', retryable: false }));
      }
    } catch (err) {
      // #11: exception-payload sanitizer. Full error goes to local log
      // for ops observability, wire response carries code + static
      // message only — no err.message, no err.stack, no internal
      // paths or variable names leak to the peer.
      logError(`Error handling method "${method}":`, err && (err.stack || err.message));
      if (id !== undefined && id !== null) {
        handshakeStats.internalErrorsSanitized++;
        client.send(rpcError(id, ERR_INTERNAL, 'Internal error (details in server log)', { category: 'internal', retryable: false }));
      }
    }
  }

  function handleHandshake(client, params, id) {
    // F7: reject a second handshake on a connection that has already
    // completed one. Prevents mixed v1.0/v1.1 state from a downgrade
    // attempt or a confused client.
    if (client.handshakeComplete) {
      handshakeStats.rejectedDuplicate++;
      _recordHandshakeFailure('duplicate-handshake');
      _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedDuplicate=%d',
        'duplicate-handshake', handshakeStats.rejectedDuplicate);
      logError(`Client #${client.id} rejected: duplicate handshake`);
      client.send(rpcError(id, ERR_PEER_REJECTED, 'Handshake already completed on this connection', { category: 'protocol', retryable: false }));
      _rejectAndClose(client);
      return;
    }

    // #8 (Round 3 FINAL — un-SKIP'd after C subagent 2 confirmed v1.1
    // runtime-wiring at pty-daemon-ipc.mjs:266/:299): regex-validate
    // protocol_version shape. Must be "N.M" where both components are
    // non-negative integers in a plausible range. Rejects "1", "1.x",
    // "", NaN, negative, absurdly large, and any non-string input
    // after coercion. Reuses the existing `rejectedMalformed` counter
    // — no new counter for this item.
    if (!params || typeof params.protocol_version !== 'string' ||
        !/^\d+\.\d+$/.test(params.protocol_version)) {
      handshakeStats.rejectedMalformed++;
      _recordHandshakeFailure('malformed-version');
      _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedMalformed=%d',
        'malformed-version', handshakeStats.rejectedMalformed);
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing or malformed protocol_version (expected "N.M")', { category: 'protocol', retryable: false }));
      _rejectAndClose(client);
      return;
    }

    // #8 continued: parse + range-check both components.
    const _versionParts = params.protocol_version.split('.');
    const _clientMajorNum = parseInt(_versionParts[0], 10);
    const _clientMinorNum = parseInt(_versionParts[1], 10);
    if (!Number.isFinite(_clientMajorNum) || !Number.isFinite(_clientMinorNum) ||
        _clientMajorNum < 0 || _clientMajorNum > 99 ||
        _clientMinorNum < 0 || _clientMinorNum > 99) {
      handshakeStats.rejectedMalformed++;
      _recordHandshakeFailure('malformed-version');
      _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedMalformed=%d',
        'malformed-version', handshakeStats.rejectedMalformed);
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'protocol_version out of range', { category: 'protocol', retryable: false }));
      _rejectAndClose(client);
      return;
    }

    // NB4: pipe token check. Missing/mismatched → PEER_REJECTED.
    if (pipeToken) {
      const supplied = params.token;
      if (!supplied || !tokensEqual(supplied, pipeToken)) {
        // NB4 / Fix C: instrument rejection path for security-review observability.
        const reason = !supplied ? 'rejectedNoToken' : 'rejectedBadToken';
        if (reason === 'rejectedNoToken') handshakeStats.rejectedNoToken++;
        else handshakeStats.rejectedBadToken++;
        _recordHandshakeFailure(reason);
        _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedNoToken=%d totalRejectedBadToken=%d',
          reason, handshakeStats.rejectedNoToken, handshakeStats.rejectedBadToken);
        logError(`Client #${client.id} rejected: missing/invalid pipe token`);
        client.send(rpcError(id, ERR_PEER_REJECTED, 'Pipe token missing or invalid', { category: 'protocol', retryable: false }));
        _rejectAndClose(client);
        return;
      }

      // Fix B: optional nonce+HMAC challenge. Both fields must be
      // present together or absent together. Legacy clients (no
      // nonce, no mac) are still accepted — Fix B is defense-in-depth,
      // not mandatory. See §1.0.5 Fix B framing.
      const hasNonce = params.nonce !== undefined && params.nonce !== null;
      const hasMac = params.mac !== undefined && params.mac !== null;
      if (hasNonce !== hasMac) {
        handshakeStats.rejectedMalformed++;
        _recordHandshakeFailure('fix-b-partial-challenge');
        _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedMalformed=%d',
          'fix-b-partial-challenge', handshakeStats.rejectedMalformed);
        logError(`Client #${client.id} rejected: Fix B partial challenge (nonce/mac must both be present or both absent)`);
        client.send(rpcError(id, ERR_INVALID_PARAMS, 'Fix B handshake: nonce and mac must both be provided', { category: 'protocol', retryable: false }));
        _rejectAndClose(client);
        return;
      }
      if (hasNonce && hasMac) {
        const providedNonce = params.nonce;
        const providedMac = params.mac;
        if (typeof providedNonce !== 'string' || !FIX_B_NONCE_HEX_RE.test(providedNonce)) {
          handshakeStats.rejectedMalformed++;
          _recordHandshakeFailure('fix-b-bad-nonce');
          _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedMalformed=%d',
            'fix-b-bad-nonce', handshakeStats.rejectedMalformed);
          logError(`Client #${client.id} rejected: Fix B invalid nonce format`);
          client.send(rpcError(id, ERR_INVALID_PARAMS, 'Fix B nonce invalid (expected 32 lowercase hex chars)', { category: 'protocol', retryable: false }));
          _rejectAndClose(client);
          return;
        }
        if (typeof providedMac !== 'string' || providedMac.length !== 64) {
          handshakeStats.rejectedMalformed++;
          _recordHandshakeFailure('fix-b-bad-mac-format');
          _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedMalformed=%d',
            'fix-b-bad-mac-format', handshakeStats.rejectedMalformed);
          logError(`Client #${client.id} rejected: Fix B invalid mac format`);
          client.send(rpcError(id, ERR_INVALID_PARAMS, 'Fix B mac invalid (expected 64 hex chars)', { category: 'protocol', retryable: false }));
          _rejectAndClose(client);
          return;
        }
        let expectedMac;
        try {
          expectedMac = computeTokenMac(pipeToken, providedNonce);
        } catch (err) {
          logError(`Client #${client.id} rejected: Fix B MAC computation error:`, err && (err.message || err));
          handshakeStats.rejectedBadMac++;
          _recordHandshakeFailure('fix-b-mac-compute-error');
          client.send(rpcError(id, ERR_PEER_REJECTED, 'Fix B MAC verification failed', { category: 'protocol', retryable: false }));
          _rejectAndClose(client);
          return;
        }
        if (!tokensEqual(expectedMac, providedMac)) {
          handshakeStats.rejectedBadMac++;
          _recordHandshakeFailure('fix-b-bad-mac');
          _rateLimitedError('[HANDSHAKE] rejected reason=%s totalRejectedBadMac=%d',
            'fix-b-bad-mac', handshakeStats.rejectedBadMac);
          logError(`Client #${client.id} rejected: Fix B MAC mismatch`);
          client.send(rpcError(id, ERR_PEER_REJECTED, 'Fix B MAC verification failed', { category: 'protocol', retryable: false }));
          _rejectAndClose(client);
          return;
        }
        // MAC verified. Fall through to version negotiation.
      }
    }

    const clientMajor = String(params.protocol_version).split('.')[0];
    const serverMajor = PROTOCOL_VERSION.split('.')[0];
    if (clientMajor !== serverMajor) {
      client.send(rpcError(id, ERR_VERSION_MISMATCH, `Version mismatch: client=${params.protocol_version} server=${PROTOCOL_VERSION}`, { category: 'protocol', retryable: false }));
      _rejectAndClose(client);
      return;
    }

    // Negotiate min(client, server). Both are '1.x' since we just matched major.
    const clientMinor = parseInt(String(params.protocol_version).split('.')[1] || '0', 10);
    const serverMinor = parseInt(PROTOCOL_VERSION.split('.')[1] || '0', 10);
    const negMinor = Math.min(clientMinor, serverMinor);
    const negotiatedVersion = `${serverMajor}.${negMinor}`;
    client.negotiatedVersion = negotiatedVersion;
    client.handshakeComplete = true;
    // H2: stop the idle-handshake timer — client is now authenticated.
    client.clearIdleTimer();
    // NB4 / Fix C: successful handshake counter.
    handshakeStats.accepted++;

    const stats = ptyOps.daemonStats();

    client.send(rpcResult(id, {
      // v1.0 historical fields preserved on wire
      protocol_version: PROTOCOL_VERSION,
      server: 'pty-daemon',
      server_version: SERVER_VERSION,
      compatible: true,
      agents_running: stats.agents,
      // v1.1 additions (camelCase)
      negotiatedVersion,
      supportedFeatures: negMinor >= 1
        ? ['pty.data', 'pty.ack', 'pty.reattach', 'watchdog']
        : [],
    }));

    log(`Client #${client.id} handshake complete (negotiated=${negotiatedVersion}, client=${params.client || params.clientId || 'unknown'})`);
  }

  // H5: one-shot identity-challenge oracle. Called by
  // daemon-launcher.mjs:verifyDaemonIdentity to confirm the peer it
  // just connected to actually holds the identity token handed to
  // the daemon via stdin at spawn time. Rejects impersonation races
  // where an attacker opened the named pipe between launcher spawn
  // and launcher connect.
  //
  // Pre-handshake: yes — this method bypasses the handshakeComplete
  // gate. It is its own auth flow, parallel to the pipe-token
  // handshake. A successful response does NOT mark the client as
  // authenticated; the launcher closes the socket immediately
  // after reading the response, and any PTY RPC over this
  // connection still requires a normal `handshake` call first.
  //
  // Legacy compat: if the daemon was started without an identity
  // token (legacy launcher), `getDaemonIdentityToken()` returns null
  // and we respond with -32601 Method not found. The launcher's
  // soft-fail path ("legacy daemon, proceed without verification")
  // triggers on exactly that error.
  //
  // Counter: no new field. Malformed `clientNonce` reuses
  // `rejectedMalformed`. Successful challenge does NOT increment
  // `accepted` — the connection is a one-shot oracle, not an
  // authenticated client.
  function handleIdentityChallenge(client, params, id) {
    _loadIdentityHelpers().then((helpers) => {
      let token;
      try {
        token = helpers.getDaemonIdentityToken();
      } catch (err) {
        logError('[IDENTITY] getDaemonIdentityToken threw:', err && (err.message || err));
        client.send(rpcError(id, ERR_INTERNAL, 'Internal error (details in server log)', { category: 'internal', retryable: false }));
        return;
      }

      if (!token) {
        // Legacy launcher path — daemon started without stdin token.
        // Respond with -32601 so launcher soft-fails to "no
        // verification, proceed" mode.
        client.send(rpcError(id, ERR_METHOD_NOT_FOUND, 'Method not found: identity.challenge', { category: 'protocol', retryable: false }));
        return;
      }

      const clientNonce = params && params.clientNonce;
      if (typeof clientNonce !== 'string' || !CLIENT_NONCE_HEX_RE.test(clientNonce)) {
        handshakeStats.rejectedMalformed++;
        _recordHandshakeFailure('identity-challenge-bad-nonce');
        _rateLimitedError('[IDENTITY] rejected reason=%s totalRejectedMalformed=%d',
          'identity-challenge-bad-nonce', handshakeStats.rejectedMalformed);
        client.send(rpcError(id, ERR_PEER_REJECTED, 'Invalid clientNonce (expected 32 hex chars)', { category: 'protocol', retryable: false }));
        return;
      }

      let daemonNonce;
      let mac;
      try {
        daemonNonce = helpers.freshDaemonNonce();
        mac = helpers.computeIdentityChallengeMac(clientNonce, daemonNonce);
      } catch (err) {
        logError('[IDENTITY] helper threw:', err && (err.message || err));
        client.send(rpcError(id, ERR_INTERNAL, 'Internal error (details in server log)', { category: 'internal', retryable: false }));
        return;
      }

      if (typeof mac !== 'string' || mac.length !== 64) {
        // Token was present at the null-check above but the helper
        // refused it (schema drift or token rotated out under us).
        // Treat same as legacy — -32601 so launcher soft-fails.
        client.send(rpcError(id, ERR_METHOD_NOT_FOUND, 'Method not found: identity.challenge', { category: 'protocol', retryable: false }));
        return;
      }

      client.send(rpcResult(id, { daemonNonce, mac }));
    }).catch((err) => {
      logError('[IDENTITY] _loadIdentityHelpers failed:', err && (err.message || err));
      try {
        client.send(rpcError(id, ERR_INTERNAL, 'Internal error (details in server log)', { category: 'internal', retryable: false }));
      } catch { /* ignore */ }
    });
  }

  function handlePtySpawn(client, params, id) {
    if (!params || !params.agent || !params.cmd) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing required params: agent, cmd', { category: 'protocol', retryable: false }));
      return;
    }
    try {
      const result = ptyOps.spawn(
        params.agent,
        params.cmd,
        params.args || [],
        {
          cwd: params.cwd,
          env: params.env,
          cols: params.cols,
          rows: params.rows,
          clientRequestId: params.clientRequestId,
        }
      );
      client.send(rpcResult(id, result));
    } catch (err) {
      const code = err.code === 'AGENT_ALREADY_RUNNING'
        ? ERR_AGENT_ALREADY_RUNNING
        : ERR_SPAWN_FAILED;
      client.send(rpcError(id, code, err.message, { category: 'pty', retryable: false }));
    }
  }

  function handlePtyKill(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing required param: agent', { category: 'protocol', retryable: false }));
      return;
    }
    try {
      const result = ptyOps.kill(params.agent, params.signal, params.reason);
      client.send(rpcResult(id, result));
    } catch (err) {
      client.send(rpcError(id, ERR_HANDLE_NOT_FOUND, err.message, { category: 'pty', retryable: false }));
    }
  }

  function handlePtyResize(client, params, id) {
    if (!params || !params.agent || !params.cols || !params.rows) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing required params: agent, cols, rows', { category: 'protocol', retryable: false }));
      return;
    }
    try {
      const result = ptyOps.resize(params.agent, params.cols, params.rows);
      client.send(rpcResult(id, result));
    } catch (err) {
      client.send(rpcError(id, ERR_HANDLE_NOT_FOUND, err.message, { category: 'pty', retryable: false }));
    }
  }

  function handlePtyWrite(client, params, id) {
    if (!params || !params.agent || params.data === undefined) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing required params: agent, data', { category: 'protocol', retryable: false }));
      return;
    }
    try {
      const result = ptyOps.write(params.agent, params.data);
      client.send(rpcResult(id, result));
    } catch (err) {
      client.send(rpcError(id, ERR_HANDLE_NOT_FOUND, err.message, { category: 'pty', retryable: false }));
    }
  }

  function handlePtyList(client, params, id) {
    const result = ptyOps.list(params || {});
    client.send(rpcResult(id, result));
  }

  function handlePtyStatus(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing required param: agent', { category: 'protocol', retryable: false }));
      return;
    }
    try {
      const result = ptyOps.status(params.agent);
      client.send(rpcResult(id, result));
    } catch (err) {
      client.send(rpcError(id, ERR_HANDLE_NOT_FOUND, err.message, { category: 'pty', retryable: false }));
    }
  }

  function handlePtyScrollback(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing required param: agent', { category: 'protocol', retryable: false }));
      return;
    }
    try {
      const result = ptyOps.scrollback(params.agent);
      client.send(rpcResult(id, result));
    } catch (err) {
      client.send(rpcError(id, ERR_HANDLE_NOT_FOUND, err.message, { category: 'pty', retryable: false }));
    }
  }

  function handlePtySubscribe(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing required param: agent', { category: 'protocol', retryable: false }));
      return;
    }
    client.subscribedAgents.add(params.agent);
    client.send(rpcResult(id, { subscribed: true }));
    log(`Client #${client.id} subscribed to "${params.agent}"`);
  }

  function handlePtySubscribeAll(client, id) {
    client.subscribedAll = true;

    const { events, summary } = ptyOps.drainEventBuffer();
    if (events.length > 0) {
      log(`Replaying ${events.length} buffered events to client #${client.id}`);
      for (const event of events) {
        client.send(JSON.stringify(event));
      }
    }
    if (summary) client.send(JSON.stringify(summary));

    client.send(rpcResult(id, { subscribed: true }));
    log(`Client #${client.id} subscribed to all agents (replayed ${events.length})`);
  }

  function handlePtyUnsubscribe(client, params, id) {
    if (!params || !params.agent) {
      client.subscribedAgents.clear();
      client.subscribedAll = false;
    } else {
      client.subscribedAgents.delete(params.agent);
    }
    client.send(rpcResult(id, { unsubscribed: true }));
  }

  function handlePtyAck(client, params, id) {
    // Notification — id should be absent. Errors close the connection per §1.11.
    if (!params || !params.handleId || typeof params.bytesConsumed !== 'number') {
      // Malformed ack — ignore silently (fire-and-forget).
      return;
    }
    // The daemon indexes handles by agent name; the IPC server must resolve
    // handleId → agent. Linear scan is acceptable — a handful of handles.
    const agentName = _findAgentByHandleId(params.handleId);
    if (!agentName) return; // unknown handle, drop silently
    try {
      ptyOps.ack(agentName, params.bytesConsumed);
    } catch (err) {
      if (err.code === 'FLOW_CONTROL_OVERFLOW') {
        logError(`FLOW_CONTROL_OVERFLOW from client #${client.id}: ${err.message}`);
        client.send(rpcError(
          id ?? null,
          ERR_FLOW_CONTROL_OVERFLOW,
          err.message,
          { category: 'protocol', retryable: false }
        ));
        // Close the connection — no state reuse. F12: use _rejectAndClose
        // to eliminate the 100 ms grace window.
        _rejectAndClose(client);
      }
      // Other errors: drop silently (ack is best-effort).
    }
  }

  function handlePtyReattach(client, params, id) {
    if (!params || !params.handleId || !params.agentId) {
      client.send(rpcError(id, ERR_INVALID_PARAMS, 'Missing handleId or agentId', { category: 'protocol', retryable: false }));
      return;
    }
    try {
      const result = ptyOps.reattach(
        params.agentId,
        params.handleId,
        params.resumeFromSeq || 0,
        params.maxReplayBytes
      );
      client.send(rpcResult(id, result));
    } catch (err) {
      const code = err.code === 'HANDLE_NOT_FOUND' ? ERR_HANDLE_NOT_FOUND : ERR_INVALID_PARAMS;
      client.send(rpcError(id, code, err.message, { category: 'pty', retryable: false }));
    }
  }

  function handleWatchdogPing(client, params, id) {
    const status = ptyOps.watchdogStatus ? ptyOps.watchdogStatus() : {};
    client.send(rpcResult(id, {
      nonce: params && params.nonce,
      ...status,
    }));
  }

  function handlePing(client, id) {
    const stats = ptyOps.daemonStats();
    stats.ipc_clients = clients.size;
    client.send(rpcResult(id, stats));
  }

  function _findAgentByHandleId(handleId) {
    // ptyOps.list exposes handles; scan for a match.
    const list = ptyOps.list();
    const arr = Array.isArray(list) ? list : (list.handles || list.agents || []);
    const row = arr.find(h => h.handleId === handleId);
    return row ? (row.agent || row.agentId) : null;
  }

  // ── Create net server ──────────────────────────────────────

  const server = createServer((socket) => {
    // H2: enforce MAX_CONNECTIONS manually. Node's `server.maxConnections`
    // property does exist on net.Server, but setting it causes Node to
    // close new connections silently — which defeats our observability
    // counter. Manual enforcement lets us count rejects and log.
    if (clients.size >= MAX_CONNECTIONS) {
      handshakeStats.rejectedMaxConn++;
      _recordHandshakeFailure('max-connections');
      _rateLimitedError('[IPC] connection refused — server at MAX_CONNECTIONS=%d totalRejectedMaxConn=%d',
        MAX_CONNECTIONS, handshakeStats.rejectedMaxConn);
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }

    const clientId = ++clientIdCounter;
    const client = new ClientConnection(socket, clientId);
    clients.set(clientId, client);
    log(`Client #${clientId} connected (total=${clients.size})`);

    // H2: install idle-handshake timer. Cleared on successful handshake
    // or reject. If the peer connects and never sends a full handshake
    // within IDLE_HANDSHAKE_TIMEOUT_MS, tear down.
    client.idleTimer = setTimeout(() => {
      if (client.handshakeComplete || client.rejected) return;
      handshakeStats.rejectedIdleTimeout++;
      _recordHandshakeFailure('idle-timeout');
      _rateLimitedError('[IPC] client #%d idle-handshake timeout (%dms) totalRejectedIdleTimeout=%d',
        clientId, IDLE_HANDSHAKE_TIMEOUT_MS, handshakeStats.rejectedIdleTimeout);
      _rejectAndClose(client);
    }, IDLE_HANDSHAKE_TIMEOUT_MS);

    socket.on('data', (data) => {
      // F12: once rejected, silently drop any further bytes but count
      // them as in-grace for observability.
      if (client.rejected) {
        if (data.length > 0) {
          handshakeStats.rejectedInGrace++;
          _recordHandshakeFailure('in-grace');
        }
        return;
      }

      client.inputBuffer += data.toString('utf-8');

      // H1: pre-auth OOM guard. Any peer streaming bytes without a
      // newline beyond INPUT_BUFFER_MAX_BYTES is destroyed immediately.
      // A single JSON-RPC message is always well under 64 KB in real
      // usage.
      if (client.inputBuffer.length > INPUT_BUFFER_MAX_BYTES) {
        handshakeStats.rejectedOversizedBuffer++;
        _recordHandshakeFailure('oversized-buffer');
        _rateLimitedError('[IPC] client #%d exceeded INPUT_BUFFER_MAX_BYTES=%d (bufLen=%d) totalRejectedOversizedBuffer=%d',
          clientId, INPUT_BUFFER_MAX_BYTES, client.inputBuffer.length, handshakeStats.rejectedOversizedBuffer);
        // Free the buffer before tearing down so the destroyed client
        // doesn't hold the memory until GC.
        client.inputBuffer = '';
        _rejectAndClose(client);
        return;
      }

      let newlineIdx;
      while ((newlineIdx = client.inputBuffer.indexOf('\n')) !== -1) {
        const line = client.inputBuffer.slice(0, newlineIdx).trim();
        client.inputBuffer = client.inputBuffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          handleRequest(client, line);
          if (client.rejected) break; // stop draining buffer on rejected clients
        }
      }
    });

    socket.on('close', () => {
      client.clearIdleTimer();
      clients.delete(clientId);
      if (clients.size === 0) {
        for (const [, mb] of mergeBuffers) {
          if (mb.timer) clearTimeout(mb.timer);
        }
        mergeBuffers.clear();
      }
      log(`Client #${clientId} disconnected (total=${clients.size})`);
    });

    socket.on('error', (err) => {
      logError(`Client #${clientId} socket error:`, err.message);
      client.clearIdleTimer();
      clients.delete(clientId);
      socket.destroy();
    });
  });

  server.on('error', (err) => {
    logError('IPC server error:', err);
  });

  return new Promise((resolve, reject) => {
    server.listen(ipcPath, () => {
      log(`IPC server listening on: ${ipcPath}`);
      resolve({
        address: ipcPath,
        server,
        close() {
          return new Promise((res) => {
            for (const client of clients.values()) client.destroy();
            clients.clear();
            for (const [, mb] of mergeBuffers) {
              if (mb.timer) clearTimeout(mb.timer);
            }
            mergeBuffers.clear();
            if (!isWindows && existsSync(ipcPath)) {
              try { unlinkSync(ipcPath); } catch {}
            }
            server.close(res);
          });
        }
      });
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}
