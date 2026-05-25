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
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { join, basename as pathBasename, resolve as pathResolve, isAbsolute as pathIsAbsolute, sep as pathSep } from 'node:path';
import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createIPCServer } from './pty-daemon-ipc.mjs';
import { writeDaemonToken } from './pipe-token.mjs';
import {
  INITIAL_CREDIT,
  PENDING_QUEUE_BOUND,
  SPAWN_IDEMPOTENCY_FAILED_GC_MS,
  ERR_SPAWN_FAILED,
  ERR_HANDLE_NOT_FOUND,
  ERR_INVALID_PARAMS,
} from './ipc-protocol.mjs';

const isWindows = platform() === 'win32';

// ── Phase 4-T1 hardening: env / cmd / args / cwd allow-lists ───
//
// CTO final spec (16:09). These supersede the earlier, smaller allow-lists.
//
// C1: env allow-list. Daemon-uid RCE via env vars is mitigated by refusing
// to forward arbitrary keys from the client. Only this whitelist is
// propagated from the daemon's own env, and the client may override those
// specific keys — nothing else. Additional per-value constraints: string
// type, <=4096 bytes, total keys <=64.
const ENV_ALLOW_LIST = Object.freeze(new Set([
  'PATH', 'HOME', 'USER', 'USERPROFILE',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'TERM', 'TZ', 'PWD', 'TMPDIR', 'TEMP', 'TMP',
  // Windows path resolution for claude.cmd / claude.exe and any
  // sub-spawn the agent does. Without APPDATA/LOCALAPPDATA the
  // claude.cmd shim still resolves (npm bin sits on PATH) but the
  // CLI itself reads ~/.claude under the profile and breaks.
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMDATA', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
  'PROCESSOR_ARCHITECTURE',
  // TeamMCP agent bootstrap — process-manager-impl-win.mjs injects
  // these for every agent. AGENT_NAME tells the agent which row in
  // the agents table it is; TEAMMCP_URL/_KEY are how its MCP client
  // reaches back into the server.
  'AGENT_NAME', 'TEAMMCP_URL', 'TEAMMCP_KEY',
  // Claude Code runtime config. CLAUDE_CONFIG_DIR is per-agent
  // isolation — without it every agent collapses onto ~/.claude
  // and steps on each other's sessions.
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Anthropic API-key auth mode. Path-A OAuth agents don't need
  // these but api_key agents do; the daemon doesn't distinguish.
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
]));

// Prefix blacklist — any key STARTING WITH one of these is rejected even if
// it is in the allow-list (defense in depth; none of the allow-list entries
// share these prefixes, so it's effectively just a second barrier).
const ENV_REJECT_PREFIXES = Object.freeze([
  'NODE_',            // NODE_OPTIONS, NODE_PATH, NODE_REPL_HISTORY, ...
  'LD_',              // Linux dynamic loader
  'DYLD_',            // macOS dynamic loader
  'PYTHON',           // PYTHONPATH, PYTHONSTARTUP, PYTHONHOME, ...
  'RUBYOPT',          // Ruby code injection
  'PERL',             // PERL5LIB, PERL5OPT, PERLLIB, ...
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'PATHEXT',          // Windows exec extension hijack
  'ComSpec',          // Windows shell override
]);

const ENV_VALUE_MAX_BYTES = 4096;
const ENV_MAX_KEYS = 64;

// C2: cmd basename allow-list (CTO final).
// Note: cmd.exe is allow-listed literally. The sanitizer treats Windows .exe
// suffixes specially: for 'node.exe' we also accept 'node'; for 'cmd.exe'
// the basename check looks for the literal 'cmd.exe' OR 'cmd'.
const CMD_BASENAME_ALLOWLIST = Object.freeze(new Set([
  'claude', 'node',
  'bash', 'sh', 'zsh',
  'pwsh', 'powershell', 'cmd.exe', 'cmd',
  'python', 'python3',
]));

// Which basenames count as "interactive shell" — if the caller asks to
// spawn one of these, we require an empty args array.
const SHELL_BASENAMES = Object.freeze(new Set([
  'bash', 'sh', 'zsh', 'pwsh', 'powershell',
]));

// C2: forbidden argument flags. -c / --command is in the list because
// any shell usage with -c means "execute a command string", which is
// exactly what we want to block. Non-shell interpreters (node, python)
// use -c too for eval-ish uses, so we block it globally.
const ARGS_FORBIDDEN_FLAGS = Object.freeze(new Set([
  '-e', '--eval',
  '-c', '--command',
  '-r', '--require',
  '--inspect', '--inspect-brk',
  '-i', '--interactive',
  '-p', '--print',
]));

