// Test which Enter encoding actually triggers codex's "submit" in
// win32-input-mode. Strategy:
//   1. For each variant, paste a unique prompt asking codex to send_dm
//      back with a tag like "ACK-V1".
//   2. Send the Enter variant.
//   3. Wait 30s, poll the dm:Chairman:CodexTest channel for that tag.
//   4. The first variant whose ACK shows up wins.
//
// Run while CodexTest is fresh + idle (no pending input).

const SERVER = 'http://localhost:3100';
const KEY = process.env.TEAMMCP_KEY || 'tmcp_ad3120ce3e484954ab4e92d1'; // Chairman
const AGENT = 'CodexTest';

async function api(path, opts = {}) {
  const r = await fetch(`${SERVER}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}

async function pushBytes(bytes) {
  const buf = Buffer.from(bytes, 'binary');
  await api('/api/debug/pty-raw', {
    method: 'POST',
    body: JSON.stringify({ agent: AGENT, bytes_b64: buf.toString('base64') }),
  });
}

function bracketedPaste(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

// Candidate Enter encodings to test
const ENTERS = [
  ['V1_win32_press_release',
   '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_'],
  ['V2_raw_CR',
   '\r'],
  ['V3_raw_LF',
   '\n'],
  ['V4_raw_CRLF',
   '\r\n'],
  ['V5_win32_press_only',
   '\x1b[13;28;13;1;0;1_'],
  ['V6_win32_with_release_then_raw_CR',
   '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_\r'],
  ['V7_win32_Uc_0_no_unicode',
   '\x1b[13;28;0;1;0;1_\x1b[13;28;0;0;0;1_'],
];

async function listLatest() {
  const j = await api(`/api/history?channel=dm%3AChairman%3ACodexTest&limit=20`);
  return j.messages || [];
}

async function testVariant(label, enterSeq) {
  const tag = `${label.replace(/[^a-zA-Z0-9_]/g,'_')}_${Date.now().toString(36).slice(-5)}`;
  const prompt =
    `Reply now via teammcp send_dm to Chairman with content exactly: "${tag}". ` +
    `Do not include anything else, no quotes, just the tag. Do this immediately.`;
  console.log(`\n[test] ${label}  tag=${tag}`);

  // Send paste
  await pushBytes(bracketedPaste(prompt));
  await new Promise(r => setTimeout(r, 250));
  // Send Enter
  await pushBytes(enterSeq);
  console.log(`[test]   paste+enter sent, polling for ${tag}...`);

  const start = Date.now();
  const deadline = start + 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const msgs = await listLatest();
    const hit = msgs.find(m => m.content && m.content.includes(tag) && m.from_agent === AGENT);
    if (hit) {
      const ms = Date.now() - start;
      console.log(`[test]   ✅ ${label} WORKED after ${ms}ms — codex sent: "${hit.content}"`);
      return true;
    }
  }
  console.log(`[test]   ❌ ${label} no reply within 60s`);
  return false;
}

console.log(`[test] testing ${ENTERS.length} Enter variants against ${AGENT}`);
const results = [];
for (const [label, seq] of ENTERS) {
  const ok = await testVariant(label, seq);
  results.push({ label, ok });
  if (ok) {
    console.log(`\n[test] STOP — first variant worked, no need to test the rest.`);
    break;
  }
  // Send Esc to clear input box in case the variant left text there
  await pushBytes('\x1b');
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n[test] summary:');
for (const r of results) console.log(`  ${r.ok ? 'OK ' : '-- '} ${r.label}`);
process.exit(0);
