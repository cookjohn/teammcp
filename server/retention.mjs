// server/retention.mjs
// Retention sweep scanner (G1.A).
//
// Iterates retention policies registered via registerRetention() in db.mjs and
// runs each policy as an atomic, per-policy transaction:
//   1. SELECT candidate row-identifiers matching policy.whereClause up to
//      policy.batchSize. Identifier column is policy.rowIdentifier
//      (default 'id'; tables without an id column can pass 'rowid').
//   2. Either soft-delete (UPDATE policy.softDelete.column = value) or
//      hard-delete (DELETE FROM policy.table WHERE <rowIdentifier> = ?).
//   3. Emit per-policy metrics, append an audit row, and publish a
//      `retention_sweep` eventbus event.
//
// ── Append-only trigger bypass: is_sweeping() UDF (CTO-ruled 2026-04-22) ──
// `change_log_no_delete` has `WHEN is_sweeping() = 0`. The UDF lives in db.mjs
// and reads a module-scoped boolean; sweepAll() flips it ON for the duration
// of the policy loop, OFF in a `finally` block. Retention sweeps DELETE only,
// never UPDATE, so only the _no_delete trigger gets the WHEN clause — the
// _no_update trigger stays unconditional.
//
// Why UDF, not sentinel table:
//   - SQLite triggers cannot reference temp.* objects
//     ("trigger X cannot reference objects in database temp"), so the original
//     temp-table design was infeasible.
//   - A sentinel in main-schema would silently bypass the trigger from ANY
//     connection that opened the DB, giving up our connection-scope isolation.
//   - The UDF is registered per-connection via `db.function()`. If a future
//     worker thread opens its own better-sqlite3 connection WITHOUT registering
//     the function, the trigger raises `no such function: is_sweeping` —
//     fail-loud, not silent bypass.
//
// Dual-fail-closed safeties:
//   - `RETENTION_SWEEP=1` env flag MUST be set or sweepAll() short-circuits
//     before toggling the flag.
//   - The `is_sweeping()` UDF MUST be registered at DB init (db.mjs) or every
//     trigger fire raises. Both safeties have to be present for a sweep to
//     actually DELETE from change_log; neither alone is sufficient.
//
// Severity tagging:
//   - `sweepAll({severity: 'catchup'})` tags per-policy + `__sweepAll__` audit
//     rows as 'catchup'. Day -1 fossil-cleanup scripts will use this so R1
//     steady-state SQL can exclude the one-time backlog from 48h soak metrics.
//     auto_vacuum warn rows (hardcoded 'warn') and lint rows (hardcoded 'lint'
//     at registerRetention time) ignore the override.
//
// Design notes for dependent tasks:
//   - G1.B: covered by the UDF + trigger migration in db.mjs.
//   - G1.D: DEFAULT_HARD_DELETE is true; flip back by editing below.
//   - G1.F: retention-policies.mjs registers the 7 default policies. This
//           module intentionally does NOT register anything.

import { randomUUID } from 'node:crypto';
import db, {
  getRetentionPolicies,
  insertRetentionEvent,
  setRetentionSweeping,
} from './db.mjs';
import { publish } from './eventbus.mjs';

// ── Defaults ────────────────────────────────────────────
// G1.D: hard-delete is now the default for sweepAll(). Callers may still pass
// `hardDelete: false` explicitly to opt into soft-delete for policies with
// softDelete configs.
export const DEFAULT_HARD_DELETE = true;

// Default sample size for dryRun mode. Capped at 50 (sampleLimit arg on sweepAll).
const DRY_RUN_SAMPLE_DEFAULT = 5;
const DRY_RUN_SAMPLE_MAX = 50;

// ── Internal sweep-active flag (mirror of the db.mjs flag) ──
// retention.mjs owns the authoritative toggle via setRetentionSweeping();
// db.mjs reads the flag through the `is_sweeping()` SQL UDF. We keep a local
// mirror so tests can assert `_isSweeping()` after a `finally` clears it.
let _sweepActive = false;
export function _isSweeping() {
  return _sweepActive;
}

// ── File-size + freelist helpers for bytes_reclaimed ────
// We measure bytes_reclaimed as the delta in actual DB file size
// (page_count * page_size), so the number reflects bytes released to disk
// rather than the freelist (which only grows until vacuum).
function _dbFileBytes() {
  try {
    const page = db.pragma('page_size', { simple: true });
    const total = db.pragma('page_count', { simple: true });
    return Number(total) * Number(page);
  } catch {
    return 0;
  }
}