// C2: shell meta-characters — if any arg contains these, refuse. This is
// defense in depth; we force shell:false at spawn anyway. Added \r and \\
// per CTO final.
const SHELL_META_REGEX = /[;|&`$()<>\n\r\\]/;

const ARGS_MAX_COUNT = 100;
const ARG_VALUE_MAX_BYTES = 4096;

// Sub3-A: idempotency map cap.
const SPAWN_IDEMPOTENCY_MAX_ENTRIES = 1024;
const SPAWN_IDEMPOTENCY_TTL_MS = 60 * 1000;

// Sub3-B: write cap.
const WRITE_DATA_MAX_BYTES = 65536;

// Sub3-D: reattach replay byte cap.
const REATTACH_REPLAY_MAX_BYTES = 1_048_576;

// ── Phase 4-T1: minimal local rate limiter for hardening logs ──
//
// 10 lines/sec cap. Overflow is counted and a single summary line is
// emitted each time the budget resets. Prevents log flood from masking
// real attacks.
let _logBudget = 10;
let _logBudgetResetAt = Date.now() + 1000;
let _logSuppressed = 0;
function _rateLimitLog(level, fmt, ...args) {
  const now = Date.now();
  if (now >= _logBudgetResetAt) {
    _logBudget = 10;
    _logBudgetResetAt = now + 1000;
    if (_logSuppressed > 0) {
      console.error('[SPAWN-HARDEN] suppressed=%d', _logSuppressed);
      spawnStats.logSuppressed += _logSuppressed;
      _logSuppressed = 0;
    }
  }
  if (_logBudget > 0) {
    _logBudget--;
    console[level](fmt, ...args);
  } else {
    _logSuppressed++;
  }
}

// ── Phase 4-T1: spawn hardening observability counters (CTO final 16:13) ──
// Counter names follow CTO's harness contract — do not rename.
const spawnStats = {
  accepted: 0,
  rejectedEnvNotAllowed: 0,         // env key not allow-listed / prefix-rejected
  rejectedEnvValue: 0,              // non-string / oversized / too-many-keys
  rejectedCmdNotAbsolute: 0,        // cmd not absolute path
  rejectedCmdNotExists: 0,          // realpath failure (file doesn't exist)
  rejectedCmdNotInAllowlist: 0,     // canonical path not in resolved allow-list
  rejectedCmdNotFile: 0,            // canonical path is a directory / special
  rejectedShellWithArgs: 0,         // bash/sh/zsh/pwsh called with non-empty args
  rejectedArgsBlocked: 0,           // forbidden flag OR shell metachar
  rejectedArgsOversize: 0,          // arg count / byte length cap
  rejectedCwdOutOfTree: 0,          // cwd escapes project root
  rejectedCwdDotDot: 0,
  rejectedSpawnTransaction: 0,      // Sub3-C rollback-on-failure
  rejectedOwnershipMismatch: 0,
  rejectedInvalidReplayBytes: 0,    // Sub3-D
  rejectedWriteOversized: 0,        // Sub3-B
  idempotencyEvicted: 0,            // Sub3-A
  logSuppressed: 0,
};

export function getSpawnStats() {
  return { ...spawnStats };
}

export function _resetSpawnStatsForTest() {
  for (const k of Object.keys(spawnStats)) spawnStats[k] = 0;
}

// ── Phase 4-T1: env / cmd / args / cwd sanitizers (CTO final) ──

function _rejectSpawn(message, codeTag = ERR_SPAWN_FAILED) {
  const err = new Error(message);
  err.code = 'SPAWN_REJECTED';
  err.ipcCode = codeTag;
  return err;
}

// ── Cat D-1: POSIX env-identifier regex ────────────────────────
// Env keys must be ASCII, start with letter/underscore, then
// letter/digit/underscore only. Anything else — Unicode, hyphens,
// dots, spaces — gets rejected before the allow-list check even runs.
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Cat D-3: args control-char / null-byte regex ───────────────
// Reject NUL plus any C0 control char except \t \r \n. \x7f (DEL)
// is also rejected — no legitimate arg ever needs it.
// eslint-disable-next-line no-control-regex
const ARGS_BAD_CTRL_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// ── Cat E-1: Windows UNC / device-namespace detection ──────────
// Matches \\?\... (NT namespace), \\.\... (device namespace),
// \\server\share (UNC network path). None are permitted — they
// bypass normal path resolution and can reference raw devices or
// network shares the daemon has no business touching.
function _isWindowsUNC(p) {
  if (!isWindows) return false;
  if (typeof p !== 'string' || p.length < 2) return false;
  // Normalize forward-slashes too: //?/ and //./  are equivalent on Win32.
  const head = p.slice(0, 4);
  if (head === '\\\\?\\' || head === '\\\\.\\' || head === '//?/' || head === '//./') return true;
  // Plain UNC (\\server\share or //server/share) — two leading separators
  // followed by a non-separator character.
  if ((p[0] === '\\' || p[0] === '/') && (p[1] === '\\' || p[1] === '/')) {
    const c = p[2];
    if (c && c !== '\\' && c !== '/') return true;
  }
  return false;
}

// ── Cat E-2: Windows drive-relative detection ─────────────────
// "C:evil" (no separator after the drive letter) means "evil on the
// current working directory of drive C:", which is NOT the same as
// "C:\\evil" even though path.isAbsolute() returns true for it.
function _isWindowsDriveRelative(p) {
  if (!isWindows) return false;
  if (typeof p !== 'string' || p.length < 3) return false;
  // Letter, colon, then anything OTHER than \ or /.
  return /^[A-Za-z]:[^\\/]/.test(p);
}

function _isRejectedEnvPrefix(key) {
  for (const prefix of ENV_REJECT_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * C1: sanitize an env object from a client into a safe env to pass to
 * pty.spawn. Output is a fresh object built key-by-key from the allow-list
 * — this automatically blocks __proto__, NODE_*, LD_*, DYLD_*, PYTHON*, etc.
 *
 * Additional constraints (CTO final):
 *   - each value typeof 'string'
 *   - each value <=4096 bytes
 *   - total client keys <=64 (reject whole env if exceeded)
 */
export function sanitizeEnv(clientEnv) {
  const out = {};
  // Start from daemon's own env, copying only whitelisted keys.
  for (const key of ENV_ALLOW_LIST) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      const v = process.env[key];
      if (typeof v === 'string') out[key] = v;
    }
  }
  if (!clientEnv || typeof clientEnv !== 'object') {
    return out;
  }
  const clientKeys = Object.keys(clientEnv);
  if (clientKeys.length > ENV_MAX_KEYS) {
    spawnStats.rejectedEnvValue++;
    _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected env reason=%s count=%d',
      'too_many_keys', clientKeys.length);
    throw _rejectSpawn(`too many env keys: ${clientKeys.length}`);
  }
  // Overlay client-supplied keys, rejecting anything outside the allow-list
  // or matching a known-dangerous prefix.
  for (const key of clientKeys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      spawnStats.rejectedEnvNotAllowed++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected env key=%s reason=%s', key, 'prototype_pollution');
      continue;
    }
    // Cat D-1: POSIX env-identifier shape. Rejects Unicode, hyphens,
    // dots, and any key not matching [A-Za-z_][A-Za-z0-9_]*.
    if (typeof key !== 'string' || !ENV_KEY_REGEX.test(key)) {
      spawnStats.rejectedEnvNotAllowed++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected env key=%j reason=%s', key, 'bad_key_shape');
      continue;
    }
    if (!ENV_ALLOW_LIST.has(key)) {
      spawnStats.rejectedEnvNotAllowed++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected env key=%s reason=%s', key, 'not_in_allowlist');
      continue;
    }
    if (_isRejectedEnvPrefix(key)) {
      spawnStats.rejectedEnvNotAllowed++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected env key=%s reason=%s', key, 'prefix_rejected');
      continue;
    }
    const v = clientEnv[key];
    if (typeof v !== 'string') {
      spawnStats.rejectedEnvValue++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected env key=%s reason=%s', key, 'non_string_value');
      continue;
    }
    if (Buffer.byteLength(v, 'utf8') > ENV_VALUE_MAX_BYTES) {
      spawnStats.rejectedEnvValue++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected env key=%s reason=%s', key, 'value_too_large');
      continue;
    }
    out[key] = v;
  }
  return out;
}

// ── C2 canonical-path cache (CTO 16:13) ───────────────────────
//
// At daemon startup we resolve each allow-listed binary NAME to its
// real absolute path via `which`/`where` (plus `process.execPath` for
// node) and cache the result as an immutable Set. `sanitizeCmd` then
// requires `realpathSync(cmd)` to be in that cache — no basename match,
// no /tmp/bash bypass.
const _ALLOWED_CMD_LOOKUP_NAMES = [
  'claude', 'node',
  'bash', 'sh', 'zsh',
  'pwsh', 'powershell', 'cmd.exe',
  'python', 'python3',
];

export function resolveAllowedCmdPaths() {
  const resolved = new Set();
  const isWin = platform() === 'win32';
  const lookupCmd = isWin ? 'where' : 'which';

  // node: process.execPath is always absolute and always ours.
  try { resolved.add(realpathSync(process.execPath)); } catch {}

  // All other names: best-effort lookup. `claude` is *required* in
  // production but in test harnesses it is often absent — we therefore
  // warn (not exit) if it is missing and let tests stub the cache.
  // Windows: `where` returns ALL matches (including .cmd / .exe variants).
  // Unix: `which` returns one path. We add ALL lines to handle Windows
  // npm-installed CLIs whose canonical path is the .cmd shim.
  for (const name of _ALLOWED_CMD_LOOKUP_NAMES) {
    try {
      const out = execSync(`${lookupCmd} ${name}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      for (const line of out.split(/\r?\n/)) {
        const p = line.trim();
        if (!p) continue;
        try { resolved.add(realpathSync(p)); } catch { resolved.add(p); }
      }
    } catch {
      // Optional binary missing on this host. Do not fatal; just note.
      _rateLimitLog('log', '[SPAWN-HARDEN] optional cmd not found, skipping: %s', name);
    }
  }

  // Env override: TEAMMCP_CMD_ALLOWLIST_EXTRA (colon/semicolon separated
  // absolute paths). Useful for dev and for CI test harnesses that need
  // to whitelist e.g. /usr/bin/ls.
  const extra = process.env.TEAMMCP_CMD_ALLOWLIST_EXTRA;
  if (extra) {
    const sep = isWin ? ';' : ':';
    for (const p of extra.split(sep)) {
      if (!p) continue;
      try { resolved.add(realpathSync(p)); } catch {}
    }
  }

  return resolved;
}

