// server/retention-policies.mjs
// G1.F: register the seven default retention policies at boot (CEO-locked
// 2026-04-22; state lock `gate1.policy_count=7`).
//
// Registration only — sweepAll() is still gated by RETENTION_SWEEP=1 and is
// NOT called from here. Import this module AFTER db.mjs so the registry
// primitive is ready.
//
// ── Split rationale (CEO direction 2026-04-22) ──────────
// dup_* and nudge_cd_* are registered as TWO independent policies (not one
// OR'd WHERE) so that (a) retention_event audit rows name the exact matching
// prefix for root-cause diagnosis, (b) the two prefixes have orthogonal
// semantics (memory dedup vs SkillNudge cooldown) and independent lifecycles,
// and (c) tuning the cooldown TTL from 7d → 2d is a one-policy change.
// OR-within-one-policy remains a supported primitive capability (the
// `whereClause` field accepts freeform SQL) — the default 7 just intentionally
// use single-predicate each for diagnostic clarity.
//
// ── memories_ttl FTS atomicity (CTO FAIL 13 fix 2026-04-22) ──
// memories_ttl uses a `customSweep` hook that delegates to the existing
// sweepExpiredMemories() at db.mjs:2469-2630. That function is the SINGLE
// source of FTS-atomic truth: it wraps memories + memories_fts deletes in a
// single txn. The generic scanner would leave orphan FTS rows, which fails
// R1. sweepExpiredMemories does NOT write to retention_event — it only logs
// + publishes the `memory_sweep` eventbus event (grep confirms) — so the
// customSweep wrapper lets retention.mjs emit the single audit row for this
// policy run. eventbus emissions from sweepExpiredMemories are consumer-facing
// and left intact.
//
// ── Schema surprises (recorded for the team) ────────────
//   cc_metrics   — timestamp column is `timestamp` (TEXT ISO), not `ts`.
//   llm_usage    — timestamp column is `created_at` (TEXT ISO), not `ts`.
//   change_log   — timestamp column is `timestamp` (TEXT ISO), not `ts`.
//   memories     — uses `expires_at` (TEXT ISO) populated at insert time;
//                  filter `expires_at IS NOT NULL AND expires_at < ? AND pinned = 0`.
//   state_kv     — PK is (project_id, field); NO `key` column, and the column
//                  is `project_id`, not `project` (CEO spec said `project`;
//                  adapted). NO `id` column — we pass rowIdentifier:'rowid'
//                  to the scanner so DELETE uses SQLite's implicit rowid.
//   retention_event — self-cleanup policy; `severity='lint'` rows are excluded
//                  so lint warnings survive longer than the 90d window. After
//                  FAIL 5 migration the timestamp column is `started_at`
//                  (was `ts`).
//
// All timestamped tables store ISO-8601 TEXT, so whereParams returns an ISO
// cutoff string computed at sweep time.

import { registerRetention, sweepExpiredMemories } from './db.mjs';
import dbDefault from './db.mjs';

const DAY_MS = 86400000;

function isoAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

// ── Compaction policies (added 2026-05-25) ───────────────────
// On top of pure TTL deletion, we also need active compression:
//   - Near-duplicate memories from the same (agent, source_type,
//     category, title_prefix) bucket. SkillNudge fires ~140x for
//     the same pattern over weeks; cc_metrics PostToolUse fires
//     for every tool call. After the noise filters in memory.mjs
//     these stop accumulating new rows, but the historical
//     backlog needed a one-shot compactor.
//   - raw_event JSON is mostly redundant once title/summary/tags
//     have been extracted (manually or by LLM classifier). Old
//     memories can trim raw_event to 200 chars + a marker.
//
// Both are customSweep policies because the generic scanner does
// not understand window functions or partial UPDATEs.

/**
 * memories_dup_compact: per (agent, source_type, category, title40)
 * bucket, keep the newest row, delete the rest (subject to the
 * usual pinned=0 + access_count=0 safety filter — never delete
 * memories the user pinned or that have actually been read).
 *
 * batchSize caps how many we delete per run so a runaway agent
 * can't trigger a multi-second sweep.
 */
