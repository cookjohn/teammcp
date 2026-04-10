/**
 * pty-manager.mjs — node-pty process management + WebSocket terminal bridge
 * PoC: single-agent terminal access via /ws/terminal?agent=<name>
 */
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const ptys = new Map(); // agentName → { pty, clients: Set<ws> }

export function spawnPty(name, command, args, options = {}) {
  if (ptys.has(name)) return ptys.get(name).pty;

  const p = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: options.cols || 120,
    rows: options.rows || 40,
    cwd: options.cwd || process.env.HOME,
    env: options.env || process.env
  });

  const entry = { pty: p, clients: new Set() };

  p.onData((data) => {
    for (const ws of entry.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  });

  p.onExit(({ exitCode }) => {
    console.log(`[pty] ${name} exited (code ${exitCode})`);
    for (const ws of entry.clients) {
      try { ws.close(1000, 'PTY exited'); } catch {}
    }
    ptys.delete(name);
  });

  ptys.set(name, entry);
  console.log(`[pty] spawned: ${name} (${command} ${args.join(' ')})`);
  return p;
}

export function writeToPty(name, data) {
  const entry = ptys.get(name);
  if (entry) entry.pty.write(data);
}

export function resizePty(name, cols, rows) {
  const entry = ptys.get(name);
  if (entry) entry.pty.resize(cols, rows);
}

export function killPty(name) {
  const entry = ptys.get(name);
  if (entry) {
    entry.pty.kill();
    for (const ws of entry.clients) {
      try { ws.close(1000, 'PTY killed'); } catch {}
    }
    ptys.delete(name);
    console.log(`[pty] killed: ${name}`);
  }
}

export function getPtyNames() {
  return [...ptys.keys()];
}

export function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws/terminal') return;

      wss.handleUpgrade(req, socket, head, (ws) => {
        const agent = url.searchParams.get('agent');
        if (!agent || !ptys.has(agent)) {
          ws.close(4004, 'Agent not found');
          return;
        }

        const entry = ptys.get(agent);
        entry.clients.add(ws);
        console.log(`[pty] client attached: ${agent} (${entry.clients.size} clients)`);

        ws.on('message', (msg) => {
          const str = msg.toString();
          // Handle resize messages
          if (str.startsWith('{')) {
            try {
              const cmd = JSON.parse(str);
              if (cmd.type === 'resize' && cmd.cols && cmd.rows) {
                resizePty(agent, cmd.cols, cmd.rows);
                return;
              }
            } catch {}
          }
          entry.pty.write(str);
        });

        ws.on('close', () => {
          entry.clients.delete(ws);
          console.log(`[pty] client detached: ${agent} (${entry.clients.size} clients)`);
        });

        ws.on('error', () => {
          entry.clients.delete(ws);
        });
      });
    } catch {
      socket.destroy();
    }
  });

  console.log('[pty] WebSocket server attached at /ws/terminal');
  return wss;
}