// Populate the cache eagerly so direct unit-test imports of sanitizeCmd
// still have something to match against. main() re-runs this later to
// pick up any env overrides set after import.
if (!globalThis._allowedCmdAbsolutePaths) {
  try {
    globalThis._allowedCmdAbsolutePaths = resolveAllowedCmdPaths();
  } catch {
    globalThis._allowedCmdAbsolutePaths = new Set();
  }
}

// Test hook: force a specific set of allowed paths (unit tests use this
// to prime the cache with e.g. /bin/sh or the test-host's `node`).
export function _setAllowedCmdPathsForTest(paths) {
  globalThis._allowedCmdAbsolutePaths = new Set(paths);
}

/**
 * C2 (CTO 16:13): resolve and validate a cmd string via the canonical
 * path cache. Basename-only matching is no longer sufficient — we require
 * `realpathSync(cmd)` to be a member of the precomputed cache built at
 * daemon startup from `which/where` lookups.
 */
export function sanitizeCmd(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    throw _rejectSpawn('cmd must be a non-empty string');
  }
  // Cat D-2: NFC normalization. Defeats homoglyph/combining-character
  // attacks where a visually-identical path differs in byte form. We
  // use the normalized string from here on for every downstream check,
  // so the allowlist can never be bypassed via Unicode equivalents.
  try {
    const nfc = cmd.normalize('NFC');
    if (nfc !== cmd) {
      _rateLimitLog('log', '[SPAWN-HARDEN] cmd normalized NFC (input differed from canonical form)');
    }
    cmd = nfc;
  } catch {
    // String.normalize throws only on invalid form arg — unreachable here.
  }
  // Cat E-1: reject Windows UNC / device-namespace paths outright. These
  // bypass normal resolution and point at raw devices or network shares.
  if (_isWindowsUNC(cmd)) {
    spawnStats.rejectedCmdNotAbsolute++;
    _rateLimitLog('error', '[SPAWN-HARDEN] Windows UNC/device path rejected: %s', cmd);
    throw _rejectSpawn('Windows UNC/device namespace path not allowed');
  }
  // Cat E-2: reject Windows drive-relative paths (C:evil). path.isAbsolute
  // returns true for these on Win32, so we need an explicit guard to
  // prevent "C:evil" being treated differently from "C:\\evil".
  if (_isWindowsDriveRelative(cmd)) {
    spawnStats.rejectedCmdNotAbsolute++;
    _rateLimitLog('error', '[SPAWN-HARDEN] Windows drive-relative path rejected: %s', cmd);
    throw _rejectSpawn('Windows drive-relative path not allowed');
  }
  if (!pathIsAbsolute(cmd)) {
    spawnStats.rejectedCmdNotAbsolute++;
    _rateLimitLog('error', '[SPAWN-HARDEN] rejected cmd=%s reason=%s', cmd, 'not_absolute');
    throw _rejectSpawn('cmd must be an absolute path (PATH lookup blocked)');
  }
  let resolved;
  try {
    resolved = realpathSync(cmd);
  } catch (err) {
    spawnStats.rejectedCmdNotExists++;
    _rateLimitLog('error', '[SPAWN-HARDEN] rejected cmd=%s reason=%s', cmd, (err && err.code) || 'realpath_failed');
    throw _rejectSpawn(`cmd does not exist or not accessible: ${cmd}`);
  }
  const cache = globalThis._allowedCmdAbsolutePaths || new Set();
  if (!cache.has(resolved)) {
    spawnStats.rejectedCmdNotInAllowlist++;
    _rateLimitLog('error', '[SPAWN-HARDEN] rejected cmd=%s reason=%s', resolved, 'not_in_allowlist');
    throw _rejectSpawn(`cmd not in allowlist: ${resolved}`);
  }
  let st;
  try {
    st = statSync(resolved);
  } catch {
    spawnStats.rejectedCmdNotExists++;
    throw _rejectSpawn(`cmd stat failed: ${resolved}`);
  }
  if (!st.isFile()) {
    spawnStats.rejectedCmdNotFile++;
    _rateLimitLog('error', '[SPAWN-HARDEN] rejected cmd=%s reason=%s', resolved, 'not_a_file');
    throw _rejectSpawn('cmd is not a regular file');
  }
  return resolved;
}

/**
 * Return the "effective basename" of a cmd for the purposes of shell
 * detection — drops .exe, lowercases. Used to decide whether to enforce
 * the "shell interpreter with zero args" rule.
 */
function _cmdBasenameKey(cmd) {
  const raw = pathBasename(String(cmd)).toLowerCase();
  return raw.endsWith('.exe') ? raw.slice(0, -4) : raw;
}

/**
 * C2: validate an args array. CTO final adds:
 *   - length cap (<=100)
 *   - per-arg byte cap (<=4096)
 *   - if cmd basename is a shell, args MUST be empty
 */
