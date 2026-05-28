/**
 * Boot-time dependency checks.
 *
 * Runs at server start and exposes a snapshot via /api/system/health so the
 * dashboard can surface "missing dep" warnings instead of letting the user
 * hit a 500 when they click Start.
 *
 * Each check returns { name, level, message, fix? }.
 *   level = 'ok' | 'warn' | 'fail'
 *   - ok    = system is in good shape on this axis
 *   - warn  = degraded; specific features won't work but server runs
 *   - fail  = nothing will work; user must fix
 */
import { existsSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { AGENTS_DIR } from './lib/paths.mjs';
import { getUserConfig } from './user-config.mjs';
import { getFailedProfilesInUse } from './db.mjs';

function which(bin) {
  // Returns the resolved path if `bin` is on PATH, else null. Cross-platform
  // via PowerShell's Get-Command on Windows / `command -v` elsewhere.
  try {
    if (process.platform === 'win32') {
      // Use cmd's `where` — it's everywhere and quick. Hide stderr; capture
      // stdout. Multi-line output means multiple hits; take first.
      const out = execSync(`where "${bin}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      return out.split(/\r?\n/)[0] || null;
    } else {
      const out = execSync(`command -v "${bin}"`, { stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/sh' }).toString().trim();
      return out || null;
    }
  } catch {
    return null;
  }
}

function checkRunningUser() {
  // Windows: no uid concept and claude has no root refusal there — skip.
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    return { name: 'user', level: 'ok', message: `running on ${process.platform}` };
  }
  const uid = process.getuid();
  if (uid === 0) {
    return {
      name: 'user',
      level: 'fail',
      message: 'TeamMCP is running as root — claude CLI refuses --dangerously-skip-permissions under root, so no agent will start',
      fix: 'Create a non-root user (e.g. `useradd -m teammcp`), chown TEAMMCP_HOME to it, and run the server under that user. See scripts/setup-linux.sh or README → Linux deployment',
    };
  }
  return { name: 'user', level: 'ok', message: `running as uid=${uid}` };
}

function checkAgentsDir() {
  const dir = process.env.AGENTS_BASE_DIR || AGENTS_DIR;
  try {
    if (!existsSync(dir)) {
      // Not fatal — process-manager creates it on first agent start. But
      // surface it so users know where their agents will land.
      return {
        name: 'agents-dir',
        level: 'ok',
        message: `Agents dir will be created at ${dir} on first agent start`,
        path: dir,
      };
    }
    if (!statSync(dir).isDirectory()) {
      return { name: 'agents-dir', level: 'fail', message: `${dir} exists but is not a directory`, path: dir };
    }
    accessSync(dir, fsConstants.W_OK);
    return { name: 'agents-dir', level: 'ok', message: `Agents dir writable: ${dir}`, path: dir };
  } catch (err) {
    return {
      name: 'agents-dir',
      level: 'fail',
      message: `Agents dir ${dir} unwritable: ${err.message}`,
      fix: 'Set AGENTS_BASE_DIR or update wizard config to a writable path',
      path: dir,
    };
  }
}

function checkClaudeCli() {
  // On Windows, the process-manager spawns claude.cmd (not the bash shim
  // also named "claude"). Resolve the same way the spawn path does so a
  // missing .cmd shows up here instead of as a runtime SPAWN_FAILED.
  const target = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const resolved = which(target);
  if (!resolved) {
    return {
      name: 'claude-cli',
      level: 'warn',
      message: `${target} not found on PATH — claude-runtime agents will not start`,
      fix: 'Install Claude Code (https://claude.com/claude-code) and run `claude login`',
    };
  }
  return { name: 'claude-cli', level: 'ok', message: `claude CLI: ${resolved}`, path: resolved };
}

function checkBun() {
  const resolved = which('bun');
  if (!resolved) {
    return {
      name: 'bun',
      level: 'warn',
      message: 'bun not found on PATH — fakechat channel plugin will fail silently inside claude agents',
      fix: 'Install bun (https://bun.sh) and add it to PATH',
    };
  }
  return { name: 'bun', level: 'ok', message: `bun: ${resolved}`, path: resolved };
}

function checkCodexBin() {
  // Only meaningful if codex-pty agents are configured. We check the
  // allowlist env (which the wizard / user-config sets) — if it's empty,
  // skip the check. If it's set but the binary is missing, fail.
  const extra = process.env.TEAMMCP_CMD_ALLOWLIST_EXTRA;
  if (!extra) {
    return {
      name: 'codex-bin',
      level: 'ok',
      message: 'codex-pty runtime not configured (skip)',
      configured: false,
    };
  }
  const path = extra.split(';')[0].trim(); // first entry of allowlist
  if (!existsSync(path)) {
    return {
      name: 'codex-bin',
      level: 'fail',
      message: `TEAMMCP_CMD_ALLOWLIST_EXTRA points at ${path} but file is missing`,
      fix: 'Run `npm i -g @openai/codex` or update wizard config to the correct codex.exe path',
      path,
      configured: true,
    };
  }
  return { name: 'codex-bin', level: 'ok', message: `codex.exe: ${path}`, path, configured: true };
}

function checkCredentialProfiles() {
  // Live check (runBootChecks runs on each /api/system/health poll): flag
  // online agents whose credential profile last tested 'fail'.
  try {
    const failed = getFailedProfilesInUse();
    if (!failed.length) {
      return { name: 'credentials', level: 'ok', message: 'No failing credential profiles in use' };
    }
    const names = failed.map(f => `${f.name} (${f.agents_online} online)`).join(', ');
    return {
      name: 'credentials',
      level: 'warn',
      message: `Credential profile(s) failing their last test but still in use: ${names}`,
      fix: 'Rotate the token in Credentials → API Key Profiles, then restart the affected agents',
    };
  } catch (e) {
    // Table may not exist on a very old DB — treat as ok.
    return { name: 'credentials', level: 'ok', message: 'credential profiles not checked', note: e.message };
  }
}

export function runBootChecks() {
  const checks = [
    checkRunningUser(),
    checkAgentsDir(),
    checkClaudeCli(),
    checkBun(),
    checkCodexBin(),
    checkCredentialProfiles(),
  ];
  const verdict = checks.some(c => c.level === 'fail')
    ? 'fail'
    : checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
  return { verdict, checks, ranAt: new Date().toISOString() };
}

// Pretty-print boot check results to console (called once at boot).
export function logBootChecks() {
  const result = runBootChecks();
  console.log(`[TeamMCP] boot checks: ${result.verdict.toUpperCase()}`);
  for (const c of result.checks) {
    const prefix = c.level === 'ok' ? '  ✓' : c.level === 'warn' ? '  ⚠' : '  ✗';
    console.log(`${prefix} ${c.name}: ${c.message}`);
    if (c.fix && c.level !== 'ok') console.log(`     → ${c.fix}`);
  }
  return result;
}

// In-memory snapshot for /api/system/health. Refreshed each boot.
let _snapshot = null;
export function getBootSnapshot() {
  if (!_snapshot) _snapshot = runBootChecks();
  return _snapshot;
}
export function refreshBootSnapshot() {
  _snapshot = runBootChecks();
  return _snapshot;
}
