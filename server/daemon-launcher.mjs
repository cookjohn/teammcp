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
import {
  existsSync,
  readFileSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';
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
import {
  initWatchdog,
  recordRespawn,
  isEscalated,
  resetDaemonEscalation as _resetDaemonEscalation,
  requestAgentRestarts,
} from './pty-watchdog.mjs';
// ROUND 3 Item 3 (Phase 4-T1): subscribe a minimal logger to the
// fallback state machine so CONNECTED→DEGRADED→RECONNECTING→{CONNECTED,
// FAILED} transitions are observable at runtime. Before this wiring,
// onFallbackStateChange had zero subscribers and every state transition
// was silent. UI/SSE/monitoring integration is T2 scope — this is the
// T1 minimum subscriber.
//
// CTO 16:31 refinement: STATE_FAILED uses a distinct `[TERMINAL]` log
// format so ops-facing grep can separate transient degraded→reconnecting
// noise from permanent terminal failures that require human escalation.
// The runbook greps for "External intervention required" as the canary.
import {
  onFallbackStateChange,
  STATE_FAILED as _FB_STATE_FAILED,
} from './pty-fallback-state-machine.mjs';

export { resetDaemonEscalation } from './pty-watchdog.mjs';
// BUG 3 FIX (Phase 4-T1): re-export the lost-agent respawn subscription
// hook so the process-manager / spawn-pty-via-daemon layer can subscribe
// via a single import path. See pty-watchdog.mjs for Option A semantics.
export { onAgentsNeedRespawn } from './pty-watchdog.mjs';
// Round 3 Appendix (double-respawn dedupe): re-export the dedupe wrapper
// so index.mjs can route its onAgentsNeedRespawn listener body through
// the same in-flight Set used by the watchdog's injected-fn path. Until
// the follow-up one-line edit in index.mjs lands, Path 1 (the listener)
// runs unguarded and relies on pm.startAgent's own idempotency; Path 2
// (the injected _restartAgentFn loop in requestAgentRestarts) is fully
// deduped via claimRestartBatch / releaseRestartClaims inside the
// watchdog module.
export {
  dedupeRestartAgent,
  claimRestartBatch,
  releaseRestartClaims,
  getRestartingAgents,
} from './pty-watchdog.mjs';

// ROUND 3 Item 3: module-level logger subscriber. Subscribed exactly
// once per process on module import. The FSM's internal EventEmitter
// already has setMaxListeners(0) so this won't hit the listener cap.
//
// CTO 16:31 refinement + 16:40 version-(b) wording: STATE_FAILED gets a
// distinct `[TERMINAL]` log line so operators grepping for unrecoverable
// failures have a dedicated anchor. The message is ops-centric ("Daemon
// unreachable" describes the user-visible consequence, not FSM internal
// state) and enumerates the three intervention paths directly from the
// runbook. Exact wording must not drift — runbook greps rely on
// "Daemon unreachable", "External intervention required", and the
// explicit intervention enumeration as canary substrings.
//
// The handler is exposed as a named export (`_fallbackStateLogger`)
// so unit tests can exercise the exact branch logic without relying on
// the module-level subscription surviving a beforeEach resetForTest()
// call (which removes all listeners from the FSM emitter).
export function _fallbackStateLogger({ prev, next, reason }) {
  if (next === _FB_STATE_FAILED) {
    console.error(
      '[FALLBACK_STATE][TERMINAL] Daemon unreachable after 5 reconnect attempts (~15m30s). External intervention required: manual daemon restart / resetDaemonEscalation / watchdog escalation. See T2 backlog "Configurable FALLBACK_RECONNECT_MAX_ATTEMPTS + auto-recovery".'
    );
  } else {
    console.error(
      '[FALLBACK_STATE] %s → %s reason=%s',
      prev,
      next,
      reason || 'unknown',
    );
  }
}

onFallbackStateChange(_fallbackStateLogger);

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────

const DAEMON_READY_TIMEOUT  = 5000;   // max wait for daemon IPC ready (ms)
const DAEMON_READY_INTERVAL = 500;    // retry interval (ms)
const DAEMON_SCRIPT = join(__dirname, 'pty-daemon.mjs');

// ── H3: env sanitization allow-list ────────────────────────
// Symmetric to the daemon-side C1 env allow-list. Only these keys are
// copied from process.env into the daemon child env. Explicit injection
// of daemon-specific flags (TEAMMCP_DAEMON, TEAMMCP_HOME) happens in
// buildSanitizedDaemonEnv() below. Code-injection vectors
// (NODE_OPTIONS, NODE_PATH, LD_PRELOAD, DYLD_*, PYTHON*) are deliberately
// excluded even when present in the parent env.
const DAEMON_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LANG', 'TERM', 'PWD', 'TEMP', 'TMP', 'USERPROFILE',
]);

