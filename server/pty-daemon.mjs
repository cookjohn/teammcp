/**
 * pty-daemon.mjs — PTY Daemon (Layer 1)
 *
 * Standalone process that manages agent PTY terminals via node-pty.
 * Survives HTTP server restarts. Communicates with Layer 2 via IPC (JSON-RPC 2.0).
 *
 * Usage:
 *   node pty-daemon.mjs [--dev]
 *   TEAMMCP_ENV=dev node pty-daemon.mjs
 */

import pty from 'node-pty';
import { platform, homedir, userInfo } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createIPCServer } from './pty-daemon-ipc.mjs';

const isWindows = platform() === 'win32';

// ── Environment detection ──────────────────────────────────────

const isDev = process.argv.includes('--dev')
  || process.env.TEAMMCP_ENV === 'dev'
  || process.env.TEAMMCP_DEV === '1'
  || process.env.TEAMMCP_DAEMON_DEV === '1';

const configDir = join(homedir(), isDev ? '.teammcp-dev' : '.teammcp');
const pidFile = join(configDir, 'pty-daemon.pid');

const PREFIX = '[pty-daemon]';

function log(...args) {
  console.log(PREFIX, new Date().toISOString(), ...args);
}

function logError(...args) {
  console.error(PREFIX, new Date().toISOString(), ...args);
}

// ── PID file management ────────────────────────────────────────

function writePidFile() {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(pidFile, String(process.pid), 'utf-8');
  log(`PID file written: ${pidFile} (pid=${process.pid})`);
}

function removePidFile() {
  try {
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
      log('PID file removed');
    }
  } catch (err) {
    logError('Failed to remove PID file:', err.message);
  }
}

function checkExistingDaemon() {
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    // Check if process is alive
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process not running, stale PID file
    removePidFile();
    return false;
  }
}

// ── Scrollback ring buffer ─────────────────────────────────────

const SCROLLBACK_MAX = 100 * 1024; // 100KB per agent

class ScrollbackBuffer {
  constructor(maxSize = SCROLLBACK_MAX) {
    this.maxSize = maxSize;
    this.buffer = Buffer.alloc(maxSize);
    this.writePos = 0;
    this.totalWritten = 0;
  }

  write(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (chunk.length >= this.maxSize) {
      // Data larger than buffer — keep only the tail
      chunk.copy(this.buffer, 0, chunk.length - this.maxSize);
      this.writePos = this.maxSize;
      this.totalWritten += chunk.length;
      return;
    }
    const spaceLeft = this.maxSize - this.writePos;
    if (chunk.length <= spaceLeft) {
      chunk.copy(this.buffer, this.writePos);
      this.writePos += chunk.length;
    } else {
      // Wrap around
      chunk.copy(this.buffer, this.writePos, 0, spaceLeft);
      chunk.copy(this.buffer, 0, spaceLeft);
      this.writePos = chunk.length - spaceLeft;
    }
    this.totalWritten += chunk.length;
  }

  read() {
    if (this.totalWritten <= this.maxSize) {
      // Buffer hasn't wrapped yet
      return Buffer.from(this.buffer.subarray(0, this.writePos));
    }
    // Wrapped: read from writePos to end, then start to writePos
    const tail = this.buffer.subarray(this.writePos);
    const head = this.buffer.subarray(0, this.writePos);
    return Buffer.concat([tail, head]);
  }

  get byteLength() {
    return Math.min(this.totalWritten, this.maxSize);
  }
}

// ── Event buffer (for disconnect periods) ──────────────────────

const EVENT_BUFFER_MAX_ITEMS = 1000;
const EVENT_BUFFER_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const EVENT_BUFFER_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

const L1_ITEM_THRESHOLD = 800;
const L1_MEM_THRESHOLD = 4 * 1024 * 1024; // 4MB
const L2_ITEM_THRESHOLD = EVENT_BUFFER_MAX_ITEMS;
const L2_MEM_THRESHOLD = EVENT_BUFFER_MAX_BYTES;

class EventBuffer {
  constructor() {
    this.events = [];
    this.totalBytes = 0;
    this.overflowCount = 0;
    this.droppedLowPriority = 0;
  }