// Best-effort used-bytes snapshot (used pages only, for optional diagnostics).
function _dbUsedBytes() {
  try {
    const page = db.pragma('page_size', { simple: true });
    const total = db.pragma('page_count', { simple: true });
    const free = db.pragma('freelist_count', { simple: true });
    return (Number(total) - Number(free)) * Number(page);
  } catch {
    return 0;
  }
}

// Returns true iff auto_vacuum is set to INCREMENTAL (mode 2).
// NONE=0, FULL=1, INCREMENTAL=2. If we're not in INCREMENTAL mode we can't
// call `PRAGMA incremental_vacuum` — changing auto_vacuum mode requires a
// whole-file VACUUM rewrite, which is out of scope for this task.
function _autoVacuumIsIncremental() {
  try {
    const mode = db.pragma('auto_vacuum', { simple: true });
    return Number(mode) === 2;
  } catch {
    return false;
  }
}

// Emit warning once per process so log-spam is bounded.
let _warnedAutoVacuumOnce = false;

// ── Per-policy sweep ────────────────────────────────────
/**
 * Run a single retention policy. Wrapped in a transaction.
 *
 * @param {object} policy - normalized policy from getRetentionPolicies().
 * @param {object} [opts]
 * @param {boolean} [opts.hardDelete] - if true, DELETE rows; otherwise apply
 *        policy.softDelete (UPDATE) when present. If hardDelete=true but the
 *        policy has no softDelete, behavior is identical (DELETE).
 * @param {string}  [opts.caller] - audit tag ('cron' | 'manual' | 'boot' | ...).
 * @returns {{policy:string, scanned:number, softDeleted:number, hardDeleted:number, bytesReclaimed:number, durationMs:number, error?:string}}
 */
