/**
 * TeamMCP Path Utilities
 *
 * All runtime data lives under TEAMMCP_HOME (default: ~/.teammcp/).
 * This ensures the server works correctly whether installed globally via npm
 * or run from a local clone, without hardcoding __dirname-relative paths.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// ── Home directory ──────────────────────────────────────────

/**
 * TeamMCP home directory.
 * Override with TEAMMCP_HOME environment variable.
 */
export const TEAMMCP_HOME =
  process.env.TEAMMCP_HOME ||
  join(homedir(), '.teammcp');

// ── Sub-directories ─────────────────────────────────────────

export const DATA_DIR    = join(TEAMMCP_HOME, 'data');
export const UPLOADS_DIR = join(TEAMMCP_HOME, 'uploads');
export const SCREENSHOTS_DIR = join(TEAMMCP_HOME, 'screenshots');
export const AGENTS_DIR  = join(TEAMMCP_HOME, 'agents');

// ── File paths ──────────────────────────────────────────────

export const DB_PATH        = join(DATA_DIR, 'teammcp.db');
export const ENV_PATH       = join(TEAMMCP_HOME, '.env');
export const CONFIG_PATH    = join(TEAMMCP_HOME, 'config.json');

// ── Ensure directories exist ────────────────────────────────

/**
 * Create all TeamMCP directories if they don't exist.
 * Call once at server startup.
 */
export function ensureDirectories() {
  for (const dir of [DATA_DIR, UPLOADS_DIR, SCREENSHOTS_DIR, AGENTS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}
