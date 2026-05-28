/**
 * TeamMCP PTY Manager — IPC-backed proxy
 *
 * This module provides the same high-level API as the existing pty-manager.mjs,
 * but routes all operations through the PTY Daemon IPC client instead of
 * managing PTY processes directly.
 *
 * It serves as a reference for the integration step — do NOT modify the
 * existing pty-manager.mjs yet. When ready, replace its internals with
 * calls to pty-daemon-client.mjs.
 */

import {
  connectToDaemon,
  disconnectFromDaemon,
  isConnected,
  getDaemonHealth,
  spawnPty,
  killPty,
  resizePty,
  writeToPty,
  listPtys,
  getPtyStatus,
  getScrollback,
  subscribe,
  subscribeAll,
  unsubscribe,
  onPtyOutput,
  onPtyExit,
  getHealthStatus,
  startHealthCheck,
  stopHealthCheck,
} from './pty-daemon-client.mjs';

// ── Lifecycle ─────────────────────────────────────────────────

/**
 * Initialize the PTY subsystem — connects to the daemon.
 *
 * @param {object} [options]
 * @param {boolean} [options.isDev=false]
 * @returns {Promise<void>}
 */
export async function initPtyManager(options = {}) {
  await connectToDaemon(options);
}

/**
 * Shut down the PTY subsystem — disconnects from the daemon.
 */
export function shutdownPtyManager() {
  disconnectFromDaemon();
}

// ── PTY operations (mirrors pty-manager.mjs API) ─────────────

/**
 * Start a new agent PTY session.
 *
 * @param {string} agentName
 * @param {object} opts  { cmd, args, cwd, env, cols, rows }
 * @returns {Promise<object>}
 */
export function startPty(agentName, opts = {}) {
  return spawnPty(
    agentName,
    opts.cmd ?? 'cmd.exe',
    opts.args ?? [],
    { cwd: opts.cwd, env: opts.env, cols: opts.cols ?? 200, rows: opts.rows ?? 50 },
  );
}

/**
 * Stop an agent PTY session.
 *
 * @param {string} agentName
 * @param {string} [signal]
 * @returns {Promise<object>}
 */
export function stopPty(agentName, signal) {
  return killPty(agentName, signal);
}

/**
 * Write input to an agent PTY session.
 *
 * @param {string} agentName
 * @param {string} data
 * @returns {Promise<object>}
 */
export function writePty(agentName, data) {
  return writeToPty(agentName, data);
}

/**
 * Resize an agent PTY session.
 *
 * @param {string} agentName
 * @param {number} cols
 * @param {number} rows
 * @returns {Promise<object>}
 */
export function resizePtySession(agentName, cols, rows) {
  return resizePty(agentName, cols, rows);
}

/**
 * Get a list of all running PTY sessions.
 *
 * @returns {Promise<object>}
 */
export function getAllPtys() {
  return listPtys();
}

/**
 * Get status of a specific PTY session.
 *
 * @param {string} agentName
 * @returns {Promise<object>}
 */
export function getPtySessionStatus(agentName) {
  return getPtyStatus(agentName);
}

/**
 * Get scrollback buffer for an agent.
 *
 * @param {string} agentName
 * @param {number} [lines]
 * @returns {Promise<object>}
 */
export function getPtyScrollback(agentName, lines) {
  return getScrollback(agentName, lines);
}

// ── Subscriptions ─────────────────────────────────────────────

/**
 * Subscribe to output for an agent (for SSE streaming).
 */
export function subscribeToAgent(agentName) {
  return subscribe(agentName);
}

/**
 * Subscribe to all agents' output.
 */
export function subscribeToAll() {
  return subscribeAll();
}

/**
 * Unsubscribe from an agent.
 */
export function unsubscribeFromAgent(agentName) {
  return unsubscribe(agentName);
}

// ── Event wiring (for SSE endpoints) ─────────────────────────

/**
 * Register a handler that receives PTY output and forwards it
 * to the appropriate SSE client.
 *
 * Usage in index.mjs:
 *   onPtyOutput((agent, dataBuffer) => {
 *     sseBroadcast(agent, dataBuffer);
 *   });
 */
export { onPtyOutput, onPtyExit };

// ── Health (for /api/pty-daemon/health) ───────────────────────

export { getHealthStatus, getDaemonHealth, isConnected };