function memoriesDupCompactSweep(ctx) {
  try {
    const cap = Math.max(50, Math.min(5000, ctx.batchSize | 0 || 500));
    // Find ids to delete: every row except the newest in each
    // (agent, source_type, category, title40) bucket, where the
    // bucket has at least 2 rows and all rows are unaccessed/unpinned.
    const findSql = `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY agent, source_type, category, substr(title, 1, 40)
            ORDER BY created_at DESC
          ) AS rn
        FROM memories
        WHERE pinned = 0
          AND (access_count IS NULL OR access_count = 0)
      )
      SELECT id FROM ranked WHERE rn > 1 LIMIT ?
    `;
    const targets = dbDefault.prepare(findSql).all(cap);
    if (targets.length === 0) {
      return { scanned: 0, softDeleted: 0, hardDeleted: 0 };
    }
    const ids = targets.map(r => r.id);
    if (ctx.dryRun) {
      return {
        scanned: ids.length,
        softDeleted: 0,
        hardDeleted: 0,
        sample: ids.slice(0, ctx.sampleLimit | 0 || 5),
      };
    }
    // FTS-atomic delete: both rows in one transaction. memories_fts
    // mirrors id, so the WHERE id IN (...) targets the same rows.
    const placeholders = ids.map(() => '?').join(',');
    const tx = dbDefault.transaction(() => {
      dbDefault.prepare(`DELETE FROM memories_fts WHERE id IN (${placeholders})`).run(...ids);
      dbDefault.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    });
    tx();
    return {
      scanned: ids.length,
      softDeleted: 0,
      hardDeleted: ids.length,
    };
  } catch (err) {
    return {
      scanned: 0,
      softDeleted: 0,
      hardDeleted: 0,
      errors: [err.message],
    };
  }
}

/**
 * memories_raw_trim: for rows older than 7 days with raw_event longer
 * than 200 chars, truncate raw_event to 200 chars + a marker. After a
 * week the LLM classifier (or the heuristic summary) has already
 * extracted everything useful; keeping the full raw event just bloats
 * the table and the FTS index does not even cover this column.
 */
function memoriesRawTrimSweep(ctx) {
  try {
    const cap = Math.max(50, Math.min(5000, ctx.batchSize | 0 || 500));
    const cutoff = isoAgo(7);
    const findSql = `
      SELECT id, length(raw_event) AS sz
      FROM memories
      WHERE pinned = 0
        AND datetime(created_at) < datetime(?)
        AND raw_event IS NOT NULL
        AND length(raw_event) > 200
        AND raw_event NOT LIKE '%[trimmed]%'
      LIMIT ?
    `;
    const targets = dbDefault.prepare(findSql).all(cutoff, cap);
    if (targets.length === 0) {
      return { scanned: 0, softDeleted: 0, hardDeleted: 0 };
    }
    if (ctx.dryRun) {
      return {
        scanned: targets.length,
        softDeleted: 0,
        hardDeleted: 0,
        sample: targets.slice(0, ctx.sampleLimit | 0 || 5).map(r => r.id),
      };
    }
    let bytesSaved = 0;
    const update = dbDefault.prepare(
      `UPDATE memories SET raw_event = substr(raw_event, 1, 200) || '...[trimmed]' WHERE id = ?`
    );
    const tx = dbDefault.transaction(() => {
      for (const row of targets) {
        update.run(row.id);
        bytesSaved += (row.sz - 213); // 200 + 13-char marker
      }
    });
    tx();
    // We report scanned/hardDeleted as the row count; bytes_reclaimed
    // goes via the retention.mjs collector if it understands the field.
    return {
      scanned: targets.length,
      softDeleted: 0,
      hardDeleted: 0, // not deletes, but trims — closest fit on the contract
      bytesReclaimed: bytesSaved > 0 ? bytesSaved : 0,
      // Encode trim count in a custom field. retention.mjs logs the row
      // but doesn't require this; harmless if ignored.
      trimmed: targets.length,
    };
  } catch (err) {
    return {
      scanned: 0,
      softDeleted: 0,
      hardDeleted: 0,
      errors: [err.message],
    };
  }
}

// memories_ttl custom handler: dryRun + hardDelete path both delegate to
// the FTS-atomic sweepExpiredMemories. Returns the retention.mjs scanner's
// expected shape: {scanned, softDeleted, hardDeleted, sample?, errors?}.
function memoriesCustomSweep(ctx) {
  try {
    if (ctx.dryRun) {
      const r = sweepExpiredMemories({ batchSize: ctx.batchSize, dryRun: true });
      const limit = Math.max(0, Math.min(Number(ctx.sampleLimit) | 0 || 0, (r.sample?.length) || 0));
      return {
        scanned: r.scanned || 0,
        softDeleted: 0,
        hardDeleted: 0,
        sample: Array.isArray(r.sample) ? r.sample.slice(0, limit) : [],
      };
    }

    // Real sweep: hardDelete follows sweepAll's hardDelete option.
    const r = sweepExpiredMemories({
      batchSize: ctx.batchSize,
      hardDelete: !!ctx.hardDelete,
      dryRun: false,
    });
    return {
      scanned: r.scanned || 0,
      softDeleted: ctx.hardDelete ? 0 : (r.deleted || 0),
      hardDeleted: ctx.hardDelete ? (r.deleted || 0) : 0,
    };
  } catch (err) {
    return { scanned: 0, softDeleted: 0, hardDeleted: 0, errors: [err.message] };
  }
}

