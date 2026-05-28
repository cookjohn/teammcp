/**
 * migrate-credential-profiles.mjs — one-shot migration of inline per-agent
 * API tokens into reusable credential_profiles.
 *
 * Groups api_key agents by (provider, normalized base_url, token), creates one
 * profile per unique combo, and points each agent's credential_profile_id at it.
 * Inline columns are PRESERVED (not cleared) so the change is reversible and the
 * profile-first/inline-fallback resolver keeps working either way.
 *
 * Usage (run with the SAME TEAMMCP_HOME the server uses):
 *   node scripts/migrate-credential-profiles.mjs --dry-run   # preview only
 *   node scripts/migrate-credential-profiles.mjs             # apply
 *
 * RECOMMENDED: stop the server before applying (agents may be mid-spawn).
 */
import * as db from '../server/db.mjs';

const DRY = process.argv.includes('--dry-run') || process.argv.includes('-n');

function normalizeBaseUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
}

function main() {
  // Pull raw rows directly (need inline token columns + existing profile id).
  const rows = db.default.prepare(`
    SELECT name, api_provider, api_base_url, api_auth_token, api_model, credential_profile_id
    FROM agents
    WHERE auth_mode = 'api_key' AND api_auth_token IS NOT NULL AND api_auth_token != ''
      AND credential_profile_id IS NULL
  `).all();

  if (rows.length === 0) {
    console.log('[migrate] no un-migrated api_key agents with inline tokens. Nothing to do.');
    return;
  }

  // Group by (provider, normalized base_url, token).
  const groups = new Map(); // key -> { provider, base_url, token, model, agents: [] }
  for (const r of rows) {
    const provider = r.api_provider || 'custom';
    const base_url = normalizeBaseUrl(r.api_base_url);
    const token = r.api_auth_token;
    const key = `${provider}|${base_url}|${token}`;
    if (!groups.has(key)) groups.set(key, { provider, base_url, token, model: r.api_model || null, agents: [] });
    groups.get(key).agents.push(r.name);
  }

  // Resolve existing profile names to avoid collisions.
  const existing = new Set(db.listCredentialProfiles().map(p => p.name));
  function uniqueName(base) {
    if (!existing.has(base)) { existing.add(base); return base; }
    let i = 2;
    while (existing.has(`${base}-${i}`)) i++;
    const n = `${base}-${i}`; existing.add(n); return n;
  }

  console.log(`[migrate] ${rows.length} agent(s) → ${groups.size} unique credential(s)${DRY ? '  (DRY RUN)' : ''}\n`);

  const plan = [];
  for (const g of groups.values()) {
    const baseName = slug(`${g.provider}-${g.model || 'default'}`);
    const name = uniqueName(baseName);
    plan.push({ name, ...g });
    console.log(`  profile "${name}"  provider=${g.provider}  base_url=${g.base_url}  model=${g.model || '(none)'}  token=${g.token.slice(0,8)}…(${g.token.length})`);
    console.log(`    ← agents: ${g.agents.join(', ')}`);
  }

  if (DRY) {
    console.log('\n[migrate] DRY RUN — no changes written. Re-run without --dry-run to apply.');
    return;
  }

  const tx = db.default.transaction(() => {
    for (const p of plan) {
      const created = db.createCredentialProfile({
        name: p.name, provider: p.provider, base_url: p.base_url, auth_token: p.token, model: p.model,
      });
      for (const agentName of p.agents) {
        db.setAgentCredentialProfile(agentName, created.id);
      }
    }
  });
  tx();

  console.log(`\n[migrate] applied: created ${plan.length} profile(s), repointed ${rows.length} agent(s).`);
  console.log('[migrate] inline columns preserved for rollback. Restart running agents to pick up profile resolution.');
}

main();
