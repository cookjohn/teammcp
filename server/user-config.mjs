/**
 * User-editable config layer.
 *
 * Stored at {TEAMMCP_HOME}/data/user-config.json. Loaded once at server boot,
 * BEFORE any module that reads process.env.AGENTS_BASE_DIR (etc.) is imported
 * — so this file MUST be imported first in server/index.mjs.
 *
 * Precedence (highest wins):
 *   1. Externally set process.env (e.g. start-prod.ps1 sets AGENTS_BASE_DIR)
 *   2. data/user-config.json (written by setup wizard)
 *   3. Built-in defaults inside each consumer module
 *
 * The setup wizard POSTs to /api/config/user to update this file. Existing
 * module-scope caches (e.g. process-manager's AGENTS_BASE_DIR) won't pick up
 * mid-run changes — restart the server after editing.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { TEAMMCP_HOME } from './lib/paths.mjs';

const CONFIG_DIR = join(TEAMMCP_HOME, 'data');
const CONFIG_PATH = join(CONFIG_DIR, 'user-config.json');

// Allowed keys + how each maps to a process.env override. Keep this list
// explicit — anything not here gets ignored on write.
const ENV_MAPPING = {
  agentsDir:                  'AGENTS_BASE_DIR',
  codexBinPath:               'TEAMMCP_CMD_ALLOWLIST_EXTRA',
  registerSecret:             'TEAMMCP_REGISTER_SECRET',
};

let _config = {};

function loadFromDisk() {
  try {
    if (existsSync(CONFIG_PATH)) {
      _config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.warn('[user-config] failed to read', CONFIG_PATH, '—', err.message);
    _config = {};
  }
}

// Path-shaped config keys — we sanity-check these before injecting so that a
// stale absolute path (e.g. from a previous TEAMMCP_HOME the user has moved
// away from) doesn't poison the env and crash agents with EACCES later.
const PATH_KEYS = new Set(['agentsDir', 'codexBinPath']);

function isPathPlausible(p) {
  // Plausible = the path itself exists, OR its parent does (path will be
  // created on first use by process-manager / wizard). If neither exists the
  // entry is almost certainly stale — fall back to module default.
  if (!p) return false;
  if (existsSync(p)) return true;
  try { return existsSync(dirname(p)); } catch { return false; }
}

// Inject config values into process.env at module load. Skip any key the
// user has already exported externally — env always wins.
function applyToEnv() {
  for (const [key, envName] of Object.entries(ENV_MAPPING)) {
    if (process.env[envName]) continue; // external env wins
    const val = _config[key];
    if (typeof val !== 'string' || val.length === 0) continue;
    if (PATH_KEYS.has(key) && !isPathPlausible(val)) {
      console.warn(`[user-config] ${key}=${val} looks stale (parent missing) — ignoring, will use module default. Update via wizard or /api/config/user.`);
      continue;
    }
    process.env[envName] = val;
  }
}

loadFromDisk();
applyToEnv();

export function getUserConfig() {
  // Return a clone so callers can't mutate the cache.
  return { ..._config };
}

export function setUserConfig(updates) {
  // Only persist known keys.
  const sanitized = {};
  for (const key of Object.keys(ENV_MAPPING)) {
    if (updates[key] !== undefined && (typeof updates[key] === 'string' || updates[key] === null)) {
      sanitized[key] = updates[key] || ''; // null/empty string clears the key
    }
  }
  _config = { ..._config, ...sanitized };
  // Clean up empty-string entries so the file stays tidy.
  for (const k of Object.keys(_config)) if (_config[k] === '') delete _config[k];
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2) + '\n', 'utf-8');
  return getUserConfig();
}

export { CONFIG_PATH };