function buildSanitizedDaemonEnv(isDev) {
  const sanitized = {};
  for (const key of DAEMON_ENV_KEYS) {
    if (process.env[key] !== undefined) sanitized[key] = process.env[key];
  }
  // Explicit daemon-specific flags (NOT copied from the allow-list loop
  // because they're not in it).
  sanitized.TEAMMCP_DAEMON = '1';
  sanitized.TEAMMCP_DAEMON_DEV = isDev ? '1' : '0';
  if (process.env.TEAMMCP_HOME !== undefined) {
    sanitized.TEAMMCP_HOME = process.env.TEAMMCP_HOME;
  }
  // teammcp needs AGENTS_BASE_DIR for cwd allowlist (agents live outside project tree)
  if (process.env.AGENTS_BASE_DIR !== undefined) {
    sanitized.AGENTS_BASE_DIR = process.env.AGENTS_BASE_DIR;
  }
  return sanitized;
}

// ── Launcher observability stats ───────────────────────────
// NOTE: these live in the launcher module (not pty-watchdog) because they
// describe *launcher-side* events (spawn, pid lock, identity challenge).
// The resume message permits either location; keeping them here avoids
// cross-module coupling with the watchdog's respawn stats. getLauncherStats
// is re-exported from pty-watchdog.mjs as a convenience for callers that
// already import from there.
const _launcherStats = {
  spawned: 0,
  identityVerified: 0,
  identitySkipped: 0,
  pidLockConflict: 0,
  impersonationAborted: 0,
};

export function getLauncherStats() {
  return { ..._launcherStats };
}

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

// BUG 1 FIX (Phase 4-T1): writePidFile was removed from the launcher
// initially because the daemon's own main() at pty-daemon.mjs:720 is the
// authoritative pid file writer.
//
// H4 UPDATE: the launcher now performs an *atomic pid-file reservation*
// via `fs.openSync(pidFile, 'wx', 0o600)` BEFORE spawning the daemon.
// The reservation writes the launcher's intent to spawn (and is
// immediately followed by the actual spawn). The daemon's main() will
// still overwrite this with its own pid — which is expected and harmless
// because the daemon's checkExistingDaemon() reads the pid file and, if
// it matches its own pid (via process.kill(pid,0) heuristic against
// process.pid), allows overwrite. See Bug 1 comment at pty-daemon.mjs
// for the self-match semantics.
//
// BUG 1 INVARIANT still holds: we never write the *child*'s pid from
// the launcher into the file. We only write a SENTINEL (launcher's own
// pid, flagged with a newline prefix `#launcher-reservation`) to claim
// the file briefly, then let the daemon take over.

