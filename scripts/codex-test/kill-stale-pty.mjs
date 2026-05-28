// Kill any PTY the daemon is holding for a given agent name.
// Used to clean up a stale claude.exe leftover when an agent's runtime
// was changed (e.g. claude → codex-pty).
import {
  killPtyWithReason,
  listPtys,
  isConnected,
} from '../../server/pty-daemon-client.mjs';

const AGENT = process.argv[2] || 'CodexTest';

// The daemon client auto-connects on first call; give it a moment.
await new Promise(r => setTimeout(r, 1500));

if (!isConnected()) {
  console.error('[kill-stale-pty] daemon NOT connected — pipe may be locked by server');
  process.exit(1);
}

console.log('[kill-stale-pty] listing PTYs in daemon…');
try {
  const list = await listPtys();
  console.log(`[kill-stale-pty] daemon has ${list.length} PTY(s):`,
    list.map(a => `${a.agent || a.name}=${a.pid || '?'}`).join(', '));
} catch (e) {
  console.warn('[kill-stale-pty] list failed:', e.message);
}

console.log(`[kill-stale-pty] killing PTY for "${AGENT}"…`);
try {
  const r = await killPtyWithReason(AGENT, 'runtime_changed');
  console.log('[kill-stale-pty] kill result:', r);
} catch (e) {
  console.error('[kill-stale-pty] kill failed:', e.message);
}

process.exit(0);
