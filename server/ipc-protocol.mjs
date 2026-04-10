/**
 * TeamMCP IPC Protocol — shared constants and helpers for PTY Daemon IPC.
 *
 * Used by both the HTTP Server (client side) and the PTY Daemon (server side).
 * Transport: NDJSON over Named Pipe (Windows) or Unix Socket (macOS/Linux).
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ── Protocol version ──────────────────────────────────────────

export const PROTOCOL_VERSION = '1.0';

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

  // Subscriptions
  PTY_SUBSCRIBE:     'pty.subscribe',
  PTY_SUBSCRIBE_ALL: 'pty.subscribe_all',
  PTY_UNSUBSCRIBE:   'pty.unsubscribe',

  // Events (server → client notifications)
  PTY_OUTPUT: 'pty.output',
  PTY_EXIT:   'pty.exit',
};

// ── Timeouts & intervals ─────────────────────────────────────

export const MAX_HANDSHAKE_TIMEOUT   = 3000;   // 3 seconds
export const HEALTH_CHECK_INTERVAL   = 10000;  // 10 seconds
export const MAX_HEALTH_FAILURES      = 3;      // 3 consecutive → daemon down
export const RECONNECT_BASE_DELAY     = 1000;   // 1 second
export const RECONNECT_MAX_DELAY      = 30000;  // 30 seconds

// ── Pipe / socket naming ─────────────────────────────────────

/**
 * Return the platform-appropriate IPC path.
 * Windows: Named Pipe  → \\.\pipe\teammcp-pty[-dev]-{uid}
 * Others:  Unix Socket → ~/.teammcp[-dev]/pty-daemon.sock
 *
 * @param {boolean} [isDev=false]
 * @returns {string}
 */
export function getIpcPath(isDev = false) {
  const uid = process.getuid?.() ?? 0;

  if (platform() === 'win32') {
    const prefix = isDev ? 'teammcp-pty-dev' : 'teammcp-pty';
    return `\\\\.\\pipe\\${prefix}-${uid}`;
  }

  // Unix socket
  const home = isDev
    ? join(homedir(), '.teammcp-dev')
    : join(homedir(), '.teammcp');
  return join(home, 'pty-daemon.sock');
}

/**
 * Return the PID file path for the PTY daemon process.
 *
 * @param {boolean} [isDev=false]
 * @returns {string}
 */
export function getPidFilePath(isDev = false) {
  const dir = isDev
    ? join(homedir(), '.teammcp-dev')
    : join(homedir(), '.teammcp');
  return join(dir, 'pty-daemon.pid');
}

// ── JSON-RPC 2.0 message builders ────────────────────────────

/**
 * Build a JSON-RPC 2.0 request object.
 *
 * @param {string} method
 * @param {object} [params]
 * @param {number} id
 * @returns {object}
 */
export function buildRequest(method, params, id) {
  const msg = { jsonrpc: '2.0', method, id };
  if (params !== undefined) msg.params = params;
  return msg;
}

/**
 * Build a JSON-RPC 2.0 notification (no id — fire-and-forget).
 *
 * @param {string} method
 * @param {object} [params]
 * @returns {object}
 */
export function buildNotification(method, params) {
  const msg = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/**
 * Build a JSON-RPC 2.0 success response.
 *
 * @param {*} result
 * @param {number} id
 * @returns {object}
 */
export function buildResponse(result, id) {
  return { jsonrpc: '2.0', result, id };
}

/**
 * Build a JSON-RPC 2.0 error response.
 *
 * @param {number} code
 * @param {string} message
 * @param {number|null} id
 * @returns {object}
 */
export function buildError(code, message, id) {
  return { jsonrpc: '2.0', error: { code, message }, id };
}