export function sweepPolicy(
  policy,
  {
    hardDelete = DEFAULT_HARD_DELETE,
    caller = 'unknown',
    severity = 'info',
    sweepId = null,
    startedAt = null,
    dryRun = false,
    sampleLimit = DRY_RUN_SAMPLE_DEFAULT,
  } = {}
) {
  const startTs = Date.now();
  const runStartedAt = startedAt || new Date(startTs).toISOString();
  // Per-policy bytes_reclaimed is NOT reliably measurable at the page level
  // (vacuum is deferred to end-of-run). We record 0 here and rely on the
  // aggregate `__sweepAll__` audit row for true file-size delta. See sweepAll.
  const metrics = {
    policy: policy.name,
    scanned: 0,
    softDeleted: 0,
    hardDeleted: 0,
    bytesReclaimed: 0,
    durationMs: 0,
  };

  // ── customSweep branch (FAIL 13 — memories_ttl FTS atomicity) ──
  // When a policy provides customSweep(), the generic SELECT/DELETE path is
  // bypassed entirely. The custom handler is expected to be FTS-atomic (or
  // whatever per-table invariant it enforces) inside its own transaction.
  // retention.mjs remains the SOLE writer of retention_event audit rows.
  if (typeof policy.customSweep === 'function') {
    try {
      const ctx = {
        dryRun,
        hardDelete,
        batchSize: policy.batchSize,
        sampleLimit,
        caller,
        severity,
        db,
        sweepId,
        startedAt: runStartedAt,
        policyName: policy.name,
      };
      const r = policy.customSweep(ctx) || {};
      metrics.scanned = (r.scanned | 0) || 0;
      metrics.softDeleted = (r.softDeleted | 0) || 0;
      metrics.hardDeleted = (r.hardDeleted | 0) || 0;
      if (Array.isArray(r.errors) && r.errors.length) {
        metrics.error = r.errors.join('; ');
      }
      if (r.sample) metrics.sample = r.sample;
    } catch (err) {
      metrics.error = `customSweep failed: ${err.message}`;
      console.error(`[retention] policy=${policy.name} customSweep failed:`, err.message);
    }
    metrics.durationMs = Date.now() - startTs;

    // G1.P §3.f: force severity='error' when customSweep threw, so retention-watchdog
    // counts it. The success path keeps caller-supplied severity (e.g. 'catchup').
    const customSeverity = metrics.error ? 'error' : severity;
    // Single audit write per customSweep policy run.
    insertRetentionEvent({
      policy: policy.name,
      sweep_id: sweepId,
      scanned: metrics.scanned,
      soft_deleted: metrics.softDeleted,
      hard_deleted: metrics.hardDeleted,
      bytes_reclaimed: metrics.bytesReclaimed,
      duration_ms: metrics.durationMs,
      caller,
      started_at: runStartedAt,
      severity: customSeverity,
      error: metrics.error || null,
      note: dryRun ? 'dryRun' : null,
    });

    console.info(
      `[retention] policy=${policy.name} (custom) scanned=${metrics.scanned} ` +
      `softDeleted=${metrics.softDeleted} hardDeleted=${metrics.hardDeleted} ` +
      `caller=${caller} duration=${metrics.durationMs}ms`
    );

    if (typeof policy.onSweep === 'function') {
      try { policy.onSweep(metrics); } catch (err) {
        console.warn(`[retention] policy=${policy.name} onSweep hook failed:`, err.message);
      }
    }
    return metrics;
  }

  let params;
  try {
    params = policy.whereParams ? policy.whereParams() : [];
    if (!Array.isArray(params)) {
      throw new TypeError(`policy[${policy.name}].whereParams() must return an array`);
    }
  } catch (err) {
    metrics.durationMs = Date.now() - startTs;
    metrics.error = `whereParams failed: ${err.message}`;
    console.error(`[retention] policy=${policy.name} whereParams failed:`, err.message);
    // G1.P §3.g: force severity='error' for whereParams predicate throw
    insertRetentionEvent({
      policy: policy.name,
      sweep_id: sweepId,
      duration_ms: metrics.durationMs,
      caller,
      started_at: runStartedAt,
      severity: 'error',
      error: metrics.error,
    });
    return metrics;
  }

  // rowIdentifier: default 'id'. For composite-PK / id-less tables (e.g.
  // state_kv), callers pass 'rowid' and SQLite's implicit rowid column is
  // used. The identifier column is also what DELETE/UPDATE target below, so
  // we ALWAYS include it in the SELECT list (under the alias `_rid`) on top
  // of any caller-provided selectColumns.
  const rowIdentifier = policy.rowIdentifier || 'id';
  const extraCols = policy.selectColumns && policy.selectColumns !== 'id' ? `, ${policy.selectColumns}` : '';
  const selectSql = `SELECT ${rowIdentifier} AS _rid${extraCols} FROM ${policy.table} WHERE ${policy.whereClause} LIMIT ?`;

  let candidates;
  try {
    candidates = db.prepare(selectSql).all(...params, policy.batchSize);
  } catch (err) {
    metrics.durationMs = Date.now() - startTs;
    metrics.error = `select failed: ${err.message}`;
    console.error(`[retention] policy=${policy.name} select failed:`, err.message);
    // G1.P §3.h: force severity='error' for scan-stage DB error
    insertRetentionEvent({
      policy: policy.name,
      sweep_id: sweepId,
      duration_ms: metrics.durationMs,
      caller,
      started_at: runStartedAt,
      severity: 'error',
      error: metrics.error,
    });
    return metrics;
  }

  metrics.scanned = candidates.length;
  if (candidates.length === 0) {
    metrics.durationMs = Date.now() - startTs;
    insertRetentionEvent({
      policy: policy.name,
      sweep_id: sweepId,
      scanned: 0,
      duration_ms: metrics.durationMs,
      caller,
      started_at: runStartedAt,
      severity,
    });
    return metrics;
  }

  const useHard = hardDelete || !policy.softDelete;

  try {
    const txn = db.transaction((rows) => {
      // Trigger bypass is provided by sweepAll() via the is_sweeping() UDF —
      // the _sweepActive flag is set ON for the whole policy loop. Nothing to
      // activate per-policy.
      if (useHard) {
        const delStmt = db.prepare(`DELETE FROM ${policy.table} WHERE ${rowIdentifier} = ?`);
        for (const row of rows) {
          const info = delStmt.run(row._rid);
          if (info.changes > 0) metrics.hardDeleted++;
        }
      } else {
        const { column, value } = policy.softDelete;
        // Column name is from policy config (trusted, not user input).
        const updStmt = db.prepare(
          `UPDATE ${policy.table} SET ${column} = ? WHERE ${rowIdentifier} = ?`
        );
        for (const row of rows) {
          const info = updStmt.run(value, row._rid);
          if (info.changes > 0) metrics.softDeleted++;
        }
      }
    });
    txn(candidates);
  } catch (err) {
    metrics.durationMs = Date.now() - startTs;
    metrics.error = `transaction failed: ${err.message}`;
    console.error(`[retention] policy=${policy.name} txn failed, rolled back:`, err.message);
    // G1.P §3.a: force severity='error' for sweep transaction rollback (DELETE/UPDATE failure)
    // G1.P §3.c: tag note with trigger name when an append-only ABORT slipped through —
    // this means the bypass UDF / flag failed and the change_log invariant fired,
    // which is a fatal-class incident, not a generic tx error.
    const msg = String(err.message || '');
    let triggerNote = null;
    if (/append-only|ABORT|change_log_no_delete|change_log_no_update/i.test(msg)) {
      const m = msg.match(/change_log_no_(?:delete|update)/i);
      triggerNote = m ? `trigger ABORT: ${m[0]}` : 'trigger ABORT (append-only bypass failed)';
    }
    insertRetentionEvent({
      policy: policy.name,
      sweep_id: sweepId,
      scanned: metrics.scanned,
      duration_ms: metrics.durationMs,
      caller,
      started_at: runStartedAt,
      severity: 'error',
      error: metrics.error,
      note: triggerNote,
    });
    return metrics;
  }

  metrics.durationMs = Date.now() - startTs;

  // Policy-level hook
  if (typeof policy.onSweep === 'function') {
    try {
      policy.onSweep(metrics);
    } catch (err) {
      console.warn(`[retention] policy=${policy.name} onSweep hook failed:`, err.message);
    }
  }

  insertRetentionEvent({
    policy: policy.name,
    sweep_id: sweepId,
    scanned: metrics.scanned,
    soft_deleted: metrics.softDeleted,
    hard_deleted: metrics.hardDeleted,
    bytes_reclaimed: metrics.bytesReclaimed,
    duration_ms: metrics.durationMs,
    caller,
    started_at: runStartedAt,
    severity,
  });

  console.info(
    `[retention] policy=${policy.name} scanned=${metrics.scanned} ` +
    `softDeleted=${metrics.softDeleted} hardDeleted=${metrics.hardDeleted} ` +
    `bytesReclaimed=${metrics.bytesReclaimed} caller=${caller} ` +
    `duration=${metrics.durationMs}ms`
  );

  return metrics;
}

