// Spawn codex in a PTY (same way the daemon does), capture EVERY byte to
// disk and to a "last 4KB" tail buffer, watch for the exit. When codex
// dies, dump the tail so we can see panics / TUI errors that the daemon
// path swallows.

import pty from 'node-pty';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'C:/Users/ssdlh/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const CWD = 'C:/Users/ssdlh/Desktop/agents/CodexTest';
const AGENT = 'CodexTest';
const KEY = 'tmcp_b78247efc7cd4a4292969519';   // CodexTest's TEAMMCP_KEY
const PLUGIN = 'C:/Users/ssdlh/Desktop/teammcp/plugin-dist/mcp-client/teammcp-channel.mjs';

const args = [
  '--config', `mcp_servers.teammcp.command="node"`,
  '--config', `mcp_servers.teammcp.args=["${PLUGIN}"]`,
  '--config', `mcp_servers.teammcp.env.AGENT_NAME="${AGENT}"`,
  '--config', `mcp_servers.teammcp.env.TEAMMCP_KEY="${KEY}"`,
  '--config', `mcp_servers.teammcp.env.TEAMMCP_URL="http://localhost:3100"`,
];

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  PROGRAMFILES: process.env['PROGRAMFILES'],
  PROGRAMDATA: process.env.PROGRAMDATA,
  SYSTEMROOT: process.env.SYSTEMROOT,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  CODEX_HOME: join(CWD, '.codex'),
  CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT: '',
  AGENT_NAME: AGENT,
  TEAMMCP_KEY: KEY,
  TEAMMCP_URL: 'http://localhost:3100',
};

console.log('[probe-crash] spawning codex in PTY…');
const term = pty.spawn(EXE, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: CWD,
  env,
});
console.log(`[probe-crash] codex pid=${term.pid}`);

const chunks = [];
let totalBytes = 0;
term.onData(d => {
  const buf = Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf-8');
  chunks.push(buf);
  totalBytes += buf.length;
});

term.onExit(({ exitCode, signal }) => {
  const ageSec = (Date.now() - startMs) / 1000;
  console.log(`\n[probe-crash] EXIT after ${ageSec.toFixed(1)}s code=${exitCode} sig=${signal}`);
  const all = Buffer.concat(chunks);
  writeFileSync('logs/probe/crash-raw.bin', all);

  // Dump last 8KB as readable text (strip ANSI for clarity).
  const tail = all.subarray(Math.max(0, all.length - 8192));
  const stripped = tail.toString('utf-8')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')   // CSI
    .replace(/\x1b\][^\x07]*\x07/g, '')         // OSC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
  console.log(`\n=== LAST 8KB (ANSI-stripped, ${all.length} total bytes captured) ===`);
  console.log(stripped);
  process.exit(0);
});

const startMs = Date.now();

// Tick every 5s so we can see if codex stays alive past common death points.
const tick = setInterval(() => {
  const age = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`[probe-crash] alive at ${age}s · captured ${totalBytes} bytes`);
}, 5000);

// Hard ceiling: 120s. If still alive, kill it and dump tail.
setTimeout(() => {
  clearInterval(tick);
  console.log('[probe-crash] 120s ceiling — killing codex');
  try { term.kill(); } catch {}
}, 120_000);
