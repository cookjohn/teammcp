/**
 * TeamMCP PTY Daemon IPC Client
 *
 * Connects to the PTY Daemon via Named Pipe (Windows) or Unix Socket (macOS/Linux).
 * Implements JSON-RPC 2.0 over NDJSON with:
 *   - Handshake + version check
 *   - Request/response multiplexing
 *   - Health check ping/pong
 *   - Event dispatch (pty.output, pty.exit)
 *   - Auto-reconnect with exponential backoff
 *   - Subscription management
 */

import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  PROTOCOL_VERSION,
  IPC_METHODS,
  MAX_HANDSHAKE_TIMEOUT,
  HEALTH_CHECK_INTERVAL,
  MAX_HEALTH_FAILURES,
  RECONNECT_BASE_DELAY,
  RECONNECT_MAX_DELAY,
  getIpcPath,
  buildRequest,
  buildNotification,
} from './ipc-protocol.mjs';

// ── Internal state ────────────────────────────────────────────

let _socket       = null;       // net.Socket
let _connected    = false;      // true after successful handshake
let _connecting   = false;      // true while connect/handshake in-flight
let _nextId       = 1;          // monotonic JSON-RPC id
let _pending      = new Map();  // id → { resolve, reject, timer }
let _reconnectAttempts = 0;
let _reconnectTimer    = null;
let _healthTimer       = null;
let _healthFailures    = 0;
let _lastPong          = null;  // last health check result
let _isDev             = false;
let _subscriptions     = new Set();
let _buffer            = '';    // NDJSON line buffer

// Event emitter for pty.output / pty.exit
const _events = new EventEmitter();
_events.setMaxListeners(0); // unlimited

// ── Logging helper ────────────────────────────────────────────

function log(...args) {
  console.log('[ipc-client]', ...args);
}

function warn(...args) {
  console.warn('[ipc-client]', ...args);
}

// ── Connection ────────────────────────────────────────────────

/**
 * Connect to the PTY Daemon and perform the handshake.
 *
 * @param {object} [options]
 * @param {boolean} [options.isDev=false]  Use dev pipe/socket path.
 * @param {string}  [options.clientVersion] Override client version string.
 * @returns {Promise<object>} Resolves with daemon info from handshake response.
 */
export async function connectToDaemon(options = {}) {
  if (_connected) return _lastPong;
  if (_connecting) throw new Error('Already connecting');

  _isDev = options.isDev ?? _isDev;
  _connecting = true;

  try {
    const daemonInfo = await _openSocketAndHandshake(options.clientVersion);
    _connected  = true;
    _connecting = false;
    _reconnectAttempts = 0;

    log('Connected to daemon, agents_running:', daemonInfo.agents_running);

    // Restore subscriptions + start health checks (reconnect path)
    _restoreSubscriptions();
    startHealthCheck();

    return daemonInfo;
  } catch (err) {
    _connecting = false;
    throw err;
  }
}

/**
 * Gracefully disconnect from the daemon.
 */
export function disconnectFromDaemon() {
  stopHealthCheck();
  _clearReconnectTimer();

  if (_socket) {
    _socket.removeAllListeners();
    _socket.destroy();
    _socket = null;
  }

  _connected = false;
  _connecting = false;

  // Reject all pending requests
  for (const [id, entry] of _pending) {
    entry.reject(new Error('Disconnected'));
    clearTimeout(entry.timer);
  }
  _pending.clear();
  _buffer = '';

  log('Disconnected');
}

/**
 * @returns {boolean}
 */
export function isConnected() {
  return _connected;
}

/**
 * @returns {object|null} Last health check pong data, or null.
 */
export function getDaemonHealth() {
  return _lastPong;
}

// ── PTY Commands ──────────────────────────────────────────────

/**
 * Spawn a new PTY process.
 *
 * @param {string} agent
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {object} [options] { cwd, env, cols, rows }
 * @returns {Promise<object>}
 */
export async function spawnPty(agent, cmd, args = [], options = {}) {
  return _request(IPC_METHODS.PTY_SPAWN, { agent, cmd, args, ...options });
}

/**
 * Kill a PTY process.
 *
 * @param {string} agent
 * @param {string} [signal='SIGTERM']
 * @returns {Promise<object>}
 */
export async function killPty(agent, signal = 'SIGTERM') {
  return _request(IPC_METHODS.PTY_KILL, { agent, signal });
}

/**
 * Resize a PTY.
 *
 * @param {string} agent
 * @param {number} cols
 * @param {number} rows
 * @returns {Promise<object>}
 */
export async function resizePty(agent, cols, rows) {
  return _request(IPC_METHODS.PTY_RESIZE, { agent, cols, rows });
}

/**
 * Write data to a PTY stdin.
 *
 * @param {string} agent
 * @param {string} data
 * @returns {Promise<object>}
 */
export async function writeToPty(agent, data) {
  return _request(IPC_METHODS.PTY_WRITE, { agent, data });
}