function reservePidFileAtomic(isDev) {
  const pidPath = getPidFilePath(isDev);
  const dir = dirname(pidPath);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {}

  // Attempt exclusive create.
  try {
    const fd = openSync(pidPath, 'wx', 0o600);
    // Write a non-numeric reservation marker. The daemon's writePidFile
    // (pty-daemon.mjs:49) overwrites this with a plain numeric pid on
    // startup. Until then, readPidFile() will parseInt() this string and
    // get NaN → null, which safely triggers the fresh-spawn path.
    const marker = `#launcher-reservation pid=${process.pid} t=${Date.now()}\n`;
    writeSync(fd, marker);
    closeSync(fd);
    return { reserved: true, staleOwner: null };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // File exists → is it a live daemon's pid file, or a stale lock?
  const existingPid = readPidFile(isDev);
  if (existingPid && isProcessAlive(existingPid)) {
    _launcherStats.pidLockConflict++;
    console.error(
      `[LAUNCHER] existing daemon pid=${existingPid} still alive, refusing to spawn`
    );
    return { reserved: false, staleOwner: existingPid };
  }

  // Stale lock (file exists but either unparseable or dead pid). Unlink
  // and retry exactly once.
  try { unlinkSync(pidPath); } catch {}
  try {
    const fd = openSync(pidPath, 'wx', 0o600);
    const marker = `#launcher-reservation pid=${process.pid} t=${Date.now()}\n`;
    writeSync(fd, marker);
    closeSync(fd);
    return { reserved: true, staleOwner: existingPid || null };
  } catch (err2) {
    _launcherStats.pidLockConflict++;
    console.error(`[LAUNCHER] pid file reservation failed twice: ${err2.message}`);
    return { reserved: false, staleOwner: existingPid || null };
  }
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

let _currentDaemonChild = null;
let _watchdogRestartAgent = null;
let _watchdogNotify = null;
let _watchdogSetState = null;

// H5: current daemon's identity token — held only until HMAC verification
// of the first-client probe succeeds, then cleared. NEVER logged, NEVER
// written to disk. Module-scoped closure, not exported.
let _currentIdentityToken = null;

function spawnDaemon(isDev) {
  // H3: sanitized env (allow-list only).
  const sanitizedEnv = buildSanitizedDaemonEnv(isDev);

  // H5: generate identity token BEFORE spawn so it's ready to write on stdin.
  // 32 random bytes → 64-char hex string. Use randomBytes (CSPRNG).
  const identityToken = randomBytes(32).toString('hex');

  // H4: stdin changes from 'ignore' to 'pipe' so we can write the
  // identity token into the child's stdin before it reaches main().
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    env: sanitizedEnv,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  _currentDaemonChild = child;
  _currentIdentityToken = identityToken;
  _launcherStats.spawned++;
  console.error(
    `[LAUNCHER] daemon spawned with sanitized env, keys=${Object.keys(sanitizedEnv).length}`
  );

  // H5: send identity token via stdin immediately, then close the pipe
  // so the daemon stops waiting after one read. Best-effort — if stdin
  // write fails (e.g. daemon crashed during boot), we fall back to the
  // soft-fail path in the HMAC challenge step.
  try {
    child.stdin.write(identityToken + '\n');
    child.stdin.end();
  } catch (err) {
    console.error('[LAUNCHER] identity token stdin write failed:', err.message);
    // Leave _currentIdentityToken set; the challenge will soft-fail.
  }
  // Note: strings in JS are immutable so true memory zeroing is not
  // possible. We rely on GC + the short lifetime (cleared after the
  // challenge succeeds or fails).

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
    _currentDaemonChild = null;
    _currentIdentityToken = null;
    // Phase 4-T1 watchdog: bounded respawn on unexpected exit.
    if (code !== 0 && !_shuttingDown) {
      _attemptWatchdogRespawn(isDev).catch((err) => {
        console.error('[daemon-launcher] Watchdog respawn failed:', err.message);
      });
    }
  });

  child.unref();

  // BUG 1 FIX (Phase 4-T1): do NOT write the daemon's numeric pid here.
  // The daemon's own main() at pty-daemon.mjs:720 is the authoritative
  // writer. H4 atomic reservation (reservePidFileAtomic, called from
  // ensureDaemon before this function) holds a sentinel that the
  // daemon's writePidFile will overwrite on boot.
  console.log(`[daemon-launcher] Daemon spawned (PID: ${child.pid})`);

  return child.pid;
}

