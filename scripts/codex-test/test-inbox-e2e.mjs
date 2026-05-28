// End-to-end: Chairman sends DM → codex-pty runner pastes + \r\n →
// codex's TUI submits → codex calls send_dm → reply arrives back.

const SERVER = 'http://localhost:3100';
const CHAIRMAN_KEY = 'tmcp_ad3120ce3e484954ab4e92d1';
const AGENT = 'CodexTest';

async function api(path, opts = {}) {
  const r = await fetch(`${SERVER}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHAIRMAN_KEY}`, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}

const tag = `E2E-PTY-${Date.now().toString(36).slice(-5)}`;
const msg = `[E2E-PTY-TEST] Please reply via send_dm with content exactly "${tag}". Just the tag, nothing else.`;

console.log(`[e2e] sending DM from Chairman: tag=${tag}`);
const sendRes = await api('/api/send', {
  method: 'POST',
  body: JSON.stringify({ channel: `dm:${AGENT}`, content: msg }),
});
console.log(`[e2e] sent:`, sendRes?.id || sendRes?.message_id || JSON.stringify(sendRes).slice(0, 120));

console.log(`[e2e] polling channel for "${tag}" reply (up to 180s)…`);
const start = Date.now();
const deadline = start + 180_000;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 3000));
  const hist = await api(`/api/history?channel=dm%3AChairman%3A${AGENT}&limit=10`);
  const hit = (hist.messages || []).find(m =>
    m.from_agent === AGENT && m.content && m.content.includes(tag)
  );
  if (hit) {
    const ms = Date.now() - start;
    console.log(`\n[e2e] ✅ PASS in ${ms}ms — codex replied: "${hit.content}"`);
    process.exit(0);
  }
  process.stdout.write('.');
}
console.log(`\n[e2e] ❌ FAIL — no "${tag}" reply within 90s`);
process.exit(1);