/**
 * List all running PTY processes.
 *
 * @returns {Promise<object>}
 */
export async function listPtys() {
  return _request(IPC_METHODS.PTY_LIST);
}

/**
 * Get status of a specific PTY.
 *
 * @param {string} agent
 * @returns {Promise<object>}
 */
export async function getPtyStatus(agent) {
  return _request(IPC_METHODS.PTY_STATUS, { agent });
}

/**
 * Get scrollback buffer for a PTY.
 *
 * @param {string} agent
 * @param {number} [lines=100]
 * @returns {Promise<object>}
 */
export async function getScrollback(agent, lines = 100) {
  return _request(IPC_METHODS.PTY_SCROLLBACK, { agent, lines });
}

// ── Subscriptions ─────────────────────────────────────────────

/**
 * Subscribe to output events for a specific agent.
 *
 * @param {string} agent
 * @returns {Promise<object>}
 */
export async function subscribe(agent) {
  _subscriptions.add(agent);
  return _request(IPC_METHODS.PTY_SUBSCRIBE, { agent });
}

/**
 * Subscribe to output events for all agents.
 *
 * @returns {Promise<object>}
 */
export async function subscribeAll() {
  return _request(IPC_METHODS.PTY_SUBSCRIBE_ALL);
}

/**
 * Unsubscribe from output events for a specific agent.
 *
 * @param {string} agent
 * @returns {Promise<object>}
 */
export async function unsubscribe(agent) {
  _subscriptions.delete(agent);
  return _request(IPC_METHODS.PTY_UNSUBSCRIBE, { agent });
}

// ── Event handlers ────────────────────────────────────────────

/**
 * Register a callback for PTY output events.
 *
 * @param {(agent: string, dataBuffer: Buffer) => void} callback
 */
export function onPtyOutput(callback) {
  _events.on('pty.output', callback);
}

/**
 * Register a callback for PTY exit events.
 *
 * @param {(agent: string, exitCode: number, signal: string|null, timestamp: number) => void} callback
 */
export function onPtyExit(callback) {
  _events.on('pty.exit', callback);
}

// ── Health ────────────────────────────────────────────────────

/**
 * Returns the current health status for the daemon connection.
 *
 * @returns {{ connected: boolean, lastPing: object|null, failures: number, daemonInfo: object|null }}
 */
export function getHealthStatus() {
  return {
    connected:  _connected,
    lastPing:   _lastPong,
    failures:   _healthFailures,
    daemonInfo: _lastPong,
  };
}

/**
 * Start periodic health check pings.
 */
export function startHealthCheck() {
  stopHealthCheck();
  _healthFailures = 0;
  _healthTimer = setInterval(_healthPing, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop health check pings.
 */
export function stopHealthCheck() {
  if (_healthTimer) {
    clearInterval(_healthTimer);
    _healthTimer = null;
  }
}

// ── Internals ─────────────────────────────────────────────────

/**
 * Open socket, send handshake, wait for response.
 *
 * @param {string} [clientVersion]
 * @returns {Promise<object>}
 */
function _openSocketAndHandshake(clientVersion) {
  return new Promise((resolve, reject) => {
    const ipcPath = getIpcPath(_isDev);
    log('Connecting to', ipcPath);

    const sock = createConnection(ipcPath, () => {
      // Connection established — send handshake
      _socket = sock;
      _buffer = '';
      _setupSocketListeners();

      const handshakeId = _nextId++;
      const msg = buildRequest(
        IPC_METHODS.HANDSHAKE,
        {
          protocol_version: PROTOCOL_VERSION,
          client: 'http-server',
          client_version: clientVersion ?? '2.0.0',
        },
        handshakeId,
      );

      const timer = setTimeout(() => {
        _pending.delete(handshakeId);
        sock.destroy();
        reject(new Error(`Handshake timed out after ${MAX_HANDSHAKE_TIMEOUT}ms`));
      }, MAX_HANDSHAKE_TIMEOUT);

      _pending.set(handshakeId, {
        resolve: (result) => {
          clearTimeout(timer);
          // Version compatibility check
          const serverMajor = String(result.protocol_version ?? '').split('.')[0];
          const clientMajor = PROTOCOL_VERSION.split('.')[0];
          if (serverMajor !== clientMajor) {
            sock.destroy();
            reject(new Error(
              `Protocol version mismatch: server=${result.protocol_version}, client=${PROTOCOL_VERSION}`
            ));
            return;
          }
          if (result.compatible === false) {
            sock.destroy();
            reject(new Error('Daemon reports incompatible client'));
            return;
          }
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          sock.destroy();
          reject(err);
        },
        timer,
      });

      _writeToSocket(sock, msg);
    });

    sock.on('error', (err) => {
      if (_pending.size > 0) {
        for (const [id, entry] of _pending) {
          entry.reject(err);
          clearTimeout(entry.timer);
        }
        _pending.clear();
      }
      reject(err);
    });
  });
}

/**
 * Set up listeners on the connected socket.
 */
function _setupSocketListeners() {
  const sock = _socket;

  sock.on('data', (chunk) => {
    _buffer += chunk.toString('utf-8');

    // Process complete lines (NDJSON framing)
    let idx;
    while ((idx = _buffer.indexOf('\n')) !== -1) {
      const line = _buffer.slice(0, idx).trim();
      _buffer = _buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line);
        _handleMessage(msg);
      } catch (err) {
        warn('Failed to parse IPC message:', err.message, 'raw:', line.slice(0, 200));
      }
    }
  });

  sock.on('close', () => {
    warn('Connection closed');
    _connected = false;
    _socket = null;

    // Reject pending requests
    for (const [id, entry] of _pending) {
      entry.reject(new Error('Connection closed'));
      clearTimeout(entry.timer);
    }
    _pending.clear();

    // Attempt reconnect
    _scheduleReconnect();
  });

  sock.on('error', (err) => {
    warn('Socket error:', err.message);
  });
}

