// Probe: spawn codex.exe in a ConPTY via node-pty, dump every byte for
// ~6 seconds, and check whether codex enables win32-input-mode
// (\x1b[?9001h) or any keyboard-enhancement sequence.
//
// What we look for:
//   • \x1b[?9001h  → win32-input-mode (extended keyboard via crossterm)
//   • \x1b[>1u    → kitty keyboard protocol push (modern crossterm path)
//   • \x1b[?1049h → alternate screen (always sent by ratatui)
//   • Anything else interesting before the first frame settles

import pty from 'node-pty';
import { writeFileSync, mkdirSync } from 'node:fs';

const CODEX_EXE = 'C:/Users/ssdlh/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const CWD = 'C:/Users/ssdlh/Desktop/agents/CodexTest';

mkdirSync('logs/probe', { recursive: true });

console.log('[probe] spawning codex.exe via node-pty (ConPTY)…');
const term = pty.spawn(CODEX_EXE, [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: CWD,
  env: process.env,
});

const chunks = [];
let totalBytes = 0;

term.onData(d => {
  const buf = Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf-8');
  chunks.push(buf);
  totalBytes += buf.length;
});

term.onExit(({ exitCode, signal }) => {
  console.log(`[probe] codex exited code=${exitCode} sig=${signal}`);
});

setTimeout(() => {
  const all = Buffer.concat(chunks);
  writeFileSync('logs/probe/raw.bin', all);
  console.log(`[probe] collected ${totalBytes} bytes → logs/probe/raw.bin`);

  const text = all.toString('binary');

  // Hunt for known mode-enable sequences.
  const checks = [
    ['win32-input-mode enable',       '\x1b[?9001h'],
    ['win32-input-mode disable',      '\x1b[?9001l'],
    ['kitty keyboard push',           '\x1b[>1u'],
    ['kitty keyboard pop',            '\x1b[<u'],
    ['kitty modifyOtherKeys (CSI >)', '\x1b[>4;'],
    ['alternate screen',              '\x1b[?1049h'],
    ['mouse tracking',                '\x1b[?1000h'],
    ['focus tracking',                '\x1b[?1004h'],
    ['bracketed paste',               '\x1b[?2004h'],
  ];

  console.log('\n[probe] mode detection:');
  for (const [label, seq] of checks) {
    const found = text.includes(seq);
    const mark = found ? 'YES' : 'no ';
    const hex = Buffer.from(seq, 'binary').toString('hex');
    console.log(`  ${mark}  ${label.padEnd(36)} (${seq.replace(/\x1b/g, 'ESC')}  hex=${hex})`);
  }

  // Show first 600 bytes as hex+ascii so we can eyeball anything unexpected.
  console.log('\n[probe] first 600 bytes (hex + printable):');
  const head = all.subarray(0, 600);
  for (let i = 0; i < head.length; i += 32) {
    const slice = head.subarray(i, i + 32);
    const hex = slice.toString('hex').match(/.{1,2}/g).join(' ');
    const ascii = Array.from(slice).map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.').join('');
    console.log(`  ${i.toString(16).padStart(4, '0')}  ${hex.padEnd(96)}  ${ascii}`);
  }

  // Pretty escape-sequence view: replace ESC with [ESC] so we can scan.
  const pretty = text.slice(0, 2000).replace(/\x1b/g, '[ESC]').replace(/[\x00-\x09\x0b-\x1f]/g, '.');
  writeFileSync('logs/probe/pretty.txt', pretty);
  console.log('\n[probe] first 2000 bytes as readable text → logs/probe/pretty.txt');

  console.log('\n[probe] killing codex…');
  try { term.kill(); } catch {}
  setTimeout(() => process.exit(0), 500);
}, 6000);
