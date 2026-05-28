/**
 * credential-probe-watchdog.mjs — periodic validity probe for credential profiles.
 *
 * DEFAULT OFF. Each probe is a real (tiny, max_tokens 16) billed API call, so
 * we don't run it on a timer unless the operator opts in via
 * CRED_PROBE_INTERVAL_MIN (minutes). The dashboard "Test" button is always
 * available for on-demand checks regardless of this setting.
 *
 * When enabled, it sweeps every profile, writes last_test_status, and refreshes
 * the boot snapshot so the dashboard health badge reflects failures within one
 * poll. Sweeps are serialized with a small gap to avoid hammering providers.
 */
import { getAllProfileIds, resolveCredentialProfile, setProfileTestResult } from './db.mjs';
import { probeCredential } from './credential-probe.mjs';

let _timer = null;

async function sweepOnce() {
  let ids = [];
  try { ids = getAllProfileIds(); } catch { return; }
  for (const id of ids) {
    const resolved = resolveCredentialProfile(id);
    if (!resolved) continue;
    try {
      const r = await probeCredential({
        provider: resolved.provider, base_url: resolved.base_url,
        token: resolved.auth_token, model: resolved.model,
      });
      let detail = String(r.detail || '');
      if (resolved.auth_token && detail.includes(resolved.auth_token)) {
        detail = detail.split(resolved.auth_token).join('<redacted>');
      }
      setProfileTestResult(id, { status: r.ok ? 'ok' : 'fail', detail });
    } catch (e) {
      setProfileTestResult(id, { status: 'fail', detail: `probe error: ${e.message}` });
    }
    await new Promise(r => setTimeout(r, 500)); // gentle gap between providers
  }
  try {
    const { refreshBootSnapshot } = await import('./boot-checks.mjs');
    refreshBootSnapshot();
  } catch {}
}

export function startCredentialProbeWatchdog() {
  const raw = process.env.CRED_PROBE_INTERVAL_MIN;
  const minutes = raw ? parseInt(raw, 10) : 0;
  if (!minutes || minutes <= 0) {
    console.log('[cred-probe] watchdog disabled (set CRED_PROBE_INTERVAL_MIN to enable periodic checks)');
    return;
  }
  const ms = Math.max(5, minutes) * 60 * 1000;
  console.log(`[cred-probe] watchdog enabled — probing all profiles every ${minutes} min`);
  // First sweep after one interval (not at boot — avoid startup billing surprise).
  _timer = setInterval(() => { sweepOnce().catch(() => {}); }, ms);
}

export function stopCredentialProbeWatchdog() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