export function sanitizeArgs(args, cmd) {
  if (!Array.isArray(args)) {
    throw _rejectSpawn('args must be an array');
  }
  if (args.length > ARGS_MAX_COUNT) {
    spawnStats.rejectedArgsOversize++;
    _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected args reason=%s count=%d', 'too_many_args', args.length);
    throw _rejectSpawn(`args count exceeds ${ARGS_MAX_COUNT}`);
  }
  // Shell-interpreter rule: bash/sh/zsh/pwsh with non-empty args is a
  // strong signal of -c/script invocation. Reject outright.
  if (cmd != null && args.length > 0) {
    const key = _cmdBasenameKey(cmd);
    if (SHELL_BASENAMES.has(key)) {
      spawnStats.rejectedShellWithArgs++;
      _rateLimitLog('error', '[SPAWN-HARDEN] shell interpreter rejected with non-empty args cmd=%s argc=%d', key, args.length);
      throw _rejectSpawn(`shell interpreter '${key}' must be spawned with no args`);
    }
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw _rejectSpawn('args must contain only strings');
    }
    if (Buffer.byteLength(arg, 'utf8') > ARG_VALUE_MAX_BYTES) {
      spawnStats.rejectedArgsOversize++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected arg reason=%s len=%d', 'arg_too_large', arg.length);
      throw _rejectSpawn('arg value exceeds max byte length');
    }
    // Cat D-3: reject NUL + C0 control chars (except \t \r \n) + DEL.
    // NUL aborts C-string parsing in exec/libc paths and is a classic
    // argv-smuggling vector; other control chars have no legitimate use.
    if (ARGS_BAD_CTRL_REGEX.test(arg)) {
      spawnStats.rejectedArgsBlocked++;
      _rateLimitLog('error', '[SPAWN-HARDEN] rejected arg reason=%s', 'control_char');
      throw _rejectSpawn('arg contains NUL or control character');
    }
    // Cat D-3: UTF-8 round-trip. If the string contains lone surrogates
    // or otherwise fails to re-encode, treat it as malformed input.
    if (Buffer.from(arg, 'utf-8').toString('utf-8') !== arg) {
      spawnStats.rejectedArgsBlocked++;
      _rateLimitLog('error', '[SPAWN-HARDEN] rejected arg reason=%s', 'invalid_utf8');
      throw _rejectSpawn('arg is not valid UTF-8');
    }
    if (ARGS_FORBIDDEN_FLAGS.has(arg)) {
      spawnStats.rejectedArgsBlocked++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected arg=%s reason=%s', arg, 'forbidden_flag');
      throw _rejectSpawn(`forbidden arg flag: ${arg}`);
    }
    if (SHELL_META_REGEX.test(arg)) {
      spawnStats.rejectedArgsBlocked++;
      _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected arg reason=%s', 'shell_meta');
      throw _rejectSpawn('arg contains shell metachar');
    }
  }
  return args;
}

/**
 * C2: validate cwd is inside the daemon's project tree (process.cwd()).
 * Empty/falsy → use process.cwd(). Escape attempts throw.
 *
 * CTO final:
 *   - reject any input containing ".."
 *   - realpathSync the resolved result to defeat symlink escapes
 *   - startsWith check uses path separator so "dir" and "dir-evil" don't collide
 */
export function sanitizeCwd(cwd) {
  if (!cwd) {
    return process.cwd();
  }
  if (typeof cwd !== 'string') {
    throw _rejectSpawn('cwd must be a string');
  }
  // Cat E-1: reject Windows UNC / device-namespace cwd. These can't be
  // inside the project tree by definition and expose device handles.
  if (_isWindowsUNC(cwd)) {
    spawnStats.rejectedCwdOutOfTree++;
    _rateLimitLog('error', '[SPAWN-HARDEN] Windows UNC/device cwd rejected: %s', cwd);
    throw _rejectSpawn('Windows UNC/device namespace cwd not allowed');
  }
  if (cwd.includes('..')) {
    spawnStats.rejectedCwdDotDot++;
    _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected cwd=%s reason=%s', cwd, 'contains_dot_dot');
    throw _rejectSpawn('cwd contains ..');
  }
  let resolved;
  let projectRoot;
  try {
    resolved = realpathSync(pathResolve(cwd));
  } catch {
    // Target doesn't exist on disk — treat as outside the project tree.
    spawnStats.rejectedCwdOutOfTree++;
    _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected cwd=%s reason=%s', cwd, 'realpath_failed');
    throw _rejectSpawn('cwd outside project tree');
  }
  try {
    projectRoot = realpathSync(process.cwd());
  } catch {
    projectRoot = pathResolve(process.cwd());
  }
  // teammcp layout: agents live in AGENTS_BASE_DIR which is sibling to project tree.
  // Add it as a second allowed root so process-manager can spawn agents there.
  const allowedRoots = [projectRoot];
  if (process.env.AGENTS_BASE_DIR) {
    try {
      allowedRoots.push(realpathSync(pathResolve(process.env.AGENTS_BASE_DIR)));
    } catch {
      allowedRoots.push(pathResolve(process.env.AGENTS_BASE_DIR));
    }
  }
  const inAllowed = allowedRoots.some(root =>
    resolved === root || resolved.startsWith(root + pathSep)
  );
  if (!inAllowed) {
    spawnStats.rejectedCwdOutOfTree++;
    _rateLimitLog('error', '[SPAWN-ALLOWLIST] rejected cwd=%s reason=%s', resolved, 'outside_workspace');
    throw _rejectSpawn('cwd outside project tree');
  }
  return resolved;
}

// ── Sub3-D: reattach maxReplayBytes validation ─────────────────
function _sanitizeReplayBytes(maxReplayBytes) {
  // Default if not supplied
  if (maxReplayBytes == null) return 131072;
  if (
    typeof maxReplayBytes !== 'number' ||
    !Number.isInteger(maxReplayBytes) ||
    maxReplayBytes <= 0 ||
    maxReplayBytes > REATTACH_REPLAY_MAX_BYTES
  ) {
    spawnStats.rejectedInvalidReplayBytes++;
    _rateLimitLog('error', '[SPAWN-HARDEN] rejected reattach maxReplayBytes=%s reason=%s',
      String(maxReplayBytes), 'invalid_or_too_large');
    const err = new Error('invalid maxReplayBytes (must be integer in (0, 1048576])');
    err.code = 'INVALID_PARAM';
    err.ipcCode = ERR_INVALID_PARAMS;
    throw err;
  }
  return maxReplayBytes;
}

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

// Map<agentName, { proc, scrollback, cols, rows, startTime, pid, handleId,
//                  seq, credit, cumulativeEmittedBytes, cumulativeAckedBytes,
//                  paused, pendingQueue, exitReason }>
const agents = new Map();
const eventBuffer = new EventBuffer();
const startTime = Date.now();

// clientRequestId → { agentName, handleId, result, failedAt }
// For idempotent spawn retries per spec §1.1 B6.
const spawnIdempotencyMap = new Map();

function gcSpawnIdempotencyMap() {
  const now = Date.now();
  for (const [rid, entry] of spawnIdempotencyMap) {
    if (entry.failedAt && (now - entry.failedAt) > SPAWN_IDEMPOTENCY_FAILED_GC_MS) {
      spawnIdempotencyMap.delete(rid);
      spawnStats.idempotencyEvicted++;
    }
    // Sub3-A: also expire successful entries that have aged past TTL so
    // long-running daemons don't accumulate state forever.
    if (entry.insertedAt && (now - entry.insertedAt) > SPAWN_IDEMPOTENCY_TTL_MS) {
      spawnIdempotencyMap.delete(rid);
      spawnStats.idempotencyEvicted++;
    }
  }
}
setInterval(gcSpawnIdempotencyMap, 60 * 1000).unref?.();