export function registerDefaultRetentionPolicies() {
  // 1. memories — 90 days, skip pinned. FTS-atomic via customSweep.
  //    whereClause/whereParams are stubs (the scanner validates them but
  //    never executes them when customSweep is set).
  registerRetention({
    name: 'memories_ttl',
    table: 'memories',
    whereClause: 'expires_at IS NOT NULL AND expires_at < ? AND pinned = 0',
    whereParams: () => [new Date().toISOString()],
    batchSize: 500,
    customSweep: memoriesCustomSweep,
  });

  // 2. change_log — 30 days (column is `timestamp`, not `ts`)
  registerRetention({
    name: 'change_log_ttl',
    table: 'change_log',
    whereClause: 'timestamp < ?',
    whereParams: () => [isoAgo(30)],
    batchSize: 500,
  });

  // 3. cc_metrics — 30 days (column is `timestamp`, not `ts`)
  registerRetention({
    name: 'cc_metrics_ttl',
    table: 'cc_metrics',
    whereClause: 'timestamp < ?',
    whereParams: () => [isoAgo(30)],
    batchSize: 500,
  });

  // 4. llm_usage — 90 days (column is `created_at`, not `ts`)
  registerRetention({
    name: 'llm_usage_ttl',
    table: 'llm_usage',
    whereClause: 'created_at < ?',
    whereParams: () => [isoAgo(90)],
    batchSize: 500,
  });

  // 5. state_kv memory/dup_* — 7 days. Single-predicate (not OR'd) per CEO
  //    direction for diagnostic clarity. state_kv has no `id` column, so we
  //    pass rowIdentifier:'rowid' — the scanner then DELETEs by rowid.
  registerRetention({
    name: 'state_kv_memory_dup_ttl',
    table: 'state_kv',
    whereClause: "project_id = 'memory' AND field LIKE 'dup_%' AND updated_at < ?",
    whereParams: () => [isoAgo(7)],
    rowIdentifier: 'rowid',
    selectColumns: 'project_id, field, updated_at',
    batchSize: 500,
  });

  // 6. state_kv memory/nudge_cd_* — 7 days. SkillNudge cooldown rows.
  registerRetention({
    name: 'state_kv_memory_nudge_cd_ttl',
    table: 'state_kv',
    whereClause: "project_id = 'memory' AND field LIKE 'nudge_cd_%' AND updated_at < ?",
    whereParams: () => [isoAgo(7)],
    rowIdentifier: 'rowid',
    selectColumns: 'project_id, field, updated_at',
    batchSize: 500,
  });

  // 7. retention_event self-cleanup — 90 days, preserve lint rows. Note the
  //    timestamp column was renamed `ts` → `started_at` in the FAIL 5 migration.
  registerRetention({
    name: 'retention_event_self_ttl',
    table: 'retention_event',
    whereClause: "severity != 'lint' AND started_at < ?",
    whereParams: () => [isoAgo(90)],
    batchSize: 500,
  });

  // 8. memories_dup_compact — per (agent, source_type, category, title40)
  //    bucket, keep newest, delete the rest. Targets the SkillNudge /
  //    cc_metrics PostToolUse duplication pattern that piles up before
  //    the memory.mjs noise filters fully drain the historical backlog.
  registerRetention({
    name: 'memories_dup_compact',
    table: 'memories',
    whereClause: '1=0', // stub — generic scanner never runs
    whereParams: () => [],
    batchSize: 500,
    customSweep: memoriesDupCompactSweep,
  });

  // 9. memories_raw_trim — truncate raw_event to 200 chars for memories
  //    older than 7 days. Title/summary/tags carry the semantic content;
  //    raw_event is reference data that's mostly dead weight after a
  //    week.
  registerRetention({
    name: 'memories_raw_trim',
    table: 'memories',
    whereClause: '1=0', // stub — generic scanner never runs
    whereParams: () => [],
    batchSize: 500,
    customSweep: memoriesRawTrimSweep,
  });
}

// Auto-register on import so boot-time `import './retention-policies.mjs'`
// is sufficient wiring.
registerDefaultRetentionPolicies();

export default { registerDefaultRetentionPolicies };
