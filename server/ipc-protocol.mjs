/**
 * TeamMCP IPC Protocol — shared constants and helpers for PTY Daemon IPC.
 *
 * Used by both the HTTP Server (client side) and the PTY Daemon (server side).
 * Transport: NDJSON over Named Pipe (Windows) or Unix Socket (macOS/Linux).
 *
 * v1.1 extends v1.0 with: handleId, per-chunk seq, credit-based flow control
 * (pty.data + pty.ack), pty.reattach, watchdog.ping/pong, clientRequestId
 * spawn idempotency. v1.0 historical fields (protocol_version, client_version,
 * server_version, agents_running, scrollback_bytes, memory_mb) are preserved
 * snake_case on-wire for backward compat; all v1.1-new fields use camelCase.
 * See phase4-t1-ipc-protocol-draft.md §1.0.6.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ── Protocol version ──────────────────────────────────────────

export const PROTOCOL_VERSION = '1.1';

// ── JSON-RPC 2.0 method names ────────────────────────────────

export const IPC_METHODS = {
  // Lifecycle
  HANDSHAKE:      'handshake',
  PING:           'ping',

  // PTY commands
  PTY_SPAWN:      'pty.spawn',
  PTY_KILL:       'pty.kill',
  PTY_RESIZE:     'pty.resize',
  PTY_WRITE:      'pty.write',
  PTY_LIST:       'pty.list',
  PTY_STATUS:     'pty.status',
  PTY_SCROLLBACK: 'pty.scrollback',
  PTY_REATTACH:   'pty.reattach',   // v1.1
  PTY_ACK:        'pty.ack',         // v1.1 (notification, client → daemon)

  // Subscriptions
  PTY_SUBSCRIBE:     'pty.subscribe',
  PTY_SUBSCRIBE_ALL: 'pty.subscribe_all',
  PTY_UNSUBSCRIBE:   'pty.unsubscribe',

  // Events (daemon → client notifications)
  PTY_OUTPUT: 'pty.output', // v1.0 legacy path, still emitted for v1.0 clients
  PTY_DATA:   'pty.data',   // v1.1: replaces pty.output, carries handleId + seq + bytes
  PTY_EXIT:   'pty.exit',

  // Watchdog (v1.1, bidirectional)
  WATCHDOG_PING: 'watchdog.ping',
  WATCHDOG_PONG: 'watchdog.pong',
};

// ── Timeouts & intervals ─────────────────────────────────────

export const MAX_HANDSHAKE_TIMEOUT   = 3000;   // 3 seconds
export const HEALTH_CHECK_INTERVAL   = 10000;  // 10 seconds (legacy v1.0 ping)
export const MAX_HEALTH_FAILURES      = 3;     // 3 consecutive → daemon down
export const RECONNECT_BASE_DELAY     = 1000;  // 1 second (legacy)
export const RECONNECT_MAX_DELAY      = 30000; // 30 seconds (legacy)

// v1.1 watchdog timing (normative per §1.7)
export const WATCHDOG_PING_INTERVAL  = 5000;   // 5 s
export const WATCHDOG_MISS_THRESHOLD = 3;      // 3 consecutive → DEGRADED
export const WATCHDOG_DEGRADED_TIMEOUT = WATCHDOG_PING_INTERVAL * WATCHDOG_MISS_THRESHOLD; // 15 s

// v1.1 request timeouts (§1.0.4)
export const TIMEOUT_SPAWN    = 10000;
export const TIMEOUT_DEFAULT  = 3000;
export const TIMEOUT_WATCHDOG = 15000;

// v1.1 fallback state machine (§2.2 / §2.3)
export const FALLBACK_WRITE_BUFFER_PER_HANDLE = 64 * 1024;    // 64 KB per handle
export const FALLBACK_WRITE_BUFFER_TOTAL      = 1024 * 1024;  // 1 MB total
export const FALLBACK_RECONNECT_BASE_MS       = 30000;        // 30 s base
export const FALLBACK_RECONNECT_MAX_ATTEMPTS  = 5;            // ~15.5 min total

// v1.1 flow control (§1.11)
export const INITIAL_CREDIT          = 65536;   // 64 KiB per handle
export const PENDING_QUEUE_BOUND      = 4;       // chunks held while paused

// v1.1 clientRequestId GC for failed spawns (§1.1 B6)
export const SPAWN_IDEMPOTENCY_FAILED_GC_MS = 20 * 60 * 1000; // 20 min

// v1.1 watchdog respawn budget (§3.2)
export const WATCHDOG_RESPAWN_WINDOW_MS = 60 * 1000;
export const WATCHDOG_RESPAWN_BUDGET    = 3;

// ── Error codes (§1.10 — normative partition) ────────────────
// Transport: -32050..-32059  (always retryable: true)
// Protocol:  -32000..-32009 (session), -32020..-32029 (security/flow)
// PTY:       -32010..-32019  (retryable declared per-code)

// Transport
export const ERR_REQUEST_TIMEOUT    = -32050;
export const ERR_DAEMON_UNREACHABLE = -32051;

// Protocol — JSON-RPC 2.0 reserved
export const ERR_PARSE              = -32700;
export const ERR_INVALID_REQUEST    = -32600;
export const ERR_METHOD_NOT_FOUND   = -32601;
export const ERR_INVALID_PARAMS     = -32602;
export const ERR_INTERNAL           = -32603;

// Protocol — teammcp session
export const ERR_HANDSHAKE_REQUIRED = -32000;
export const ERR_VERSION_MISMATCH   = -32001;
export const ERR_AGENTID_MISMATCH   = -32005;

// Protocol — security / flow invariants
export const ERR_PEER_REJECTED        = -32020;
export const ERR_FLOW_CONTROL_OVERFLOW = -32021;

// PTY domain
export const ERR_AGENT_ALREADY_RUNNING = -32010;
export const ERR_SPAWN_FAILED          = -32011;
export const ERR_INVALID_SHELL         = -32012;
export const ERR_HANDLE_NOT_FOUND      = -32013;
export const ERR_REPLAY_UNAVAILABLE    = -32014;

// ── Pipe / socket naming ─────────────────────────────────────

export function getIpcPath(isDev = false) {
  const uid = process.getuid?.() ?? 0;

  if (platform() === 'win32') {
    const prefix = isDev ? 'teammcp-pty-dev' : 'teammcp-pty';
    return `\\\\.\\pipe\\${prefix}-${uid}`;
  }

  const home = isDev
    ? join(homedir(), '.teammcp-dev')
    : join(homedir(), '.teammcp');
  return join(home, 'pty-daemon.sock');
}

export function getPidFilePath(isDev = false) {
  const dir = isDev
    ? join(homedir(), '.teammcp-dev')
    : join(homedir(), '.teammcp');
  return join(dir, 'pty-daemon.pid');
}

// Shared-secret token file (NB4 pure-Node pipe gating).
// TODO(NB4): replace with SDDL + GetNamedPipeClientProcessId peer validation
// once a native addon (ffi-napi / koffi / custom N-API) is available.
export function getPipeTokenFilePath(isDev = false) {
  const dir = isDev
    ? join(homedir(), '.teammcp-dev')
    : join(homedir(), '.teammcp');
  return join(dir, 'pty-daemon.token');
}

// ── JSON-RPC 2.0 message builders ────────────────────────────

export function buildRequest(method, params, id) {
  const msg = { jsonrpc: '2.0', method, id };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function buildNotification(method, params) {
  const msg = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function buildResponse(result, id) {
  return { jsonrpc: '2.0', result, id };
}

export function buildError(code, message, id, extra) {
  const err = { code, message };
  if (extra && extra.category) err.category = extra.category;
  if (extra && typeof extra.retryable === 'boolean') err.retryable = extra.retryable;
  if (extra && extra.data !== undefined) err.data = extra.data;
  return { jsonrpc: '2.0', error: err, id };
}

// Error envelope categories (§1.0.2)
export function errorCategory(code) {
  if (code >= -32059 && code <= -32050) return 'transport';
  if (code >= -32019 && code <= -32010) return 'pty';
  // all other teammcp codes are protocol
  return 'protocol';
}

export function errorRetryable(code) {
  if (errorCategory(code) === 'transport') return true;
  // PTY retryable is per-code:
  //   -32010..-32014 are all false in v1.1
  return false;
}
