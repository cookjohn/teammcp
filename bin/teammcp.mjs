#!/usr/bin/env node
/**
 * TeamMCP CLI entry point
 *
 * Usage:
 *   teammcp          Start the server (default)
 *   teammcp start    Start the server
 *   teammcp init     Initialize TeamMCP home directory and config
 *   teammcp version  Show version
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = join(__dirname, '..');

// ── Version ─────────────────────────────────────────────────

function showVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));
    console.log(`teammcp v${pkg.version}`);
  } catch {
    console.log('teammcp (unknown version)');
  }
}

// ── Init ────────────────────────────────────────────────────

async function cmdInit() {
  const { ensureDirectories } = await import('../server/lib/paths.mjs');
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const paths = await import('../server/lib/paths.mjs');

  console.log(`TeamMCP home: ${paths.TEAMMCP_HOME}`);
  ensureDirectories();

  const envPath = join(paths.TEAMMCP_HOME, '.env');
  if (!existsSync(envPath)) {
    const envExample = join(ROOT_DIR, '.env.example');
    try {
      const content = readFileSync(envExample, 'utf8');
      writeFileSync(envPath, content);
      console.log(`Created ${envPath}`);
      console.log('Please edit .env and set AGENTS_BASE_DIR (or use default ~/.teammcp/agents)');
    } catch {
      writeFileSync(envPath, `# TeamMCP configuration\n`);
      console.log(`Created ${envPath} (empty config)`);
    }
  } else {
    console.log('.env already exists, skipping');
  }

  console.log('\nTeamMCP initialized successfully!');
  console.log(`Run 'teammcp start' to launch the server.`);
}

// ── Start server ────────────────────────────────────────────

function cmdStart() {
  const serverPath = join(ROOT_DIR, 'server', 'index.mjs');
  const child = spawn(process.execPath, [serverPath], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: ROOT_DIR
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ── Main ────────────────────────────────────────────────────

const [,, cmd = 'start'] = process.argv;

switch (cmd) {
  case 'start':
  case 'run':
    cmdStart();
    break;
  case 'init':
    cmdInit();
    break;
  case 'version':
  case '-v':
  case '--version':
    showVersion();
    break;
  case 'help':
  case '--help':
  default:
    console.log(`TeamMCP CLI

Usage: teammcp [command]

Commands:
  teammcp         Start the server (default)
  teammcp start    Start the server
  teammcp init     Initialize TeamMCP home directory and config
  teammcp version  Show version
  teammcp help     Show this help

Environment variables:
  TEAMMCP_HOME     TeamMCP data directory (default: ~/.teammcp/)
  TEAMMCP_PORT     Server port (default: 3100)
  AGENTS_BASE_DIR  Agents workspace directory
`);
    break;
}