// Sub3-A: bounded insert into the idempotency map. If adding `rid`
// would push us over SPAWN_IDEMPOTENCY_MAX_ENTRIES, evict oldest
// entries first (Map preserves insertion order, so shift the head).
function _putIdempotency(rid, value) {
  if (spawnIdempotencyMap.size >= SPAWN_IDEMPOTENCY_MAX_ENTRIES && !spawnIdempotencyMap.has(rid)) {
    // Evict oldest N entries to make room (batch of 16 to amortize cost).
    let toEvict = 16;
    for (const key of spawnIdempotencyMap.keys()) {
      spawnIdempotencyMap.delete(key);
      spawnStats.idempotencyEvicted++;
      if (--toEvict <= 0) break;
    }
  }
  spawnIdempotencyMap.set(rid, { ...value, insertedAt: Date.now() });
}

// Callback set by IPC server to push events (v1.0 pty.output path)
let onPtyOutput = null;
// v1.1: called with (agent, handleId, seq, bytes, base64Chunk) per chunk
let onPtyData = null;
let onPtyExit = null;

export function setOutputHandler(handler) {
  onPtyOutput = handler;
}

export function setDataHandler(handler) {
  onPtyData = handler;
}

export function setExitHandler(handler) {
  onPtyExit = handler;
}

/**
 * Internal: emit a chunk via v1.1 pty.data path if a handler is wired AND
 * credit permits. Falls back to pushing into the pending queue when
 * credit is exhausted; returns the number of bytes sent.
 */
function emitOrBuffer(entry, chunk) {
  const bytes = chunk.length;
  // Record into cumulative-emitted only when actually emitted.
  if (entry.paused || entry.credit < bytes) {
    if (entry.pendingQueue.length >= PENDING_QUEUE_BOUND) {
      // Drop oldest (safety bound — should not occur under normal operation
      // because node-pty's pause() stops the read loop first).
      entry.pendingQueue.shift();
    }
    entry.pendingQueue.push(chunk);
    if (!entry.paused) {
      try { entry.proc.pause?.(); } catch {}
      entry.paused = true;
    }
    return 0;
  }

  entry.credit -= bytes;
  entry.seq += 1;
  entry.cumulativeEmittedBytes += bytes;

  if (onPtyData) {
    onPtyData(entry.agent, {
      handleId: entry.handleId,
      agentId:  entry.agent,
      seq:      entry.seq,
      bytes,
      data:     chunk.toString('base64'),
      timestamp: new Date().toISOString(),
    });
  }
  return bytes;
}

export function spawnAgent(agent, cmd, args = [], options = {}) {
  // Idempotent retry handling (§1.1 B6)
  const rid = options.clientRequestId;
  if (rid && spawnIdempotencyMap.has(rid)) {
    const prior = spawnIdempotencyMap.get(rid);
    if (prior.result && agents.has(prior.agentName)) {
      log(`Idempotent spawn replay for clientRequestId=${rid}`);
      return prior.result;
    }
    if (prior.failedAt) {
      const err = new Error(prior.errorMessage || 'Previous spawn failed');
      err.code = prior.errorCode;
      throw err;
    }
  }

  if (agents.has(agent)) {
    const err = new Error(`Agent "${agent}" already has a running PTY`);
    err.code = 'AGENT_ALREADY_RUNNING';
    if (rid) {
      _putIdempotency(rid, { failedAt: Date.now(), errorMessage: err.message, errorCode: err.code });
    }
    throw err;
  }

  const cols = options.cols || 200;
  const rows = options.rows || 50;

  // ── Phase 4-T1 C1/C2: hardened input validation ─────────────
  // Validate ALL inputs FIRST, before any state mutation. This is the
  // Sub3-C "validate-all-first, commit-all" pattern — no idempotency
  // map inserts, no agents map inserts, no pty.spawn call unless every
  // sanitizer passed. On any throw we exit before any side effect.
  //
  // NOTE (Sub3-C): the spawn path below is NOT fully atomic. Once
  // pty.spawn() returns successfully, subsequent mutations (agents.set,
  // proc.onData wiring, etc.) are assumed not to throw. Should any of
  // them throw (e.g. due to a follow-up hardening check that grows into
  // this area later), the spawned process would leak. See TODO below.
  let safeCmd, safeArgs, safeCwd, safeEnv;
  try {
    safeCmd  = sanitizeCmd(cmd);
    safeArgs = sanitizeArgs(args, cmd);
    safeCwd  = sanitizeCwd(options.cwd);
    safeEnv  = sanitizeEnv(options.env);
  } catch (err) {
    if (rid) {
      _putIdempotency(rid, {
        failedAt: Date.now(),
        errorMessage: err.message,
        errorCode: err.code || 'SPAWN_REJECTED',
      });
    }
    throw err;
  }

  // C2 step 10: strip client-supplied uid/gid — never let a client raise
  // its own privileges through the spawn options.
  // (We simply do not pass uid/gid to pty.spawn below.)

  let proc;
  try {
    proc = pty.spawn(safeCmd, safeArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: safeCwd,
      env: safeEnv,
      // C2 step 9: force shell:false regardless of client request.
      // node-pty does not accept a shell option, but we set it explicitly
      // so any future wrapper layer honors it.
      shell: false,
    });
  } catch (err) {
    if (rid) {
      _putIdempotency(rid, { failedAt: Date.now(), errorMessage: err.message, errorCode: 'SPAWN_FAILED' });
    }
    throw err;
  }

  const handleId = 'hdl-' + randomUUID();
  const spawnTimestamp = new Date().toISOString();
  const scrollback = new ScrollbackBuffer();
  const entry = {
    agent,
    proc,
    scrollback,
    cols,
    rows,
    startTime: Date.now(),
    spawnTimestamp,
    pid: proc.pid,
    handleId,
    seq: 0,
    credit: INITIAL_CREDIT,
    cumulativeEmittedBytes: 0,
    cumulativeAckedBytes: 0,
    paused: false,
    pendingQueue: [],
    exitReason: null,
    // ── Phase 4-T1 M11: ownership. Filled from the IPC caller's
    // post-handshake clientId (optional — legacy/in-process callers
    // leave this null and ownership enforcement becomes a no-op for
    // them; the IPC layer will always set it).
    ownerClientId: options.callerClientId || null,
  };
  spawnStats.accepted++;

  proc.onData((data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    scrollback.write(buf);
    // v1.0 legacy path: still invoke the pty.output handler for v1.0 clients.
    if (onPtyOutput) {
      onPtyOutput(agent, buf);
    }
    // v1.1 path: credit-gated pty.data emission.
    if (onPtyData) {
      emitOrBuffer(entry, buf);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    log(`Agent "${agent}" exited (code=${exitCode}, signal=${signal})`);
    agents.delete(agent);
    // Drop idempotency record once handle is gone.
    if (rid) spawnIdempotencyMap.delete(rid);

    const reason = entry.exitReason || 'crashed';
    const exitEvent = {
      jsonrpc: '2.0',
      method: 'pty.exit',
      params: {
        agent,
        agentId:  agent,
        handleId: entry.handleId,
        exitCode,
        signal,
        reason,
        timestamp: new Date().toISOString(),
      },
    };

    if (onPtyExit) {
      const delivered = onPtyExit(agent, exitEvent);
      if (!delivered) {
        eventBuffer.push(exitEvent, 'high');
        log(`Buffered pty.exit for "${agent}" (buffer size=${eventBuffer.length})`);
      }
    } else {
      eventBuffer.push(exitEvent, 'high');
    }
  });

  agents.set(agent, entry);
  log(`Spawned agent "${agent}": ${cmd} ${args.join(' ')} (pid=${proc.pid}, cols=${cols}, rows=${rows}, handleId=${handleId})`);

  const result = {
    agent,
    agentId: agent,
    handleId,
    pid: proc.pid,
    spawnTimestamp,
    cols,
    rows,
    initialCredit: INITIAL_CREDIT,
  };
  if (rid) {
    _putIdempotency(rid, { agentName: agent, handleId, result });
  }
  return result;
}

