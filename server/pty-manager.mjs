/**
 * pty-manager.mjs — WebSocket Terminal bridge (IPC-backed)
 *
 * In the two-layer architecture, PTY processes run in the PTY Daemon (Layer 1).
 * This module bridges WebSocket clients (Dashboard terminal) to the Daemon via
 * the IPC client. It no longer manages PTY processes directly.
 *
 * Migrated from in-process node-pty to IPC proxy:
 *   - Old: pty.spawn() → node-pty in same process → onData → WS clients
 *   New: IPC pty.spawn → Daemon manages PTY → IPC pty.output → WS clients
 */
import { WebSocketServer } from 'ws';
import {
  spawnPty as ipcSpawnPty,
  killPty as ipcKillPty,
  resizePty as ipcResizePty,
  writeToPty as ipcWriteToPty,
  getScrollback as ipcGetScrollback,
  isConnected as isDaemonConnected,
} from './pty-daemon-client.mjs';

const SCROLLBACK_LIMIT = 100000; // 100KB ring buffer per agent

// agentName → { clients: Set<ws>, scrollback: string }
const wsEntries = new Map();

/**
 * Strip a potentially incomplete ANSI escape sequence from the START of a string.
 */
function stripLeadingPartialAnsi(str) {
  const escIdx = str.indexOf('\x1b');
  if (escIdx === -1) return str;
  if (escIdx === 0) {
    const m = str.match(/^\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Z0-9]|[NOPEHMD78=>c][\s\S]?)/);
    if (m) return str;
    const nextEsc = str.indexOf('\x1b', 1);
    return nextEsc === -1 ? '' : str.slice(nextEsc);
  }
  return str;
}

/**
 * Broadcast PTY output to WebSocket clients for a given agent.
 * Called by index.mjs's onPtyOutput handler via globalThis.__ptyWsBroadcast.
 */
function broadcastToWsClients(agent, dataBuffer) {
  let entry = wsEntries.get(agent);
  if (!entry) {
    entry = { clients: new Set(), scrollback: '' };
    wsEntries.set(agent, entry);
  }

  const data = typeof dataBuffer === 'string' ? dataBuffer : dataBuffer.toString('utf-8');

  // Buffer output for late-joining clients
  entry.scrollback += data;
  if (entry.scrollback.length > SCROLLBACK_LIMIT) {
    entry.scrollback = stripLeadingPartialAnsi(
      entry.scrollback.slice(entry.scrollback.length - SCROLLBACK_LIMIT)
    );
  }

  for (const ws of entry.clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

/**
 * Handle PTY exit — close WS clients for the agent.
 */
function handlePtyExit(agent) {
  const entry = wsEntries.get(agent);
  if (entry) {
    for (const ws of entry.clients) {
      try { ws.close(1000, 'PTY exited'); } catch {}
    }
    wsEntries.delete(agent);
  }
}

// Register global handlers for index.mjs to call
globalThis.__ptyWsBroadcast = broadcastToWsClients;
globalThis.__onPtyExit = handlePtyExit;

/**
 * Attach WebSocket server for terminal access.
 * Each WS connection is a Dashboard terminal view for one agent.
 */
export function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/terminal') return;

      wss.handleUpgrade(req, socket, head, (ws) => {
        const agent = url.searchParams.get('agent');
        if (!agent) {
          ws.close(4004, 'Agent name required');
          return;
        }

        // Check daemon connectivity
        if (!isDaemonConnected()) {
          ws.close(4004, 'Daemon not connected');
          return;
        }

        let entry = wsEntries.get(agent);
        if (!entry) {
          entry = { clients: new Set(), scrollback: '' };
          wsEntries.set(agent, entry);
        }

        entry.clients.add(ws);

        // Clear screen then send buffered scrollback to late-joining client
        ws.send('\x1b[2J\x1b[H');
        if (entry.scrollback) ws.send(entry.scrollback);
        console.log(`[pty] client attached: ${agent} (${entry.clients.size} clients)`);

        ws.on('message', (msg) => {
          const str = msg.toString();
          // Handle resize messages
          if (str.startsWith('{')) {
            try {
              const cmd = JSON.parse(str);
              if (cmd.type === 'resize' && cmd.cols && cmd.rows) {
                ipcResizePty(agent, cmd.cols, cmd.rows).catch(() => {});
                return;
              }
            } catch {}
          }
          // Forward input to Daemon
          ipcWriteToPty(agent, str).catch(() => {});
        });

        ws.on('close', () => {
          if (entry) entry.clients.delete(ws);
          console.log(`[pty] client detached: ${agent} (${entry?.clients.size || 0} clients)`);
        });

        ws.on('error', () => {
          if (entry) entry.clients.delete(ws);
        });
      });
    } catch {
      socket.destroy();
    }
  });

  console.log('[pty] WebSocket server attached at /ws/terminal');
  return wss;
}

// ── Re-exports for backward compatibility ──────────────────
// These now proxy through the IPC client

export async function spawnPty(name, command, args, options = {}) {
  if (!isDaemonConnected()) {
    throw new Error('PTY Daemon not connected');
  }
  return ipcSpawnPty(name, command, args, options);
}

export async function killPty(name) {
  if (!isDaemonConnected()) {
    throw new Error('PTY Daemon not connected');
  }
  return ipcKillPty(name);
}

export function getPtyNames() {
  return [...wsEntries.keys()];
}

/**
 * Register a PTY process from external source into the WebSocket bridge.
 * Kept for backward compat — but in two-layer arch, Daemon handles this.
 */
export function attachPtyOutput(name, proc) {
  console.warn(`[pty] attachPtyOutput(${name}): deprecated in two-layer arch, use IPC instead`);
}

export function writeToPty(name, data) {
  if (!isDaemonConnected()) {
    console.warn(`[pty] writeToPty(${name}): Daemon not connected`);
    return;
  }
  ipcWriteToPty(name, data).catch(() => {});
}

export function resizePty(name, cols, rows) {
  if (!isDaemonConnected()) return;
  ipcResizePty(name, cols, rows).catch(() => {});
}

export function killPtyByName(name) {
  if (!isDaemonConnected()) return;
  ipcKillPty(name).catch(() => {});
}