  get level() {
    if (this.events.length >= L2_ITEM_THRESHOLD || this.totalBytes >= L2_MEM_THRESHOLD) {
      return 3; // Overflow
    }
    if (this.events.length >= L1_ITEM_THRESHOLD || this.totalBytes >= L1_MEM_THRESHOLD) {
      return 2; // Warning
    }
    return 1; // Normal
  }

  push(event, priority = 'normal') {
    // Expire old events first
    this._evictExpired();

    const serialized = JSON.stringify(event);
    const eventSize = Buffer.byteLength(serialized, 'utf-8');

    const level = this.level;

    if (level === 2 && priority === 'low') {
      // L2 Warning: drop low-priority events
      this.droppedLowPriority++;
      log(`Event buffer L2 warning: dropping low-priority event (dropped=${this.droppedLowPriority})`);
      return;
    }

    if (level === 3) {
      // L3 Overflow: FIFO evict, keep recent 500
      this._evictToCount(500);
      this.overflowCount++;
      log(`Event buffer L3 overflow: evicted to 500 items (overflow #${this.overflowCount})`);
    }

    this.events.push({ event, size: eventSize, timestamp: Date.now() });
    this.totalBytes += eventSize;
  }

  drain() {
    const result = this.events.map(e => e.event);
    const summary = this.overflowCount > 0 || this.droppedLowPriority > 0
      ? {
          jsonrpc: '2.0',
          method: 'buffer_overflow',
          params: {
            overflow_events: this.overflowCount,
            dropped_low_priority: this.droppedLowPriority,
            message: `Buffer overflow occurred: ${this.overflowCount} overflow evictions, ${this.droppedLowPriority} low-priority events dropped`
          }
        }
      : null;

    this.events = [];
    this.totalBytes = 0;
    this.overflowCount = 0;
    this.droppedLowPriority = 0;

    return { events: result, summary };
  }

  get length() {
    return this.events.length;
  }

  get memoryBytes() {
    return this.totalBytes;
  }

  _evictExpired() {
    const cutoff = Date.now() - EVENT_BUFFER_MAX_AGE_MS;
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      const removed = this.events.shift();
      this.totalBytes -= removed.size;
      this.overflowCount++;
    }
  }

  _evictToCount(target) {
    while (this.events.length > target) {
      const removed = this.events.shift();
      this.totalBytes -= removed.size;
    }
  }
}

// ── PTY process pool ───────────────────────────────────────────

// Map<agentName, { proc, scrollback, cols, rows, startTime, pid }>
const agents = new Map();
const eventBuffer = new EventBuffer();
const startTime = Date.now();

// Callback set by IPC server to push events to connected clients
let onPtyOutput = null;
let onPtyExit = null;

export function setOutputHandler(handler) {
  onPtyOutput = handler;
}

export function setExitHandler(handler) {
  onPtyExit = handler;
}

export function spawnAgent(agent, cmd, args = [], options = {}) {
  if (agents.has(agent)) {
    throw new Error(`Agent "${agent}" already has a running PTY`);
  }

  const cols = options.cols || 200;
  const rows = options.rows || 50;

  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: options.cwd || process.env.HOME || homedir(),
    env: options.env || process.env
  });

  const scrollback = new ScrollbackBuffer();
  const entry = { proc, scrollback, cols, rows, startTime: Date.now(), pid: proc.pid };

  proc.onData((data) => {
    scrollback.write(data);
    if (onPtyOutput) {
      onPtyOutput(agent, data);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    log(`Agent "${agent}" exited (code=${exitCode}, signal=${signal})`);
    agents.delete(agent);

    const exitEvent = {
      jsonrpc: '2.0',
      method: 'pty.exit',
      params: { agent, exitCode, signal, timestamp: new Date().toISOString() }
    };

    if (onPtyExit) {
      const delivered = onPtyExit(agent, exitEvent);
      if (!delivered) {
        // No clients connected, buffer the event
        eventBuffer.push(exitEvent, 'high');
        log(`Buffered pty.exit for "${agent}" (buffer size=${eventBuffer.length})`);
      }
    } else {
      eventBuffer.push(exitEvent, 'high');
    }
  });

  agents.set(agent, entry);
  log(`Spawned agent "${agent}": ${cmd} ${args.join(' ')} (pid=${proc.pid}, cols=${cols}, rows=${rows})`);

  return { agent, pid: proc.pid };
}