export function killAgent(agent, signal, reason) {
  const entry = agents.get(agent);
  if (!entry) {
    throw new Error(`Agent "${agent}" not found`);
  }
  entry.exitReason = reason || 'unspecified';
  if (isWindows) {
    entry.proc.kill();
  } else {
    entry.proc.kill(signal || 'SIGTERM');
  }
  return { agent, handleId: entry.handleId, killed: true, killedAt: new Date().toISOString() };
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
  // Sub3-B: cap per-write size at 64KB (defense-in-depth — the IPC
  // layer is expected to enforce the same cap before this point, but
  // we also enforce here so direct in-process callers cannot bypass).
  const bytes = typeof data === 'string'
    ? Buffer.byteLength(data, 'utf8')
    : (data && data.length) || 0;
  if (bytes > WRITE_DATA_MAX_BYTES) {
    spawnStats.rejectedWriteOversized++;
    _rateLimitLog('error', '[SPAWN-HARDEN] rejected pty.write agent=%s bytes=%d reason=%s',
      agent, bytes, 'oversized');
    const err = new Error(`pty.write data exceeds ${WRITE_DATA_MAX_BYTES} bytes`);
    err.code = 'WRITE_TOO_LARGE';
    err.ipcCode = ERR_INVALID_PARAMS;
    throw err;
  }
  entry.proc.write(data);
  return { agent, written: true };
}