/**
 * Route an incoming JSON-RPC message.
 */
function _handleMessage(msg) {
  // Response to a pending request
  if (msg.id !== undefined && msg.id !== null && _pending.has(msg.id)) {
    const entry = _pending.get(msg.id);
    _pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(`RPC Error ${msg.error.code}: ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
    return;
  }

  // Notification / event from server (no id)
  if (msg.method) {
    switch (msg.method) {
      case IPC_METHODS.PTY_OUTPUT: {
        const { agent, data, encoding } = msg.params ?? {};
        const buf = encoding === 'base64'
          ? Buffer.from(data, 'base64')
          : Buffer.from(data ?? '');
        _events.emit('pty.output', agent, buf);
        break;
      }
      case IPC_METHODS.PTY_EXIT: {
        const { agent, exitCode, signal, timestamp } = msg.params ?? {};
        _events.emit('pty.exit', agent, exitCode, signal, timestamp);
        break;
      }
      default:
        warn('Unknown notification method:', msg.method);
    }
    return;
  }

  warn('Unhandled IPC message:', JSON.stringify(msg).slice(0, 200));
}

/**
 * Send a JSON-RPC request and return a promise for its result.
 *
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<*>}
 */
function _request(method, params) {
  if (!_connected || !_socket) {
    return Promise.reject(new Error('Not connected to daemon'));
  }
  const id = _nextId++;
  const msg = buildRequest(method, params, id);
  return _send(msg);
}

/**
 * Send a pre-built message and return a promise for its response.
 *
 * @param {object} msg
 * @returns {Promise<*>}
 */
function _send(msg) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _pending.delete(msg.id);
      reject(new Error(`Request ${msg.method} timed out`));
    }, 10000);

    _pending.set(msg.id, { resolve, reject, timer: timeout });

    if (!_socket) {
      _pending.delete(msg.id);
      clearTimeout(timeout);
      reject(new Error('Socket not available'));
      return;
    }

    _writeToSocket(_socket, msg);
  });
}

/**
 * Write a JSON message as NDJSON to the socket.
 *
 * @param {import('node:net').Socket} sock
 * @param {object} msg
 */
function _writeToSocket(sock, msg) {
  const line = JSON.stringify(msg) + '\n';
  sock.write(line, 'utf-8');
}

// ── Health check ──────────────────────────────────────────────

async function _healthPing() {
  if (!_connected || !_socket) return;

  try {
    const result = await _request(IPC_METHODS.PING);
    _lastPong = result;
    _healthFailures = 0;
  } catch {
    _healthFailures++;
    warn(`Health check failed (${_healthFailures}/${MAX_HEALTH_FAILURES})`);

    if (_healthFailures >= MAX_HEALTH_FAILURES) {
      warn('Daemon unresponsive — closing connection for reconnect');
      _connected = false;
      if (_socket) {
        _socket.destroy();
        _socket = null;
      }
    }
  }
}

// ── Reconnect ─────────────────────────────────────────────────

/**
 * Restore all tracked subscriptions after connect/reconnect.
 * Tries subscribe_all first, falls back to per-agent.
 */
async function _restoreSubscriptions() {
  if (_subscriptions.size === 0) return;
  try {
    await subscribeAll();
  } catch {
    for (const agent of _subscriptions) {
      try { await subscribe(agent); } catch { /* best effort */ }
    }
  }
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;

  _reconnectAttempts++;
  const delay = Math.min(
    RECONNECT_BASE_DELAY * Math.pow(2, _reconnectAttempts - 1),
    RECONNECT_MAX_DELAY,
  );

  log(`Reconnecting in ${delay}ms (attempt ${_reconnectAttempts})`);

  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    try {
      await connectToDaemon({ isDev: _isDev });
      log('Reconnected successfully');
      _restoreSubscriptions();
    } catch (err) {
      warn('Reconnect failed:', err.message);
      // _scheduleReconnect will be called again by the socket close handler
    }
  }, delay);
}

function _clearReconnectTimer() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}
