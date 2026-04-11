/**
 * pty-daemon-ipc.mjs — IPC Server (JSON-RPC 2.0 over Named Pipe / Unix Socket)
 *
 * Transport:
 *   Windows: Named Pipe \\.\pipe\teammcp-pty-{uid} (dev: \\.\pipe\teammcp-pty-dev-{uid})
 *   macOS/Linux: Unix Socket ~/.teammcp/pty-daemon.sock
 *
 * Protocol: Newline-delimited JSON-RPC 2.0
 */

import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';

const PREFIX = '[pty-ipc]';
const PROTOCOL_VERSION = '1.0';
const SERVER_VERSION = '1.0.0';

// Output merge window (ms)
const OUTPUT_MERGE_WINDOW = 50;

// Rate limits (bytes per second, pre-encoding)
const RATE_LIMIT_PER_AGENT = 200 * 1024;  // 200KB/s
const RATE_LIMIT_GLOBAL = 1024 * 1024;     // 1MB/s

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

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return JSON.stringify({ jsonrpc: '2.0', error: err, id });
}

function rpcNotification(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

// Standard JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
// Custom error codes
const HANDSHAKE_REQUIRED = -32000;
const VERSION_MISMATCH = -32001;
const AGENT_ERROR = -32010;

// ── Rate limiter ───────────────────────────────────────────────

class RateLimiter {
  constructor() {
    this.agentBuckets = new Map();  // agent → { bytes, lastReset }
    this.globalBytes = 0;
    this.globalLastReset = Date.now();
  }

  canSend(agent, bytes) {
    const now = Date.now();

    // Reset global bucket every second
    if (now - this.globalLastReset >= 1000) {
      this.globalBytes = 0;
      this.globalLastReset = now;
    }

    // Reset per-agent bucket every second
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
    this.subscribedAgents = new Set();
    this.subscribedAll = false;
    this.inputBuffer = '';
  }

  send(data) {
    if (this.socket.writable) {
      this.socket.write(data + '\n');
    }
  }

  isSubscribed(agent) {
    return this.subscribedAll || this.subscribedAgents.has(agent);
  }

  destroy() {
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
    ptyOps,
    setOutputHandler,
    setExitHandler
  } = options;

  // Compute IPC address
  let ipcPath;
  if (isWindows) {
    const pipeName = isDev ? `teammcp-pty-dev-${uid}` : `teammcp-pty-${uid}`;
    ipcPath = `\\\\.\\pipe\\${pipeName}`;
  } else {
    ipcPath = join(configDir, 'pty-daemon.sock');
    // Clean up stale socket file
    if (existsSync(ipcPath)) {
      try { unlinkSync(ipcPath); } catch {}
    }
  }

  const clients = new Map();  // id → ClientConnection
  let clientIdCounter = 0;
  const rateLimiter = new RateLimiter();

  // ── Output merge buffers ───────────────────────────────────

  // agent → { chunks: Buffer[], timer, rawBytes }
  const mergeBuffers = new Map();

  function flushMergeBuffer(agent) {
    const mb = mergeBuffers.get(agent);
    if (!mb || mb.chunks.length === 0) return;

    const merged = Buffer.concat(mb.chunks);
    const rawBytes = mb.rawBytes;
    mb.chunks = [];
    mb.rawBytes = 0;

    // Rate limit check
    if (!rateLimiter.canSend(agent, rawBytes)) {
      return; // Drop output that exceeds rate limit
    }

    const b64 = merged.toString('base64');
    const notification = rpcNotification('pty.output', {
      agent,
      data: b64,
      encoding: 'base64'
    });

    for (const client of clients.values()) {
      if (client.handshakeComplete && client.isSubscribed(agent)) {
        client.send(notification);
      }
    }
  }

  // Wire up PTY output handler
  setOutputHandler((agent, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

    let mb = mergeBuffers.get(agent);
    if (!mb) {
      mb = { chunks: [], timer: null, rawBytes: 0 };
      mergeBuffers.set(agent, mb);
    }

    mb.chunks.push(buf);
    mb.rawBytes += buf.length;

    // Reset merge timer
    if (mb.timer) clearTimeout(mb.timer);
    mb.timer = setTimeout(() => {
      mb.timer = null;
      flushMergeBuffer(agent);
    }, OUTPUT_MERGE_WINDOW);
  });

  // Wire up PTY exit handler — returns true if at least one client received it
  setExitHandler((agent, exitEvent) => {
    let delivered = false;
    const notification = JSON.stringify(exitEvent);

    // Flush any pending output for this agent first
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

  // ── Request handler ────────────────────────────────────────

  function handleRequest(client, msg) {
    let parsed;
    try {
      parsed = JSON.parse(msg);
    } catch {
      client.send(rpcError(null, PARSE_ERROR, 'Parse error'));
      return;
    }

    if (parsed.jsonrpc !== '2.0') {
      client.send(rpcError(parsed.id ?? null, INVALID_REQUEST, 'Invalid JSON-RPC version'));
      return;
    }

    const { method, params, id } = parsed;

    // Handshake must be first message
    if (!client.handshakeComplete && method !== 'handshake') {
      client.send(rpcError(id ?? null, HANDSHAKE_REQUIRED, 'Handshake required as first message'));
      return;
    }

    try {
      switch (method) {
        case 'handshake':
          return handleHandshake(client, params, id);
        case 'pty.spawn':
          return handlePtySpawn(client, params, id);
        case 'pty.kill':
          return handlePtyKill(client, params, id);
        case 'pty.resize':
          return handlePtyResize(client, params, id);
        case 'pty.write':
          return handlePtyWrite(client, params, id);
        case 'pty.list':
          return handlePtyList(client, id);
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
        case 'ping':
          return handlePing(client, id);
        default:
          client.send(rpcError(id ?? null, METHOD_NOT_FOUND, `Method not found: ${method}`));
      }
    } catch (err) {
      logError(`Error handling method "${method}":`, err.message);
      if (id !== undefined && id !== null) {
        client.send(rpcError(id, INTERNAL_ERROR, err.message));
      }
    }
  }

  function handleHandshake(client, params, id) {
    if (!params || !params.protocol_version) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing protocol_version'));
      return;
    }

    const clientMajor = params.protocol_version.split('.')[0];
    const serverMajor = PROTOCOL_VERSION.split('.')[0];
    const compatible = clientMajor === serverMajor;

    const stats = ptyOps.daemonStats();

    client.send(rpcResult(id, {
      protocol_version: PROTOCOL_VERSION,
      server: 'pty-daemon',
      server_version: SERVER_VERSION,
      compatible,
      agents_running: stats.agents
    }));

    if (compatible) {
      client.handshakeComplete = true;
      log(`Client #${client.id} handshake complete (client=${params.client || 'unknown'}, version=${params.client_version || 'unknown'})`);
    } else {
      log(`Client #${client.id} handshake failed: version mismatch (client=${params.protocol_version}, server=${PROTOCOL_VERSION})`);
      // Close after sending response
      setTimeout(() => client.destroy(), 100);
    }
  }

  function handlePtySpawn(client, params, id) {
    if (!params || !params.agent || !params.cmd) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing required params: agent, cmd'));
      return;
    }
    const result = ptyOps.spawn(
      params.agent,
      params.cmd,
      params.args || [],
      {
        cwd: params.cwd,
        env: params.env,
        cols: params.cols,
        rows: params.rows
      }
    );
    client.send(rpcResult(id, result));
  }

  function handlePtyKill(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing required param: agent'));
      return;
    }
    const result = ptyOps.kill(params.agent, params.signal);
    client.send(rpcResult(id, result));
  }

  function handlePtyResize(client, params, id) {
    if (!params || !params.agent || !params.cols || !params.rows) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing required params: agent, cols, rows'));
      return;
    }
    const result = ptyOps.resize(params.agent, params.cols, params.rows);
    client.send(rpcResult(id, result));
  }

  function handlePtyWrite(client, params, id) {
    if (!params || !params.agent || params.data === undefined) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing required params: agent, data'));
      return;
    }
    const result = ptyOps.write(params.agent, params.data);
    client.send(rpcResult(id, result));
  }

  function handlePtyList(client, id) {
    const result = ptyOps.list();
    client.send(rpcResult(id, result));
  }

  function handlePtyStatus(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing required param: agent'));
      return;
    }
    const result = ptyOps.status(params.agent);
    client.send(rpcResult(id, result));
  }

  function handlePtyScrollback(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing required param: agent'));
      return;
    }
    const result = ptyOps.scrollback(params.agent);
    client.send(rpcResult(id, result));
  }

  function handlePtySubscribe(client, params, id) {
    if (!params || !params.agent) {
      client.send(rpcError(id, INVALID_PARAMS, 'Missing required param: agent'));
      return;
    }
    client.subscribedAgents.add(params.agent);
    client.send(rpcResult(id, { subscribed: true }));
    log(`Client #${client.id} subscribed to "${params.agent}"`);
  }

  function handlePtySubscribeAll(client, id) {
    client.subscribedAll = true;

    // Replay buffered events
    const { events, summary } = ptyOps.drainEventBuffer();
    if (events.length > 0) {
      log(`Replaying ${events.length} buffered events to client #${client.id}`);
      for (const event of events) {
        client.send(JSON.stringify(event));
      }
    }
    if (summary) {
      client.send(JSON.stringify(summary));
    }

    client.send(rpcResult(id, { subscribed: true }));
    log(`Client #${client.id} subscribed to all agents (replayed ${events.length} buffered events)`);
  }

  function handlePtyUnsubscribe(client, params, id) {
    if (!params || !params.agent) {
      // Unsubscribe all
      client.subscribedAgents.clear();
      client.subscribedAll = false;
    } else {
      client.subscribedAgents.delete(params.agent);
    }
    client.send(rpcResult(id, { unsubscribed: true }));
  }

  function handlePing(client, id) {
    const stats = ptyOps.daemonStats();
    stats.ipc_clients = clients.size;
    client.send(rpcResult(id, stats));
  }

  // ── Create net server ──────────────────────────────────────

  const server = createServer((socket) => {
    const clientId = ++clientIdCounter;
    const client = new ClientConnection(socket, clientId);
    clients.set(clientId, client);
    log(`Client #${clientId} connected (total=${clients.size})`);

    socket.on('data', (data) => {
      client.inputBuffer += data.toString('utf-8');

      // Process newline-delimited messages
      let newlineIdx;
      while ((newlineIdx = client.inputBuffer.indexOf('\n')) !== -1) {
        const line = client.inputBuffer.slice(0, newlineIdx).trim();
        client.inputBuffer = client.inputBuffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          handleRequest(client, line);
        }
      }
    });

    socket.on('close', () => {
      clients.delete(clientId);
      // Clean up merge buffer timers if no subscribers left
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
      clients.delete(clientId);
      socket.destroy();
    });
  });

  server.on('error', (err) => {
    logError('IPC server error:', err);
  });

  // ── Start listening ────────────────────────────────────────

  return new Promise((resolve, reject) => {
    server.listen(ipcPath, () => {
      log(`IPC server listening on: ${ipcPath}`);
      resolve({
        address: ipcPath,
        server,
        close() {
          return new Promise((res) => {
            // Disconnect all clients
            for (const client of clients.values()) {
              client.destroy();
            }
            clients.clear();

            // Clean up merge timers
            for (const [, mb] of mergeBuffers) {
              if (mb.timer) clearTimeout(mb.timer);
            }
            mergeBuffers.clear();

            // Clean up socket file (Unix only)
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