export function listAgents(options = {}) {
  const includeMeta = options.includeScrollbackMeta === true;
  // ── Phase 4-T1 M11: ownership filter. If the caller supplies a
  // clientId we restrict the returned list to handles they own. Legacy
  // in-process callers pass no callerClientId and see everything (they
  // are trusted).
  const callerClientId = options.callerClientId || null;
  const handles = [];
  let totalVisited = 0;
  for (const [agent, entry] of agents) {
    totalVisited++;
    if (callerClientId && entry.ownerClientId && entry.ownerClientId !== callerClientId) {
      continue;
    }
    // If the caller is authenticated but the handle has no recorded
    // owner (e.g. spawned by a legacy path), still hide it from cross-
    // tenant callers — fail closed.
    if (callerClientId && !entry.ownerClientId) {
      continue;
    }
    const row = {
      agent,
      agentId: agent,
      handleId: entry.handleId,
      pid: entry.pid,
      cols: entry.cols,
      rows: entry.rows,
      uptime: Math.floor((Date.now() - entry.startTime) / 1000),
      lastSeqEmitted: entry.seq,
    };
    if (includeMeta) {
      row.scrollback_bytes = entry.scrollback.byteLength;
    }
    handles.push(row);
  }
  if (callerClientId) {
    _rateLimitLog('log', '[OWNERSHIP] pty.list filtered: caller=%s total=%d owned=%d',
      callerClientId, totalVisited, handles.length);
  }
  return {
    handles,
    // legacy alias — v1.0 clients read from result directly
    agents: handles,
    daemonStartedAt: new Date(startTime).toISOString(),
  };
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

/**
 * v1.1 pty.ack: client consumed `bytesConsumed` bytes, credit the handle.
 * Detects the FLOW_CONTROL_OVERFLOW invariant violation.
 * Returns { ok: true } on success, throws { code: 'FLOW_CONTROL_OVERFLOW' }
 * if cumulativeAckedBytes would exceed cumulativeEmittedBytes.
 */
export function ackAgent(agent, bytesConsumed) {
  const entry = agents.get(agent);
  if (!entry) {
    throw new Error(`Agent "${agent}" not found`);
  }
  if (typeof bytesConsumed !== 'number' || bytesConsumed < 0) {
    throw new Error('bytesConsumed must be a non-negative number');
  }

  const newAcked = entry.cumulativeAckedBytes + bytesConsumed;
  if (newAcked > entry.cumulativeEmittedBytes) {
    const err = new Error(
      `FLOW_CONTROL_OVERFLOW: acked=${newAcked} > emitted=${entry.cumulativeEmittedBytes}`
    );
    err.code = 'FLOW_CONTROL_OVERFLOW';
    throw err;
  }

  entry.cumulativeAckedBytes = newAcked;
  entry.credit += bytesConsumed;

  // If paused and credit now permits, drain pending queue and resume read.
  if (entry.paused && entry.credit > 0) {
    while (entry.pendingQueue.length > 0 && entry.credit > 0) {
      const chunk = entry.pendingQueue[0];
      if (entry.credit < chunk.length) break;
      entry.pendingQueue.shift();
      entry.credit -= chunk.length;
      entry.seq += 1;
      entry.cumulativeEmittedBytes += chunk.length;
      if (onPtyData) {
        onPtyData(agent, {
          handleId: entry.handleId,
          agentId:  agent,
          seq:      entry.seq,
          bytes:    chunk.length,
          data:     chunk.toString('base64'),
          timestamp: new Date().toISOString(),
        });
      }
    }
    if (entry.pendingQueue.length === 0 && entry.credit > 0) {
      try { entry.proc.resume?.(); } catch {}
      entry.paused = false;
    }
  }

  return { ok: true, credit: entry.credit };
}

/**
 * v1.1 pty.reattach: client claims an existing handle and requests replay
 * starting at seq > resumeFromSeq. Resets credit window and cumulative
 * counters per §1.11. Returns { ok, replayCount, replayTruncated, currentSeq }.
 */
export function reattachAgent(agent, handleId, resumeFromSeq, maxReplayBytes, callerCtx = {}) {
  const entry = agents.get(agent);
  if (!entry) {
    const err = new Error(`Agent "${agent}" not found`);
    err.code = 'HANDLE_NOT_FOUND';
    err.ipcCode = ERR_HANDLE_NOT_FOUND;
    throw err;
  }
  // ── Phase 4-T1 M11: ownership check on reattach. Mismatch is
  // reported as HANDLE_NOT_FOUND to avoid leaking handle existence.
  const callerClientId = callerCtx.callerClientId || null;
  if (callerClientId) {
    if (!entry.ownerClientId || entry.ownerClientId !== callerClientId) {
      spawnStats.rejectedOwnershipMismatch++;
      _rateLimitLog('error', '[OWNERSHIP] pty.reattach rejected: caller=%s handle=%s owner=%s',
        callerClientId, handleId, entry.ownerClientId || 'null');
      const err = new Error(`Agent "${agent}" not found`);
      err.code = 'HANDLE_NOT_FOUND';
      err.ipcCode = ERR_HANDLE_NOT_FOUND;
      throw err;
    }
  }
  if (entry.handleId !== handleId) {
    const err = new Error(`handleId mismatch: expected ${entry.handleId} got ${handleId}`);
    err.code = 'AGENTID_MISMATCH';
    throw err;
  }

  // Sub3-D: validate maxReplayBytes before using it as a slice length.
  // Accepts integer in (0, 1_048_576] — otherwise rejects with INVALID_PARAM.
  const cap = _sanitizeReplayBytes(maxReplayBytes);

  // Reset credit window and invariant counters — reattach is authoritative.
  entry.credit = INITIAL_CREDIT;
  entry.cumulativeEmittedBytes = 0;
  entry.cumulativeAckedBytes = 0;
  entry.paused = false;
  entry.pendingQueue = [];

  // Seq continuity: resume from entry.seq; the caller's resumeFromSeq tells
  // us what it's already seen. If the scrollback has enough bytes to cover
  // the gap we emit them synthetically — but note the ring buffer does NOT
  // retain per-seq boundaries, only a byte stream. So we do the best we can:
  // replay the tail of scrollback up to the cap and mark truncated if the
  // gap was larger than scrollback can cover.
  const sbBuf = entry.scrollback.read();
  const bytesAvailable = sbBuf.length;
  const bytesToReplay = Math.min(bytesAvailable, cap);
  const replayTruncated = bytesAvailable > cap
                       || bytesAvailable < (entry.seq - resumeFromSeq);

  return {
    ok: true,
    replayCount: bytesToReplay > 0 ? 1 : 0, // single coalesced replay chunk
    replayTruncated,
    currentSeq: entry.seq,
    replayData: bytesToReplay > 0 ? sbBuf.subarray(sbBuf.length - bytesToReplay).toString('base64') : '',
  };
}

/**
 * v1.1 watchdog.pong payload — daemon side.
 */
export function getWatchdogStatus() {
  return {
    daemonUptime: Math.floor((Date.now() - startTime) / 1000),
    handleCount: agents.size,
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

/**
 * v1.1 drainEventBuffer — return buffered events from disconnect periods.
 *
 * ── Phase 4-T1 M9: auth + caller-ownership filter.
 * Historical behavior let any IPC caller drain ALL events, a cross-tenant
 * info leak. We now require a caller clientId (legacy in-process callers
 * still work with no context and receive everything). When a caller is
 * identified, we also require that their handshake is complete. Returned
 * events are filtered to only those whose params.agent / params.handleId
 * match a currently-live handle owned by the caller, OR whose handleId
 * is in the caller's set of known-owned handles (for events whose handle
 * has already been cleaned up from `agents`).
 */
export function drainEventBuffer(callerCtx = {}) {
  const callerClientId = callerCtx.callerClientId || null;
  const handshakeComplete = callerCtx.handshakeComplete === true;
  // Legacy path: no caller context → full drain (trusted in-process).
  if (!callerClientId) {
    return eventBuffer.drain();
  }
  if (!handshakeComplete) {
    _rateLimitLog('error', '[OWNERSHIP] drainEventBuffer rejected: caller=%s reason=%s',
      callerClientId, 'handshake_incomplete');
    const err = new Error('handshake required before drainEventBuffer');
    err.code = 'HANDSHAKE_REQUIRED';
    throw err;
  }
  // Build the set of handleIds owned by this caller from the live agents
  // map. Events referencing foreign handles are suppressed from the drain.
  const ownedHandleIds = new Set();
  const ownedAgents = new Set();
  for (const [agent, entry] of agents) {
    if (entry.ownerClientId === callerClientId) {
      ownedHandleIds.add(entry.handleId);
      ownedAgents.add(agent);
    }
  }
  // Also honor an explicit ownedHandleIds hint from the IPC layer, which
  // may track handles whose `agents` entry has been GC'd (e.g. exited
  // processes) but whose exit event is still in the buffer.
  if (Array.isArray(callerCtx.ownedHandleIds)) {
    for (const h of callerCtx.ownedHandleIds) ownedHandleIds.add(h);
  }
  if (Array.isArray(callerCtx.ownedAgents)) {
    for (const a of callerCtx.ownedAgents) ownedAgents.add(a);
  }
  // Partial drain: re-insert non-owned events. We drain, filter, then
  // push the foreign events back into the buffer so that the true owner
  // can retrieve them later.
  const { events, summary } = eventBuffer.drain();
  const mine = [];
  const notMine = [];
  for (const ev of events) {
    const p = ev && ev.params;
    const handleId = p && (p.handleId || (p.agentId && p.agent));
    const agentName = p && (p.agent || p.agentId);
    const ownedByHandle = p && p.handleId && ownedHandleIds.has(p.handleId);
    const ownedByAgent = agentName && ownedAgents.has(agentName);
    if (ownedByHandle || ownedByAgent) {
      mine.push(ev);
    } else {
      notMine.push(ev);
    }
    void handleId;
  }
  // Re-buffer events that weren't ours so the rightful owner can still
  // retrieve them. We use 'high' priority to avoid low-priority eviction.
  for (const ev of notMine) {
    eventBuffer.push(ev, 'high');
  }
  if (notMine.length > 0) {
    _rateLimitLog('log', '[OWNERSHIP] drainEventBuffer filtered: caller=%s owned=%d withheld=%d',
      callerClientId, mine.length, notMine.length);
  }
  return {
    events: mine,
    summary: mine.length > 0 ? summary : null,
  };
}

export function getEventBuffer() {
  return eventBuffer;
}

// ── Phase 4-T1 H4/H5: in-memory identity token (read from stdin) ──
//
// The launcher passes a 32-byte hex identity secret over stdin so the
// first authed client can HMAC-challenge us to prove daemon identity.
// Stored only in memory, never logged, never written to disk. Other
// modules (pty-daemon-ipc.mjs) read it through getDaemonIdentityToken().
let _daemonIdentityTokenBuf = null;

export function getDaemonIdentityToken() {
  return globalThis._daemonIdentityToken || null;
}

/**
 * H4/H5 identity-challenge helper. Computed using the CTO 16:xx formula
 * (launcher-side is authoritative):
 *
 *   key  = Buffer.from(identityToken, 'hex')                 // raw 32 bytes
 *   data = Buffer.from(clientNonce + daemonNonce, 'utf-8')   // 64 ASCII bytes
 *   mac  = HMAC-SHA256(key, data).digest('hex')              // 64 hex chars
 *
 * Used by pty-daemon-ipc.mjs's `identity.challenge` RPC handler (Fix C
 * subagent's domain). Returns null if no identity token is loaded (i.e.
 * legacy-launcher case — the IPC layer must surface -32601 Method not
 * found so the launcher's soft-fail path applies).
 */
export function computeIdentityChallengeMac(clientNonce, daemonNonce) {
  const tok = globalThis._daemonIdentityToken;
  if (!tok || typeof tok !== 'string' || !/^[0-9a-fA-F]{64}$/.test(tok)) {
    return null;
  }
  if (typeof clientNonce !== 'string' || typeof daemonNonce !== 'string') {
    return null;
  }
  const key = Buffer.from(tok, 'hex');
  const data = Buffer.from(clientNonce + daemonNonce, 'utf-8');
  try {
    return createHmac('sha256', key).update(data).digest('hex');
  } finally {
    // Best-effort zero of the derived key buffer. Node does not
    // guarantee Buffer.fill before GC, but every small win helps.
    try { key.fill(0); } catch {}
  }
}

/**
 * H4/H5 helper: return a fresh 16-byte hex-encoded daemon nonce for
 * answering an `identity.challenge` RPC. Importable by pty-daemon-ipc.mjs.
 */
export function freshDaemonNonce() {
  return randomBytes(16).toString('hex');
}

async function _readIdentityTokenFromStdin(timeoutMs = 500) {
  // Short-deadline read. If launcher didn't wire stdin (legacy or
  // external tooling), we proceed with no token and the IPC layer
  // falls back to its existing pipe-token auth path.
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (token) => {
      if (settled) return;
      settled = true;
      try { process.stdin.removeListener('data', onData); } catch {}
      try { process.stdin.removeListener('end', onEnd); } catch {}
      try { process.stdin.removeListener('error', onErr); } catch {}
      resolve(token);
    };
    const onData = (c) => {
      chunks.push(c);
      // Expected token is a single 64-char hex line followed by \n.
      // As soon as we see a newline, parse and finish early.
      const joined = Buffer.concat(chunks).toString('utf-8');
      const nl = joined.indexOf('\n');
      if (nl >= 0) {
        finish(joined.slice(0, nl).trim());
      } else if (joined.length >= 128) {
        // Safety cap — never read more than 128 bytes from stdin at startup.
        finish(joined.trim());
      }
    };
    const onEnd = () => {
      const joined = Buffer.concat(chunks).toString('utf-8').trim();
      finish(joined);
    };
    const onErr = () => finish('');
    try {
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.on('error', onErr);
    } catch {
      finish('');
      return;
    }
    setTimeout(() => finish(Buffer.concat(chunks).toString('utf-8').trim()), timeoutMs).unref?.();
  });
}

function _validateAndStoreIdentityToken(raw) {
  if (!raw) {
    log('[IDENTITY] no identity token on stdin, legacy launcher');
    globalThis._daemonIdentityToken = null;
    return false;
  }
  // Expect 64 hex chars (32 bytes). Accept looser only if non-empty but
  // refuse to store clearly malformed values.
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    log('[IDENTITY] malformed identity token on stdin, ignoring');
    globalThis._daemonIdentityToken = null;
    return false;
  }
  _daemonIdentityTokenBuf = Buffer.from(raw, 'utf-8');
  globalThis._daemonIdentityToken = raw;
  // Do NOT log the token itself.
  log('[IDENTITY] identity token loaded from stdin (64 hex chars)');
  return true;
}

