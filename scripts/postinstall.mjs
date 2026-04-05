/**
 * postinstall script — runs after `npm install`
 *
 * Responsibilities:
 * 1. Verify Node.js version meets engine requirement
 * 2. Ensure TeamMCP home directories exist
 * 3. (Future: run native module build if needed)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

// ── Engine check ────────────────────────────────────────────

const MIN_VERSION = '18.0.0';
const [major, minor] = process.version.slice(1).split('.').map(Number);
const [reqMajor, reqMinor] = MIN_VERSION.slice(1).split('.').map(Number);

if (major < reqMajor || (major === reqMajor && minor < reqMinor)) {
  console.error(`[postinstall] ERROR: Node.js ${MIN_VERSION} or higher required. You have ${process.version}`);
  process.exit(1);
}

console.log(`[postinstall] Node.js ${process.version} OK`);

// ── Ensure TeamMCP directories ───────────────────────────────

const TEAMMCP_HOME = process.env.TEAMMCP_HOME || join(homedir(), '.teammcp');
const dirs = [
  join(TEAMMCP_HOME, 'data'),
  join(TEAMMCP_HOME, 'uploads'),
  join(TEAMMCP_HOME, 'screenshots'),
  join(TEAMMCP_HOME, 'agents'),
];

for (const dir of dirs) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[postinstall] Created ${dir}`);
  }
}

console.log('[postinstall] Done. Run `teammcp init` to initialize configuration.');