// ── H5: first-client HMAC identity challenge ──────────────
//
// COORDINATION ASSUMPTIONS with the pty-daemon hardening subagent
// (daemon-side owns the other end of this handshake):
//
//   • Daemon reads the identity token as the FIRST line of stdin,
//     terminated by '\n'. Any subsequent stdin data is ignored.
//   • RPC method name: `identity.challenge`
//   • Launcher-side request params:  { clientNonce: <32-hex-chars> }
//   • Daemon-side response result:   { daemonNonce: <32-hex-chars>,
//                                      mac: <64-hex-chars> }
//   • HMAC formula:
//       mac = HMAC-SHA256(
//               key   = Buffer.from(identityToken, 'hex'),     // 32 bytes
//               data  = Buffer.from(clientNonce + daemonNonce, 'utf-8'),
//             ).toString('hex')
//     The key is the raw 32-byte decoding of the hex token, NOT the
//     ASCII hex string. Document this so both sides hash identically.
//   • Protocol framing: NDJSON, one JSON object per line, exactly as
//     used by the main pty-daemon-ipc server. No handshake / pipe-token
//     required for the challenge request — the daemon must accept
//     `identity.challenge` on a fresh connection, BEFORE the pipe-token
//     handshake.
//
// SOFT-FAIL contract (backward compat):
//   If the daemon does not respond within `IDENTITY_CHALLENGE_TIMEOUT_MS`,
//   or responds with a JSON-RPC error, or returns a malformed result,
//   the launcher logs a warning and proceeds without verification.
//   Only an AFFIRMATIVE MAC MISMATCH causes the launcher to abort.

const IDENTITY_CHALLENGE_TIMEOUT_MS = 2000;

async function verifyDaemonIdentity(isDev, identityToken) {
  if (!identityToken) {
    _launcherStats.identitySkipped++;
    console.warn('[LAUNCHER] no identity token available, skipping verification');
    return { verified: false, mismatch: false, reason: 'no_token' };
  }

  return new Promise((resolvePromise) => {
    const ipcPath = getIpcPath(isDev);
    const clientNonce = randomBytes(16).toString('hex'); // 32 hex chars

    let buffer = '';
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      clearTimeout(timer);
      resolvePromise(outcome);
    };

    const timer = setTimeout(() => {
      _launcherStats.identitySkipped++;
      console.warn(
        '[LAUNCHER] daemon did not respond to identity challenge, ' +
        'skipping verification (legacy daemon)'
      );
      finish({ verified: false, mismatch: false, reason: 'timeout' });
    }, IDENTITY_CHALLENGE_TIMEOUT_MS);

    let sock;
    try {
      sock = createConnection(ipcPath);
    } catch (err) {
      clearTimeout(timer);
      _launcherStats.identitySkipped++;
      console.warn('[LAUNCHER] identity challenge connect failed:', err.message);
      resolvePromise({ verified: false, mismatch: false, reason: 'connect_failed' });
      return;
    }

    sock.on('connect', () => {
      const req = {
        jsonrpc: '2.0',
        id: 1,
        method: 'identity.challenge',
        params: { clientNonce },
      };
      try {
        sock.write(JSON.stringify(req) + '\n');
      } catch (err) {
        finish({ verified: false, mismatch: false, reason: 'write_failed' });
      }
    });

    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 1) continue;

        if (msg.error) {
          // Legacy daemon that doesn't know identity.challenge — soft-fail.
          _launcherStats.identitySkipped++;
          console.warn(
            '[LAUNCHER] daemon did not respond to identity challenge, ' +
            `skipping verification (legacy daemon; code=${msg.error.code})`
          );
          finish({ verified: false, mismatch: false, reason: 'legacy_daemon' });
          return;
        }

        const result = msg.result || {};
        const { daemonNonce, mac } = result;
        if (typeof daemonNonce !== 'string' || typeof mac !== 'string') {
          _launcherStats.identitySkipped++;
          console.warn('[LAUNCHER] malformed identity.challenge response, skipping');
          finish({ verified: false, mismatch: false, reason: 'malformed' });
          return;
        }

        // Compute expected MAC using the SAME formula the daemon uses.
        let expected;
        try {
          const keyBuf = Buffer.from(identityToken, 'hex');
          expected = createHmac('sha256', keyBuf)
            .update(Buffer.from(clientNonce + daemonNonce, 'utf-8'))
            .digest('hex');
        } catch (err) {
          _launcherStats.identitySkipped++;
          console.warn('[LAUNCHER] HMAC compute failed:', err.message);
          finish({ verified: false, mismatch: false, reason: 'hmac_error' });
          return;
        }

        // Timing-safe comparison (both strings, same length).
        let match = false;
        try {
          const a = Buffer.from(mac, 'hex');
          const b = Buffer.from(expected, 'hex');
          match = a.length === b.length && timingSafeEqual(a, b);
        } catch {
          match = false;
        }

        if (match) {
          _launcherStats.identityVerified++;
          console.log('[LAUNCHER] identity HMAC verified');
          finish({ verified: true, mismatch: false, reason: 'verified' });
        } else {
          _launcherStats.impersonationAborted++;
          console.error(
            '[LAUNCHER][NB4][INTERIM] identity HMAC verification failed, ' +
            'daemon may be impersonated, aborting'
          );
          finish({ verified: false, mismatch: true, reason: 'mac_mismatch' });
        }
        return;
      }
    });

    sock.on('error', (err) => {
      // Don't log spam: EPIPE / ECONNRESET on a dying socket is expected
      // if the daemon doesn't support identity.challenge cleanly.
      _launcherStats.identitySkipped++;
      console.warn('[LAUNCHER] identity challenge socket error:', err.message);
      finish({ verified: false, mismatch: false, reason: 'socket_error' });
    });
  });
}