function _clearIdentityToken() {
  try {
    if (_daemonIdentityTokenBuf) {
      _daemonIdentityTokenBuf.fill(0);
      _daemonIdentityTokenBuf = null;
    }
  } catch {}
  globalThis._daemonIdentityToken = null;
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

  // Phase 4-T1 H4/H5: best-effort zero of the identity token in memory
  // before GC.
  _clearIdentityToken();

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
  // Phase 4-T1 core promise: when the parent server dies, our stdio
  // pipes break and the next console.log/error EPIPEs. Without these
  // handlers the EPIPE becomes an uncaughtException, which our handler
  // (line ~1605) turns into shutdown() — killing every agent. Silencing
  // EPIPE here is what makes "server restart, agent survives" work.
  // We keep other errors (EBADF, ENOSPC) visible by re-throwing.
  process.stdout.on('error', (err) => {
    if (err && err.code !== 'EPIPE') throw err;
  });
  process.stderr.on('error', (err) => {
    if (err && err.code !== 'EPIPE') throw err;
  });

  log(`Starting PTY Daemon (${isDev ? 'DEV' : 'PROD'} mode, pid=${process.pid})`);

  // ── Phase 4-T1 H4/H5: read in-memory identity token from stdin BEFORE
  // listening. Short 500ms deadline keeps us backward-compat with any
  // launcher that hasn't been upgraded yet.
  try {
    const raw = await _readIdentityTokenFromStdin(500);
    _validateAndStoreIdentityToken(raw);
  } catch (err) {
    log('[IDENTITY] stdin read failed:', err && err.message);
  }

  // ── Phase 4-T1 C2 canonical-path cache: re-resolve now that env is
  // fully populated (picks up TEAMMCP_CMD_ALLOWLIST_EXTRA overrides that
  // may have been set after module load). Must complete before we begin
  // listening — the IPC layer cannot accept pty.spawn until the cache
  // is populated.
  try {
    globalThis._allowedCmdAbsolutePaths = resolveAllowedCmdPaths();
    log(`[SPAWN-HARDEN] cmd allowlist cache size=${globalThis._allowedCmdAbsolutePaths.size}`);
  } catch (err) {
    logError('[SPAWN-HARDEN] failed to resolve cmd allowlist:', err && err.message);
    process.exit(1);
  }

  const existingPid = checkExistingDaemon();
  if (existingPid) {
    logError(`Another daemon is already running (pid=${existingPid}). Exiting.`);
    process.exit(1);
  }

  writePidFile();

  // NB4: write pipe access token (pure-Node fallback for SDDL).
  const pipeToken = writeDaemonToken(isDev);
  log('Pipe access token written');
  console.error('[NB4][INTERIM] pipe-token file-based, same-user attacker can bypass, see §1.0.5 carry-over');

  const uid = isWindows ? (process.getuid?.() ?? 0) : userInfo().uid;
  const ipcServer = await createIPCServer({
    isDev,
    uid,
    isWindows,
    configDir,
    pipeToken,
    ptyOps: {
      spawn: spawnAgent,
      kill: killAgent,
      resize: resizeAgent,
      write: writeAgent,
      list: listAgents,
      status: agentStatus,
      scrollback: agentScrollback,
      ack: ackAgent,
      reattach: reattachAgent,
      watchdogStatus: getWatchdogStatus,
      daemonStats: getDaemonStats,
      drainEventBuffer: drainEventBuffer,
    },
    setOutputHandler,
    setDataHandler,
    setExitHandler,
  });

  log(`PTY Daemon ready (ipc=${ipcServer.address})`);
}

// Only run main() when this file is the process entry point. Unit tests
// import the module to exercise exported sanitizers without triggering
// PID-file collisions, stdin reads, or IPC server startup. Detection
// matches on the argv[1] basename so the launcher path (which passes
// the resolved absolute path) still works in production.
const _entryBasename = (process.argv[1] || '').replace(/\\/g, '/').split('/').pop() || '';
if (_entryBasename === 'pty-daemon.mjs') {
  main().catch((err) => {
    logError('Fatal error during startup:', err);
    removePidFile();
    process.exit(1);
  });
}