export function killAgent(agent, signal) {
  const entry = agents.get(agent);
  if (!entry) {
    throw new Error(`Agent "${agent}" not found`);
  }
  if (isWindows) {
    entry.proc.kill();
  } else {
    entry.proc.kill(signal || 'SIGTERM');
  }
  return { agent, killed: true };
}

export function resizeAgent(agent, cols, rows) {
  const entry = agents.get(agent);
  if (!entry) {
    throw new Error(`Agent "${agent}" not found`);
  }
  entry.proc.resize(cols, rows);
  entry.cols = cols;
  entry.rows = rows;
  return { agent, resized: true };
}

export function writeAgent(agent, data) {
  const entry = agents.get(agent);
  if (!entry) {
    throw new Error(`Agent "${agent}" not found`);
  }
  entry.proc.write(data);
  return { agent, written: true };
}

export function listAgents() {
  const result = [];
  for (const [agent, entry] of agents) {
    result.push({
      agent,
      pid: entry.pid,
      cols: entry.cols,
      rows: entry.rows,
      uptime: Math.floor((Date.now() - entry.startTime) / 1000)
    });
  }
  return result;
}

export function agentStatus(agent) {
  const entry = agents.get(agent);
  if (!entry) {
    throw new Error(`Agent "${agent}" not found`);
  }
  return {
    agent,
    pid: entry.pid,
    cols: entry.cols,
    rows: entry.rows,
    uptime: Math.floor((Date.now() - entry.startTime) / 1000),
    scrollback_bytes: entry.scrollback.byteLength
  };
}

export function agentScrollback(agent) {
  const entry = agents.get(agent);
  if (!entry) {
    throw new Error(`Agent "${agent}" not found`);
  }
  return {
    agent,
    data: entry.scrollback.read().toString('base64'),
    encoding: 'base64'
  };
}

export function getDaemonStats() {
  const memUsage = process.memoryUsage();
  return {
    uptime: Math.floor((Date.now() - startTime) / 1000),
    agents: agents.size,
    memory_mb: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
    buffer_usage: {
      items: eventBuffer.length,
      bytes: eventBuffer.memoryBytes,
      level: eventBuffer.level
    }
  };
}

export function drainEventBuffer() {
  return eventBuffer.drain();
}

export function getEventBuffer() {
  return eventBuffer;
}

// ── Graceful shutdown ──────────────────────────────────────────

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down (signal=${signal})...`);

  // Kill all PTYs
  for (const [agent, entry] of agents) {
    try {
      log(`Killing agent "${agent}" (pid=${entry.pid})`);
      if (isWindows) {
        entry.proc.kill();
      } else {
        entry.proc.kill('SIGTERM');
      }
    } catch (err) {
      logError(`Failed to kill agent "${agent}":`, err.message);
    }
  }
  agents.clear();

  removePidFile();
  log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logError('Uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection:', reason);
});

// ── Main entry point ───────────────────────────────────────────

async function main() {
  log(`Starting PTY Daemon (${isDev ? 'DEV' : 'PROD'} mode, pid=${process.pid})`);

  // Check for existing daemon
  const existingPid = checkExistingDaemon();
  if (existingPid) {
    logError(`Another daemon is already running (pid=${existingPid}). Exiting.`);
    process.exit(1);
  }

  // Write PID file
  writePidFile();

  // Start IPC server
  // Match ipc-protocol.mjs: process.getuid?.() ?? 0
  const uid = isWindows ? (process.getuid?.() ?? 0) : userInfo().uid;
  const ipcServer = await createIPCServer({
    isDev,
    uid,
    isWindows,
    configDir,
    // PTY operations exposed to IPC
    ptyOps: {
      spawn: spawnAgent,
      kill: killAgent,
      resize: resizeAgent,
      write: writeAgent,
      list: listAgents,
      status: agentStatus,
      scrollback: agentScrollback,
      daemonStats: getDaemonStats,
      drainEventBuffer: drainEventBuffer
    },
    setOutputHandler,
    setExitHandler
  });

  log(`PTY Daemon ready (ipc=${ipcServer.address})`);
}

main().catch((err) => {
  logError('Fatal error during startup:', err);
  removePidFile();
  process.exit(1);
});
