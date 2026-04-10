/**
 * daemon-launcher.mjs — PTY Daemon 启动/检测/重启管理
 *
 * 在 HTTP Server 启动前确保 PTY Daemon 在运行：
 *   1. 检查 PID 文件 → 存活则跳过
 *   2. 不存活则 spawn detached 子进程
 *   3. 等 IPC ready（最多 5s，每 500ms 重试连接）
 *   4. 返回连接状态
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getIpcPath,
  getPidFilePath,
  HEALTH_CHECK_INTERVAL,
  MAX_HEALTH_FAILURES,
} from './ipc-protocol.mjs';
import {
  connectToDaemon,
  isConnected,
  getHealthStatus,
  startHealthCheck,
  stopHealthCheck,
  subscribeAll,
} from './pty-daemon-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────

const DAEMON_READY_TIMEOUT  = 5000;   // max wait for daemon IPC ready (ms)
const DAEMON_READY_INTERVAL = 500;    // retry interval (ms)
const DAEMON_SCRIPT = join(__dirname, 'pty-daemon.mjs');

// ── PID file helpers ───────────────────────────────────────

function readPidFile(isDev) {
  const pidPath = getPidFilePath(isDev);
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function writePidFile(isDev, pid) {
  const pidPath = getPidFilePath(isDev);
  const dir = dirname(pidPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(pidPath, String(pid), 'utf-8');
}

function removePidFile(isDev) {
  const pidPath = getPidFilePath(isDev);
  try { unlinkSync(pidPath); } catch {}
}

// ── Process alive check (cross-platform) ───────────────────

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    // signal 0 = check existence without sending a signal
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
    // EPERM means process exists but we lack permission → still alive
  }
}

// ── Spawn daemon ───────────────────────────────────────────

function spawnDaemon(isDev) {
  const env = {
    ...process.env,
    TEAMMCP_DAEMON: '1',
    TEAMMCP_DAEMON_DEV: isDev ? '1' : '0',
  };

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Log daemon output to console with prefix
  child.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) console.log(`[daemon] ${line}`);
    }
  });
  child.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) console.error(`[daemon] ${line}`);
    }
  });

  child.on('exit', (code) => {
    console.log(`[daemon-launcher] Daemon exited with code ${code}`);
    removePidFile(isDev);
  });

  // Don't keep the parent alive if daemon is the only thing running
  child.unref();

  writePidFile(isDev, child.pid);
  console.log(`[daemon-launcher] Daemon spawned (PID: ${child.pid})`);

  return child.pid;
}

// ── Wait for daemon IPC ready ──────────────────────────────

async function waitForDaemonReady(isDev) {
  const start = Date.now();
  while (Date.now() - start < DAEMON_READY_TIMEOUT) {
    try {
      await connectToDaemon({ isDev });
      console.log(`[daemon-launcher] Daemon IPC ready (${Date.now() - start}ms)`);
      return true;
    } catch {
      // Not ready yet, wait and retry
      await new Promise(r => setTimeout(r, DAEMON_READY_INTERVAL));
    }
  }
  return false;
}

// ── Main entry point ───────────────────────────────────────

/**
 * Ensure PTY Daemon is running and connected.
 *
 * @param {object} [options]
 * @param {boolean} [options.isDev=false]
 * @returns {Promise<{ connected: boolean, spawned: boolean, pid: number|null }>}
 */
export async function ensureDaemon(options = {}) {
  const isDev = options.isDev ?? false;

  // Already connected (e.g. reconnect scenario)?
  if (isConnected()) {
    return { connected: true, spawned: false, pid: readPidFile(isDev) };
  }

  // Step 1: Check PID file → is the process alive?
  const existingPid = readPidFile(isDev);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`[daemon-launcher] Daemon already running (PID: ${existingPid})`);
    // Try to connect
    const ready = await waitForDaemonReady(isDev);
    if (ready) {
      return { connected: true, spawned: false, pid: existingPid };
    }
    console.warn('[daemon-launcher] Daemon process alive but IPC not responding, respawning...');
    // Kill the stale process
    try { process.kill(existingPid, 'SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 1000));
    removePidFile(isDev);
  }

  // Step 2: Spawn new daemon
  const pid = spawnDaemon(isDev);

  // Step 3: Wait for IPC ready
  const ready = await waitForDaemonReady(isDev);
  if (!ready) {
    console.error('[daemon-launcher] Daemon failed to become ready within timeout');
    return { connected: false, spawned: true, pid };
  }

  return { connected: true, spawned: true, pid };
}

/**
 * Start health check monitoring after daemon is connected.
 * Calls the provided callback when daemon health changes.
 *
 * @param {function} onHealthChange - callback(healthStatus)
 */
export function startDaemonHealthMonitor(onHealthChange) {
  startHealthCheck();

  // Periodic health report
  const timer = setInterval(() => {
    const health = getHealthStatus();
    if (onHealthChange) onHealthChange(health);

    if (health.failures >= MAX_HEALTH_FAILURES) {
      console.error('[daemon-launcher] Daemon unresponsive, will attempt reconnect...');
    }
  }, HEALTH_CHECK_INTERVAL);

  return () => {
    clearInterval(timer);
    stopHealthCheck();
  };
}