/**
 * Run every registered retention policy.
 *
 * Short-circuits unless `RETENTION_SWEEP=1` in the environment — this is the
 * double-safety kill switch. Individual sweepPolicy() calls still work for
 * tests / one-off tooling.
 *
 * dryRun: when `dryRun=true`, runs the same candidate-filter query per policy
 * but performs NO UPDATE/DELETE, NO bypass activation, NO WAL/incremental_vacuum.
 * Each policy returns `{policy, wouldDelete, sample, errors}` and an observation
 * row is written to retention_event with caller='dryrun-<origCaller>',
 * severity='info', scanned=<count>, note='dryRun'. dryRun is still gated by
 * `RETENTION_SWEEP=1` to keep the fail-closed posture — callers must opt in
 * to any retention activity, even read-only observation, by setting the flag.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.hardDelete=DEFAULT_HARD_DELETE] - G1.D: default is now true.
 * @param {boolean} [opts.dryRun=false] - observation-only mode (no writes).
 * @param {number}  [opts.sampleLimit=5] - rows per policy in dryRun sample (max 50).
 * @param {string[]} [opts.only] - if provided, restrict to these policy names.
 * @param {string} [opts.caller='unknown'] - audit tag ('cron' | 'manual' | 'boot' | ...).
 * @param {string} [opts.severity='info'] - severity tag applied to per-policy
 *        and aggregate audit rows. Allowlist: info | warn | error | lint | catchup.
 *        Day -1 fossil-catchup scripts pass `severity:'catchup'` so R1 SQL can
 *        exclude the one-time backlog from 48h steady-state metrics. Does NOT
 *        affect auto_vacuum warn rows (hardcoded 'warn') or lint rows.
 * @param {boolean} [opts.force] - bypass the RETENTION_SWEEP env flag (for
 *        tests). Never use this in production callers.
 * @returns aggregate result — see shape notes on dryRun vs. real mode.
 */