let _shuttingDown = false;

async function _attemptWatchdogRespawn(isDev) {
  if (_shuttingDown) return;
  const decision = recordRespawn();
  if (!decision.allowed) {
    console.error('[daemon-launcher] Watchdog respawn denied:', decision);
    return;
  }
  console.log(`[daemon-launcher] Watchdog respawning daemon (remaining=${decision.remaining})`);

  // H4: re-reserve the pid file atomically before respawn. Normally the
  // child.on('exit') handler already removed the file, so reservation
  // should succeed; on a race we refuse.
  const lockResult = reservePidFileAtomic(isDev);
  if (!lockResult.reserved) {
    console.error(
      `[daemon-launcher] Watchdog respawn: PID lock conflict (owner=${lockResult.staleOwner})`
    );
    return;
  }

  spawnDaemon(isDev);
  const identityTokenForVerify = _currentIdentityToken;

  // H5: identity-verify the respawned daemon with the same contract as
  // the cold-boot path. Wait briefly for the new daemon's pipe, then
  // verify. A hard mismatch aborts the respawn cycle.
  const idStart = Date.now();
  while (Date.now() - idStart < 2000) {
    try {
      await new Promise((res, rej) => {
        const s = createConnection(getIpcPath(isDev));
        s.once('connect', () => { s.destroy(); res(); });
        s.once('error', (e) => { s.destroy(); rej(e); });
      });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  let idOut = { verified: false, mismatch: false };
  try {
    idOut = await verifyDaemonIdentity(isDev, identityTokenForVerify);
  } catch (err) {
    console.warn('[LAUNCHER] respawn verifyDaemonIdentity threw:', err.message);
  }
  _currentIdentityToken = null;
  if (idOut.mismatch) {
    console.error('[LAUNCHER] respawned daemon failed identity verification; killing child');
    try { _currentDaemonChild?.kill('SIGKILL'); } catch {}
    _currentDaemonChild = null;
    removePidFile(isDev);
    return;
  }

  const ready = await waitForDaemonReady(isDev);
  if (!ready) {
    console.error('[daemon-launcher] Respawned daemon failed to become ready');
    return;
  }
  // After reconnect, reconcile agents: pty.list returns empty → lost handles.
  // process-manager holds the authoritative list of tracked agents; the
  // watchdog just asks it to restart each via requestAgentRestarts.
  try {
    const { listPtys } = await import('./pty-daemon-client.mjs');
    const live = await listPtys();
    const liveAgents = new Set((live?.handles || live?.agents || []).map(h => h.agent || h.agentId));
    const tracked = (globalThis.__ptyTrackedAgents?.() || []);
    const lost = tracked.filter(a => !liveAgents.has(a));
    if (lost.length > 0) {
      console.log(`[daemon-launcher] Handing ${lost.length} lost agent(s) to watchdog for respawn:`, lost);
      await requestAgentRestarts(lost);
    }
  } catch (err) {
    console.error('[daemon-launcher] Post-respawn reconciliation failed:', err.message);
  }
}

/**
 * Mark the daemon as being shut down intentionally so the watchdog skips
 * the respawn path.
 */
export function markDaemonShuttingDown() {
  _shuttingDown = true;
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
/**
 * Initialize the watchdog with external dependencies (db.setState,
 * process-manager.startAgent, sse.pushToAgents). Called once by index.mjs
 * at startup after those modules are loaded. Must happen before the first
 * daemon crash so the watchdog can respawn agents end-to-end.
 */
export function initDaemonWatchdog({ setState, restartAgent, notify }) {
  initWatchdog({ setState, restartAgent, notify });
}

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

  // H4 Step 1.5: atomic PID-file reservation. On a race where another
  // launcher instance holds the file, refuse to spawn.
  const lockResult = reservePidFileAtomic(isDev);
  if (!lockResult.reserved) {
    console.error(
      `[daemon-launcher] PID lock conflict (existing owner=${lockResult.staleOwner}); aborting spawn`
    );
    return { connected: false, spawned: false, pid: lockResult.staleOwner || null };
  }

  // Step 2: Spawn new daemon
  const pid = spawnDaemon(isDev);
  const identityTokenForVerify = _currentIdentityToken;

  // H5 Step 2.5: before trusting the daemon, verify its identity via an
  // HMAC challenge on a raw IPC probe. Any affirmative mismatch aborts
  // the launch. Any soft-fail (timeout, malformed, legacy daemon) logs
  // a warning and proceeds.
  //
  // We wait briefly for the daemon's IPC pipe to become listenable
  // before the challenge. Use a short internal poll — the main
  // waitForDaemonReady loop still runs after this.
  let identityOutcome = { verified: false, mismatch: false, reason: 'not_attempted' };
  const idStart = Date.now();
  while (Date.now() - idStart < 2000) {
    // Quick reachability probe: try to connect once. If it fails, wait.
    try {
      await new Promise((res, rej) => {
        const s = createConnection(getIpcPath(isDev));
        s.once('connect', () => { s.destroy(); res(); });
        s.once('error', (e) => { s.destroy(); rej(e); });
      });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try {
    identityOutcome = await verifyDaemonIdentity(isDev, identityTokenForVerify);
  } catch (err) {
    console.warn('[LAUNCHER] verifyDaemonIdentity threw:', err.message);
    _launcherStats.identitySkipped++;
  }
  // H5: clear the identity token from launcher memory after the
  // challenge — regardless of outcome. The only consumer was the
  // verification step; holding it longer is a needless secret.
  _currentIdentityToken = null;

  if (identityOutcome.mismatch) {
    // HARD abort: kill the child, clean up, return failure.
    try { _currentDaemonChild?.kill('SIGKILL'); } catch {}
    _currentDaemonChild = null;
    removePidFile(isDev);
    return { connected: false, spawned: true, pid, impersonated: true };
  }

  // Step 3: Wait for IPC ready
  const ready = await waitForDaemonReady(isDev);
  if (!ready) {
    console.error('[daemon-launcher] Daemon failed to become ready within timeout');
    return { connected: false, spawned: true, pid };
  }

  return {
    connected: true,
    spawned: true,
    pid,
    identityVerified: identityOutcome.verified,
    identitySkipped: !identityOutcome.verified && !identityOutcome.mismatch,
  };
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