export function sweepAll({
  hardDelete = DEFAULT_HARD_DELETE,
  dryRun = false,
  sampleLimit = DRY_RUN_SAMPLE_DEFAULT,
  only = null,
  caller = 'unknown',
  severity = 'info',
  force = false,
} = {}) {
  // FAIL 5: assign sweep_id + started_at ONCE per sweep so every audit row
  // written in this run shares the same identifier and the same window start.
  // C's soak queries use sweep_id to group per-policy rows + the aggregate.
  const sweepId = randomUUID();
  const startTs = Date.now();
  const startedAt = new Date(startTs).toISOString();

  if (!force && process.env.RETENTION_SWEEP !== '1') {
    console.info(
      `[retention] sweepAll skipped: RETENTION_SWEEP!='1' (caller=${caller}, dryRun=${dryRun})`
    );
    return {
      sweepId,
      startedAt,
      durationMs: Date.now() - startTs,
      hardDelete,
      dryRun,
      skipped: true,
      reason: 'RETENTION_SWEEP env flag not set to 1',
      policies: [],
      totals: { scanned: 0, softDeleted: 0, hardDeleted: 0, bytesReclaimed: 0, errors: 0 },
    };
  }

  // ── Pre-flight probes (CTO G1.P) ──
  // dryRun is observation-only; the (b) UDF and (e) schema-drift probes are
  // destructive-action prerequisites, so they only run for real sweeps.
  // Both fail-closed: write retention_event severity='error' and abort the
  // sweep so retention-watchdog's error counter sees the incident.
  if (!dryRun) {
    // G1.P §3.b: probe is_sweeping() UDF before any destructive action.
    // If the UDF is missing the change_log_no_delete trigger will fire and
    // ABORT every DELETE — fail loudly here instead of partially-completing.
    try {
      db.prepare('SELECT is_sweeping() AS s').get();
    } catch (err) {
      const note = `is_sweeping() UDF probe failed: ${err.message}`;
      console.error(`[retention] sweepAll abort: ${note}`);
      try {
        insertRetentionEvent({
          policy: '__udf_probe__',
          sweep_id: sweepId,
          severity: 'error',
          scanned: 0,
          soft_deleted: 0,
          hard_deleted: 0,
          bytes_reclaimed: 0,
          duration_ms: Date.now() - startTs,
          caller,
          started_at: startedAt,
          error: err.message,
          note,
        });
      } catch (auditErr) {
        console.warn('[retention] UDF probe audit write failed:', auditErr.message);
      }
      return {
        sweepId,
        startedAt,
        durationMs: Date.now() - startTs,
        hardDelete,
        dryRun: false,
        caller,
        skipped: true,
        reason: 'is_sweeping_udf_missing',
        policies: [],
        totals: { scanned: 0, softDeleted: 0, hardDeleted: 0, bytesReclaimed: 0, errors: 1 },
      };
    }

    // G1.P §3.e: schema-drift guard for retention_event. The 13 columns are
    // frozen; if a future migration drops one (or adds one without bumping
    // this list) every audit write becomes silently lossy. Detect at sweepAll
    // entry and abort.
    const EXPECTED_RETENTION_EVENT_COLS = [
      'id', 'started_at', 'policy', 'scanned', 'soft_deleted', 'hard_deleted',
      'bytes_reclaimed', 'duration_ms', 'caller', 'error', 'severity', 'note',
      'sweep_id',
    ];
    try {
      const actual = db.prepare('PRAGMA table_info(retention_event)').all().map((r) => r.name);
      const actualSet = new Set(actual);
      const expectedSet = new Set(EXPECTED_RETENTION_EVENT_COLS);
      const missing = EXPECTED_RETENTION_EVENT_COLS.filter((c) => !actualSet.has(c));
      const extra = actual.filter((c) => !expectedSet.has(c));
      if (missing.length || extra.length) {
        const note = `schema drift: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`;
        console.error(`[retention] sweepAll abort: retention_event ${note}`);
        try {
          insertRetentionEvent({
            policy: '__schema_drift__',
            sweep_id: sweepId,
            severity: 'error',
            scanned: 0,
            soft_deleted: 0,
            hard_deleted: 0,
            bytes_reclaimed: 0,
            duration_ms: Date.now() - startTs,
            caller,
            started_at: startedAt,
            error: note,
            note,
          });
        } catch (auditErr) {
          console.warn('[retention] schema drift audit write failed:', auditErr.message);
        }
        return {
          sweepId,
          startedAt,
          durationMs: Date.now() - startTs,
          hardDelete,
          dryRun: false,
          caller,
          skipped: true,
          reason: 'retention_event_schema_drift',
          policies: [],
          totals: { scanned: 0, softDeleted: 0, hardDeleted: 0, bytesReclaimed: 0, errors: 1 },
        };
      }
    } catch (err) {
      // PRAGMA table_info itself failed — treat as drift-class incident.
      const note = `schema-drift probe failed: ${err.message}`;
      console.error(`[retention] sweepAll abort: ${note}`);
      try {
        insertRetentionEvent({
          policy: '__schema_drift__',
          sweep_id: sweepId,
          severity: 'error',
          scanned: 0,
          soft_deleted: 0,
          hard_deleted: 0,
          bytes_reclaimed: 0,
          duration_ms: Date.now() - startTs,
          caller,
          started_at: startedAt,
          error: err.message,
          note,
        });
      } catch (auditErr) {
        console.warn('[retention] schema drift probe audit write failed:', auditErr.message);
      }
      return {
        sweepId,
        startedAt,
        durationMs: Date.now() - startTs,
        hardDelete,
        dryRun: false,
        caller,
        skipped: true,
        reason: 'retention_event_schema_drift_probe_failed',
        policies: [],
        totals: { scanned: 0, softDeleted: 0, hardDeleted: 0, bytesReclaimed: 0, errors: 1 },
      };
    }
  }

  const allPolicies = getRetentionPolicies();
  const filter = Array.isArray(only) && only.length > 0 ? new Set(only) : null;
  const policies = filter ? allPolicies.filter((p) => filter.has(p.name)) : allPolicies;

  // ── dryRun branch ─────────────────────────────────────
  // Observation-only: run the candidate SELECT for each policy, no writes.
  if (dryRun) {
    const clampedSample = Math.max(0, Math.min(Number(sampleLimit) | 0 || DRY_RUN_SAMPLE_DEFAULT, DRY_RUN_SAMPLE_MAX));
    const dryCaller = `dryrun-${caller}`;
    const dryResults = [];
    const dryTotals = { scanned: 0, softDeleted: 0, hardDeleted: 0, bytesReclaimed: 0, errors: 0 };

    for (const policy of policies) {
      const pStart = Date.now();
      const r = { policy: policy.name, wouldDelete: 0, sample: [], errors: [] };

      // customSweep branch: defer to sweepPolicy(..., dryRun:true) so the
      // policy's custom handler sees dryRun and writes its own single audit
      // row through sweepPolicy. Keeps memories_ttl's FTS-aware dryRun path
      // consistent with the generic dryRun shape.
      if (typeof policy.customSweep === 'function') {
        const m = sweepPolicy(policy, {
          hardDelete,
          caller: dryCaller,
          severity,
          sweepId,
          startedAt,
          dryRun: true,
          sampleLimit: clampedSample,
        });
        r.wouldDelete = m.scanned || 0;
        r.sample = Array.isArray(m.sample) ? m.sample : [];
        if (m.error) {
          r.errors.push(m.error);
          dryTotals.errors++;
        }
        dryTotals.scanned += r.wouldDelete;
        dryResults.push(r);
        continue;
      }

      let params;
      try {
        params = policy.whereParams ? policy.whereParams() : [];
        if (!Array.isArray(params)) throw new TypeError(`policy[${policy.name}].whereParams() must return an array`);
      } catch (err) {
        r.errors.push(`whereParams failed: ${err.message}`);
        dryTotals.errors++;
        insertRetentionEvent({
          policy: policy.name,
          sweep_id: sweepId,
          scanned: 0,
          duration_ms: Date.now() - pStart,
          caller: dryCaller,
          started_at: startedAt,
          severity,
          note: 'dryRun',
          error: r.errors[0],
        });
        dryResults.push(r);
        continue;
      }

      // Use the same SELECT shape as sweepPolicy (rowIdentifier AS _rid, plus
      // any caller-provided selectColumns) so dryRun sample rows carry both
      // the identifier and any useful diagnostic columns.
      const rowIdentifier = policy.rowIdentifier || 'id';
      const extraCols = policy.selectColumns && policy.selectColumns !== 'id' ? `, ${policy.selectColumns}` : '';
      const selectSql = `SELECT ${rowIdentifier} AS _rid${extraCols} FROM ${policy.table} WHERE ${policy.whereClause} LIMIT ?`;
      let candidates;
      try {
        candidates = db.prepare(selectSql).all(...params, policy.batchSize);
      } catch (err) {
        r.errors.push(`select failed: ${err.message}`);
        dryTotals.errors++;
        insertRetentionEvent({
          policy: policy.name,
          sweep_id: sweepId,
          scanned: 0,
          duration_ms: Date.now() - pStart,
          caller: dryCaller,
          started_at: startedAt,
          severity,
          note: 'dryRun',
          error: r.errors[0],
        });
        dryResults.push(r);
        continue;
      }

      r.wouldDelete = candidates.length;
      r.sample = clampedSample > 0 ? candidates.slice(0, clampedSample) : [];
      dryTotals.scanned += r.wouldDelete;

      insertRetentionEvent({
        policy: policy.name,
        sweep_id: sweepId,
        scanned: r.wouldDelete,
        soft_deleted: 0,
        hard_deleted: 0,
        bytes_reclaimed: 0,
        duration_ms: Date.now() - pStart,
        caller: dryCaller,
        started_at: startedAt,
        severity,
        note: 'dryRun',
      });
      dryResults.push(r);
    }

    // ── dryRun auto_vacuum mode observation (CTO 2026-04-22) ──
    // dryRun SKIPS wal_checkpoint and incremental_vacuum (no side effects on
    // main DB), but the auto_vacuum MODE check is a persistent-config
    // observation that C's soak monitor wants surfaced even in dry mode.
    // If mode != INCREMENTAL, write a severity='warn' audit row (hardcoded
    // 'warn' — the auto_vacuum warn is a fact about the DB, not about the
    // sweep identity, so callers can't override it via opts.severity).
    if (!_autoVacuumIsIncremental()) {
      const note = 'auto_vacuum != INCREMENTAL; incremental_vacuum skipped; run VACUUM offline to enable';
      if (!_warnedAutoVacuumOnce) {
        console.warn(`[retention] (dryRun) ${note}`);
        _warnedAutoVacuumOnce = true;
      }
      try {
        // auto_vacuum check runs INSIDE sweepAll context (per CTO 2026-04-22),
        // so it carries the current sweep_id — losing traceability ("which
        // sweep detected the drift?") outweighs NULL-cleanness.
        insertRetentionEvent({
          policy: '__auto_vacuum_check__',
          sweep_id: sweepId,
          severity: 'warn',
          scanned: 0,
          soft_deleted: 0,
          hard_deleted: 0,
          bytes_reclaimed: 0,
          duration_ms: 0,
          caller: dryCaller,
          started_at: startedAt,
          note,
        });
      } catch (err) {
        console.warn('[retention] (dryRun) auto_vacuum warn audit write failed:', err.message);
      }
    }

    const aggregate = {
      sweepId,
      startedAt,
      durationMs: Date.now() - startTs,
      hardDelete,
      dryRun: true,
      caller,
      sampleLimit: clampedSample,
      policies: dryResults,
      totals: dryTotals,
    };

    try {
      publish('retention_sweep', {
        sweepId,
        startedAt,
        durationMs: aggregate.durationMs,
        hardDelete,
        dryRun: true,
        caller,
        totals: dryTotals,
        policies: dryResults.map((r) => ({
          policy: r.policy,
          wouldDelete: r.wouldDelete,
          errors: r.errors,
        })),
      });
    } catch (err) {
      console.warn('[retention] event publish (dryRun) failed:', err.message);
    }

    return aggregate;
  }

  const results = [];
  const totals = {
    scanned: 0,
    softDeleted: 0,
    hardDeleted: 0,
    bytesReclaimed: 0,
    errors: 0,
  };

  // Snapshot DB file size before any deletes so we can measure disk bytes
  // actually released once incremental_vacuum runs at the end.
  const fileBytesBefore = _dbFileBytes();

  // ── Flag ON for the entire policy loop (CTO-ruled 2026-04-22) ──
  // One-shot sweep, one-shot flag. try/finally guarantees the flag is cleared
  // even if a sweepPolicy throws — leaving it stuck ON would disable the
  // change_log append-only guarantee for every subsequent non-sweep writer.
  // The flag is also mirrored to db.mjs via setRetentionSweeping() so the
  // is_sweeping() SQL UDF returns 1 for the trigger WHEN clause.
  _sweepActive = true;
  setRetentionSweeping(true);
  try {
    for (const policy of policies) {
      const r = sweepPolicy(policy, { hardDelete, caller, severity, sweepId, startedAt });
      results.push(r);
      totals.scanned += r.scanned;
      totals.softDeleted += r.softDeleted;
      totals.hardDeleted += r.hardDeleted;
      if (r.error) totals.errors++;
    }
  } finally {
    _sweepActive = false;
    setRetentionSweeping(false);
  }

  // ── Post-sweep: WAL checkpoint + incremental_vacuum ──
  // Release freelist pages to disk so bytes_reclaimed reflects actual disk
  // savings, not just freelist growth. Only run if at least one hard-delete
  // happened — soft-deletes don't free pages.
  let bytesReclaimed = 0;
  let vacuumNote = null;
  if (totals.hardDeleted > 0) {
    try {
      // TRUNCATE: flush WAL to main, then truncate the WAL file. Global, not
      // per-policy, which is why it lives here.
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.warn('[retention] wal_checkpoint(TRUNCATE) failed:', err.message);
      // G1.P §3.d: force severity='error' for WAL checkpoint failure (was console.warn-only).
      // WAL bloat is one of the 201GB-class incident vectors; it must surface to the watchdog.
      try {
        insertRetentionEvent({
          policy: '__wal_checkpoint__',
          sweep_id: sweepId,
          severity: 'error',
          scanned: 0,
          soft_deleted: 0,
          hard_deleted: 0,
          bytes_reclaimed: 0,
          duration_ms: 0,
          caller,
          started_at: startedAt,
          error: err.message,
          note: 'wal_checkpoint(TRUNCATE) failed',
        });
      } catch (auditErr) {
        console.warn('[retention] wal_checkpoint error audit write failed:', auditErr.message);
      }
      totals.errors++;
    }

    if (_autoVacuumIsIncremental()) {
      try {
        db.pragma('incremental_vacuum');
      } catch (err) {
        console.warn('[retention] incremental_vacuum failed:', err.message);
      }
    } else {
      vacuumNote = 'auto_vacuum != INCREMENTAL; skipped incremental_vacuum (requires full VACUUM to enable)';
      // CTO backfill: log AND write a persistent warn row so ops history
      // surfaces the mismatch even if stdout is not captured.
      if (!_warnedAutoVacuumOnce) {
        console.warn(`[retention] ${vacuumNote} — follow-up: run VACUUM + set PRAGMA auto_vacuum=INCREMENTAL offline to enable incremental reclaim`);
        _warnedAutoVacuumOnce = true;
      }
      try {
        insertRetentionEvent({
          policy: '__auto_vacuum_check__',
          sweep_id: sweepId,
          severity: 'warn',
          scanned: 0,
          soft_deleted: 0,
          hard_deleted: 0,
          bytes_reclaimed: 0,
          duration_ms: 0,
          caller,
          started_at: startedAt,
          note: 'auto_vacuum != INCREMENTAL; incremental_vacuum skipped; run VACUUM offline to enable',
        });
      } catch (err) {
        console.warn('[retention] auto_vacuum warn audit write failed:', err.message);
      }
    }

    const fileBytesAfter = _dbFileBytes();
    bytesReclaimed = Math.max(0, fileBytesBefore - fileBytesAfter);
    totals.bytesReclaimed = bytesReclaimed;

    // Attribute the reclaimed-bytes number to a synthetic aggregate audit row
    // so per-policy rows remain truthful (they can't measure disk delta
    // individually — vacuum is once-per-run).
    insertRetentionEvent({
      policy: '__sweepAll__',
      sweep_id: sweepId,
      scanned: totals.scanned,
      soft_deleted: totals.softDeleted,
      hard_deleted: totals.hardDeleted,
      bytes_reclaimed: bytesReclaimed,
      duration_ms: Date.now() - startTs,
      caller,
      started_at: startedAt,
      severity,
      error: vacuumNote,
    });
  }

  const aggregate = {
    sweepId,
    startedAt,
    durationMs: Date.now() - startTs,
    hardDelete,
    dryRun: false,
    caller,
    policies: results,
    totals,
    ...(vacuumNote ? { vacuumNote } : {}),
  };

  try {
    publish('retention_sweep', {
      sweepId,
      startedAt,
      durationMs: aggregate.durationMs,
      hardDelete,
      dryRun: false,
      caller,
      totals,
      policies: results.map((r) => ({
        policy: r.policy,
        scanned: r.scanned,
        softDeleted: r.softDeleted,
        hardDeleted: r.hardDeleted,
        bytesReclaimed: r.bytesReclaimed,
        durationMs: r.durationMs,
        ...(r.error ? { error: r.error } : {}),
      })),
    });
  } catch (err) {
    console.warn('[retention] event publish failed:', err.message);
  }

  return aggregate;
}

export default { sweepAll, sweepPolicy, DEFAULT_HARD_DELETE };
