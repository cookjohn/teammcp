// server/retention-watchdog.mjs
// G1.N Retention Watchdog — soak-pre-gate hard-blocker.
// Implements §9 of gate1.rollback_protocol (CEO+CTO co-signed 2026-04-22).
//
// FOUR TRACKS monitored concurrently (§2 hard auto-rollback conditions):
//   1. DB-size track (§2.1)        — 60s tick, 1h rolling window, trigger if delta > 500MB.
//   2. Business-table track (§2.4) — 300s tick, 1h window, trigger on any table
//                                    DELETE ratio > 5% in 1h.
//      Business tables: messages, tasks, agents, channels, approvals
//      (pending_approvals used as the approvals-backed source table — see below).
//   3. Error-rate track (§2.2)     — 60s poll of retention_event rows with
//                                    severity='error' AND started_at > now-15min.
//                                    Trigger when count > 5. No eventbus publish
//                                    exists for retention_event inserts (verified
//                                    in retention.mjs), so polling is required.
//   4. Sweep-liveness track (§2.3) — 300s tick, query MAX(started_at) from
//                                    retention_event. Trigger if > 12h ago.
//                                    Bootstrap: if table empty, treat as "live"
//                                    until first sweep.
//
// ROLLBACK ACTION (§4 five-step sequence, triggered at most once per process):
//   1. await stopMemoryEngine()
//   2. process.env.MEMORY_ENGINE = 'off'
//   3. Log HR-action line requesting PS1 persistence (code cannot write PS1).
//   4. setState('gate1', 'rollback_triggered', {...}) via db.mjs setState().
//   5. saveMessage('teammcp-dev', 'System', "🚨 AUTO ROLLBACK: <reason>", ...).
//
// STARTUP GUARDS (§6):
//   - WATCHDOG_DISABLED=1 env → short-circuit with log.
//   - Active gate1.rollback_triggered + no valid RETRY_SIGNOFF → refuse + broadcast.
//   - RETRY_SIGNOFF=<state_key> env → validate 3 required fields
//     (root_cause_ref / cto_signature / evidence_verified) before allowing.
//
// USAGE (manual / soak-start only — NOT auto-registered in index.mjs per §9 ruling):
//   import { startWatchdog, stopWatchdog } from './retention-watchdog.mjs';
//   startWatchdog({ caller: 'soak-start' });
//   // ... soak runs ...
//   stopWatchdog();

import db, {
  getState,
  setState,
  saveMessage,
  insertRetentionEvent,  // unused in prod; exposed here to let verification tests synthesize rows
} from './db.mjs';
import { stopMemoryEngine } from './memory.mjs';

// ── Constants per §9 ────────────────────────────────────

const DB_SIZE_TICK_MS = 60 * 1000;           // 60s
const BUSINESS_TICK_MS = 5 * 60 * 1000;      // 300s
const ERROR_RATE_TICK_MS = 60 * 1000;        // 60s
const LIVENESS_TICK_MS = 5 * 60 * 1000;      // 300s

const DB_SIZE_WINDOW_SAMPLES = 60;           // 60 × 60s = 1h rolling window
const BUSINESS_WINDOW_SAMPLES = 12;          // 12 × 300s = 1h window

const DB_SIZE_DELTA_THRESHOLD_BYTES = 500 * 1024 * 1024;   // 500MB (§2.1)
const BUSINESS_DELETE_RATIO_THRESHOLD = 0.05;              // 5%   (§2.4)
const ERROR_RATE_WINDOW_MIN = 15;                          // 15min (§2.2)
const ERROR_RATE_THRESHOLD = 5;                            // >5   (§2.2)
const LIVENESS_STALENESS_HOURS = 12;                       // 12h  (§2.3)

// Business tables per §2.4. Using pending_approvals as the 'approvals' surface
// (it's the concrete approvals-backed table in db.mjs schema). Sanity-check
// each table at first sample and silently drop any that don't exist.
const BUSINESS_TABLES = ['messages', 'tasks', 'agents', 'channels', 'pending_approvals'];

const BROADCAST_CHANNEL = 'teammcp-dev';
const BROADCAST_ACTOR = 'System';            // Matches precedent (index.mjs, sse.mjs).

// ── Module state ────────────────────────────────────────

let _running = false;
let _rollbackFired = false;  // one-shot
let _timers = {
  dbSize: null,
  business: null,
  errorRate: null,
  liveness: null,
};
let _dbSizeWindow = [];       // ring of { ts, bytes }
let _businessWindow = {};     // table → ring of { ts, count }
let _startedAt = null;
let _lastTickStatus = {};     // diagnostic: last tick per track
let _caller = 'unknown';

function log(...args) {
  const time = new Date().toISOString();
  console.log(`[${time}] [Watchdog]`, ...args);
}
function logWarn(...args) {
  const time = new Date().toISOString();
  console.warn(`[${time}] [Watchdog]`, ...args);
}
function logError(...args) {
  const time = new Date().toISOString();
  console.error(`[${time}] [Watchdog]`, ...args);
}

// ── Sample helpers ──────────────────────────────────────

function sampleDbBytes() {
  const page = db.pragma('page_size', { simple: true });
  const total = db.pragma('page_count', { simple: true });
  return Number(total) * Number(page);
}

function sampleTableCount(table) {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
    return Number(r?.cnt) || 0;
  } catch {
    return null;  // table missing → skip silently
  }
}

function countErrorEvents() {
  // severity='error' inserts in the last 15min. started_at is ISO text.
  const cutoff = new Date(Date.now() - ERROR_RATE_WINDOW_MIN * 60 * 1000).toISOString();
  const r = db.prepare(
    `SELECT COUNT(*) AS cnt FROM retention_event WHERE severity = 'error' AND started_at > ?`
  ).get(cutoff);
  return Number(r?.cnt) || 0;
}

function getMaxRetentionEventTs() {
  const r = db.prepare(`SELECT MAX(started_at) AS max_ts FROM retention_event`).get();
  return r?.max_ts || null;
}

function countRetentionEventRows() {
  const r = db.prepare(`SELECT COUNT(*) AS cnt FROM retention_event`).get();
  return Number(r?.cnt) || 0;
}

// ── Ring-buffer helpers ─────────────────────────────────

function pushRing(ring, entry, maxSamples) {
  ring.push(entry);
  while (ring.length > maxSamples) ring.shift();
}

// ── Rollback sequence (§4) ──────────────────────────────

async function triggerRollback(reason, metricSnapshot) {
  if (_rollbackFired) {
    log(`Rollback already fired; ignoring new trigger: ${reason}`);
    return;
  }
  _rollbackFired = true;
  logError(`🚨 ROLLBACK TRIGGERING — reason="${reason}"`);

  const ts = new Date().toISOString();

  // Step 1: drain memory engine.
  try {
    await stopMemoryEngine();
    log('[ROLLBACK step 1/5] stopMemoryEngine() completed');
  } catch (err) {
    logError(`[ROLLBACK step 1/5] stopMemoryEngine failed: ${err.message}`);
  }

  // Step 2: in-memory env off.
  try {
    process.env.MEMORY_ENGINE = 'off';
    log('[ROLLBACK step 2/5] process.env.MEMORY_ENGINE = "off"');
  } catch (err) {
    logError(`[ROLLBACK step 2/5] env set failed: ${err.message}`);
  }

  // Step 3: loud log for HR to persist PS1.
  logError('[WATCHDOG ROLLBACK] HR must persist: $env:MEMORY_ENGINE="off" in start-prod.ps1');

  // Step 4: set_state gate1.rollback_triggered.
  try {
    const payload = {
      reason,
      metric_snapshot: metricSnapshot,
      ts,
      auto_stopped: true,
    };
    const res = setState(
      'gate1',
      'rollback_triggered',
      payload,
      'retention-watchdog',
      `auto-rollback: ${reason}`,
      { systemWrite: true, allowFieldCreation: true }
    );
    if (res && res.error) {
      logError(`[ROLLBACK step 4/5] setState error: ${JSON.stringify(res)}`);
    } else {
      log(`[ROLLBACK step 4/5] set_state gate1.rollback_triggered (v=${res?.version})`);
    }
  } catch (err) {
    logError(`[ROLLBACK step 4/5] setState failed: ${err.message}`);
  }

  // Step 5: broadcast to #teammcp-dev.
  try {
    saveMessage(
      BROADCAST_CHANNEL,
      BROADCAST_ACTOR,
      `🚨 AUTO ROLLBACK: ${reason}`,
      null,
      null,
      JSON.stringify({ source: 'retention-watchdog', metric_snapshot: metricSnapshot, ts })
    );
    log('[ROLLBACK step 5/5] broadcast sent to #teammcp-dev');
  } catch (err) {
    logError(`[ROLLBACK step 5/5] broadcast failed: ${err.message}`);
  }

  // Step 6 (G1.N §6.3): append last_rollback to gate1.rollback_history (log-only,
  // not a refuse gate). Wrapped in a single try/catch covering the entire
  // read → parse → append → setState chain so a history-write failure CANNOT
  // unwind or block the §4 5-step rollback semantics above.
  try {
    let history = [];
    const existing = getState('gate1', 'rollback_history');
    if (existing && existing.value) {
      try {
        const parsed = typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value;
        if (Array.isArray(parsed)) history = parsed;
      } catch {
        // Corrupt prior value — drop it silently and start fresh.
        // (history is observability, not gating; we never refuse on it.)
      }
    }
    history.push({
      reason,
      metric_snapshot: metricSnapshot,
      ts,
      auto_stopped: true,
    });
    // Cap at 50 entries (oldest dropped) — this is the retention project,
    // we cannot ourselves write unbounded state.
    if (history.length > 50) history = history.slice(-50);
    const res = setState(
      'gate1',
      'rollback_history',
      history,
      'retention-watchdog',
      `auto-rollback history append: ${reason}`,
      { systemWrite: true, allowFieldCreation: true }
    );
    if (res && res.error) {
      logError(`[ROLLBACK step 6/6] rollback_history setState error (non-fatal): ${JSON.stringify(res)}`);
    } else {
      log(`[ROLLBACK step 6/6] appended to gate1.rollback_history (entries=${history.length}, v=${res?.version})`);
    }
  } catch (err) {
    // Non-blocking: history is observability, not gating.
    logError(`[ROLLBACK step 6/6] failed to append rollback_history (non-fatal): ${err.message}`);
  }

  // Tear down our own timers — no point continuing to monitor once rollback fires.
  _clearAllTimers();
  _running = false;
}

// ── Per-tick handlers (each wrapped in try/catch per §9) ──

function tickDbSize() {
  try {
    const bytes = sampleDbBytes();
    const now = Date.now();
    pushRing(_dbSizeWindow, { ts: now, bytes }, DB_SIZE_WINDOW_SAMPLES);
    _lastTickStatus.dbSize = { ts: now, bytes, samples: _dbSizeWindow.length };

    if (_dbSizeWindow.length < 2) return;
    const oldest = _dbSizeWindow[0];
    const delta = bytes - oldest.bytes;
    if (delta > DB_SIZE_DELTA_THRESHOLD_BYTES) {
      triggerRollback(
        `DB size grew ${Math.round(delta / 1024 / 1024)}MB over ${Math.round((now - oldest.ts) / 60000)}min (threshold 500MB/1h)`,
        { track: 'db_size', delta_bytes: delta, window_ms: now - oldest.ts, current_bytes: bytes }
      ).catch((err) => logError('rollback promise rejected:', err.message));
    }
  } catch (err) {
    logError(`tickDbSize failed (non-fatal): ${err.message}`);
  }
}

function tickBusiness() {
  try {
    const now = Date.now();
    const violations = [];
    for (const table of BUSINESS_TABLES) {
      const count = sampleTableCount(table);
      if (count == null) continue;  // table doesn't exist in this DB
      if (!_businessWindow[table]) _businessWindow[table] = [];
      pushRing(_businessWindow[table], { ts: now, count }, BUSINESS_WINDOW_SAMPLES);

      const ring = _businessWindow[table];
      if (ring.length < 2) continue;
      const oldest = ring[0];
      // DELETE delta = decrease in row count (insert growth counted as negative delete).
      // §2.4: "DELETE row delta > 该表当前 row count 的 5%"
      const deleteDelta = oldest.count - count;
      if (deleteDelta <= 0) continue;  // growing table → no deletes dominate
      const ratio = count > 0 ? deleteDelta / count : (deleteDelta > 0 ? 1 : 0);
      if (ratio > BUSINESS_DELETE_RATIO_THRESHOLD) {
        violations.push({ table, deleteDelta, ratio, current: count, prior: oldest.count });
      }
    }
    _lastTickStatus.business = { ts: now, samples: Object.fromEntries(Object.entries(_businessWindow).map(([t, r]) => [t, r.length])) };

    if (violations.length > 0) {
      const v = violations[0];
      triggerRollback(
        `Business-table pollution: ${v.table} DELETE ratio ${(v.ratio * 100).toFixed(2)}% > 5% in 1h window (${v.deleteDelta} rows deleted, current=${v.current})`,
        { track: 'business_table', violations }
      ).catch((err) => logError('rollback promise rejected:', err.message));
    }
  } catch (err) {
    logError(`tickBusiness failed (non-fatal): ${err.message}`);
  }
}

function tickErrorRate() {
  try {
    const count = countErrorEvents();
    _lastTickStatus.errorRate = { ts: Date.now(), count };
    if (count > ERROR_RATE_THRESHOLD) {
      triggerRollback(
        `retention_event severity='error' count=${count} > ${ERROR_RATE_THRESHOLD} in last ${ERROR_RATE_WINDOW_MIN}min`,
        { track: 'error_rate', count, window_min: ERROR_RATE_WINDOW_MIN }
      ).catch((err) => logError('rollback promise rejected:', err.message));
    }
  } catch (err) {
    logError(`tickErrorRate failed (non-fatal): ${err.message}`);
  }
}

function tickLiveness() {
  try {
    const totalRows = countRetentionEventRows();
    _lastTickStatus.liveness = { ts: Date.now(), rows: totalRows };

    // Bootstrap: if no retention_event rows ever, treat as "live" (first sweep
    // hasn't run yet on a fresh DB — don't falsely trigger).
    if (totalRows === 0) return;

    const maxTs = getMaxRetentionEventTs();
    if (!maxTs) return;
    const ageMs = Date.now() - new Date(maxTs).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    _lastTickStatus.liveness.ageHours = ageHours;
    if (ageHours > LIVENESS_STALENESS_HOURS) {
      triggerRollback(
        `No retention_event written in ${ageHours.toFixed(1)}h (threshold ${LIVENESS_STALENESS_HOURS}h); last seen at ${maxTs}`,
        { track: 'sweep_liveness', max_started_at: maxTs, age_hours: ageHours }
      ).catch((err) => logError('rollback promise rejected:', err.message));
    }
  } catch (err) {
    logError(`tickLiveness failed (non-fatal): ${err.message}`);
  }
}

// ── Timer lifecycle ─────────────────────────────────────

function _clearAllTimers() {
  for (const k of Object.keys(_timers)) {
    if (_timers[k]) {
      clearInterval(_timers[k]);
      _timers[k] = null;
    }
  }
}

// ── Startup validation (§6) ─────────────────────────────

function _validateRetrySignoff(stateKey) {
  // stateKey format: "<project_id>.<field>" (e.g. "gate1.retry_1_signoff")
  // Parse liberally: split on first '.'.
  if (!stateKey || typeof stateKey !== 'string') {
    return { ok: false, reason: 'RETRY_SIGNOFF env is not a string' };
  }
  const dotIdx = stateKey.indexOf('.');
  if (dotIdx < 0) {
    return { ok: false, reason: `RETRY_SIGNOFF malformed (expected 'project.field'): ${stateKey}` };
  }
  const project = stateKey.slice(0, dotIdx);
  const field = stateKey.slice(dotIdx + 1);
  let row;
  try {
    row = getState(project, field);
  } catch (err) {
    return { ok: false, reason: `getState(${project}, ${field}) failed: ${err.message}` };
  }
  if (!row || !row.value) {
    return { ok: false, reason: `RETRY_SIGNOFF target ${stateKey} does not exist` };
  }
  let parsed;
  try {
    parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  } catch (err) {
    return { ok: false, reason: `RETRY_SIGNOFF value is not valid JSON: ${err.message}` };
  }
  const REQUIRED = ['root_cause_ref', 'cto_signature', 'evidence_verified'];
  const missing = REQUIRED.filter((f) => parsed?.[f] == null || parsed[f] === '');
  if (missing.length > 0) {
    return { ok: false, reason: `RETRY_SIGNOFF missing required fields: ${missing.join(', ')}` };
  }
  return { ok: true, stateKey, fields: REQUIRED };
}

// ── Exported API ────────────────────────────────────────

/**
 * Start the retention watchdog. Idempotent (no-op if already running).
 *
 * @param {object} opts
 * @param {string} [opts.caller='unknown'] - audit / diagnostic tag.
 * @returns {{started:boolean, reason?:string}}
 */
export function startWatchdog({ caller = 'unknown' } = {}) {
  if (_running) {
    log('startWatchdog: already running, no-op');
    return { started: false, reason: 'already_running' };
  }

  // Emergency kill switch (§9).
  if (process.env.WATCHDOG_DISABLED === '1') {
    log('startWatchdog short-circuit: WATCHDOG_DISABLED=1 env set');
    return { started: false, reason: 'WATCHDOG_DISABLED' };
  }

  // §6 startup guard: check for active rollback_triggered.
  let rollbackState = null;
  try {
    rollbackState = getState('gate1', 'rollback_triggered');
  } catch (err) {
    logWarn(`startup getState(gate1.rollback_triggered) failed: ${err.message}`);
  }

  if (rollbackState && rollbackState.value) {
    // Active rollback — check RETRY_SIGNOFF bypass.
    const signoffKey = process.env.RETRY_SIGNOFF;
    if (!signoffKey) {
      const msg = 'WATCHDOG REFUSING TO SPAWN: active rollback not cleared';
      logError(msg);
      try {
        saveMessage(BROADCAST_CHANNEL, BROADCAST_ACTOR, msg, null, null,
          JSON.stringify({ source: 'retention-watchdog', caller }));
      } catch (err) {
        logError(`refuse broadcast failed: ${err.message}`);
      }
      return { started: false, reason: 'active_rollback_no_signoff' };
    }
    const v = _validateRetrySignoff(signoffKey);
    if (!v.ok) {
      const msg = `WATCHDOG REFUSING TO SPAWN: active rollback not cleared (${v.reason})`;
      logError(msg);
      try {
        saveMessage(BROADCAST_CHANNEL, BROADCAST_ACTOR, msg, null, null,
          JSON.stringify({ source: 'retention-watchdog', caller, signoff_error: v.reason }));
      } catch (err) {
        logError(`refuse broadcast failed: ${err.message}`);
      }
      return { started: false, reason: 'signoff_invalid', detail: v.reason };
    }
    log(`startup: RETRY_SIGNOFF ${signoffKey} validated (3 required fields present) — allowing start`);
  }

  // All guards passed — start timers.
  _running = true;
  _rollbackFired = false;
  _dbSizeWindow = [];
  _businessWindow = {};
  _lastTickStatus = {};
  _caller = caller;
  _startedAt = new Date().toISOString();

  _timers.dbSize = setInterval(tickDbSize, DB_SIZE_TICK_MS);
  _timers.business = setInterval(tickBusiness, BUSINESS_TICK_MS);
  _timers.errorRate = setInterval(tickErrorRate, ERROR_RATE_TICK_MS);
  _timers.liveness = setInterval(tickLiveness, LIVENESS_TICK_MS);

  // Run first tick immediately so the ring buffers have a starting sample
  // and fail-fast conditions (like already-stale liveness) fire ASAP.
  setImmediate(() => {
    tickDbSize();
    tickBusiness();
    tickErrorRate();
    tickLiveness();
  });

  log(`started (caller=${caller}, tracks: db-size/60s, business/300s, error-rate/60s, liveness/300s)`);
  return { started: true };
}

/**
 * Stop the watchdog (clear timers). Safe to call when not running.
 */
export function stopWatchdog() {
  if (!_running) {
    log('stopWatchdog: not running, no-op');
    return;
  }
  _clearAllTimers();
  _running = false;
  log('stopped');
}

/**
 * Diagnostic snapshot for ops visibility.
 */
export function getWatchdogStatus() {
  return {
    running: _running,
    rollback_fired: _rollbackFired,
    started_at: _startedAt,
    caller: _caller,
    tracks: {
      db_size: {
        samples: _dbSizeWindow.length,
        oldest_ts: _dbSizeWindow[0]?.ts || null,
        newest_ts: _dbSizeWindow[_dbSizeWindow.length - 1]?.ts || null,
      },
      business: Object.fromEntries(
        Object.entries(_businessWindow).map(([t, r]) => [t, { samples: r.length }])
      ),
    },
    last_tick: _lastTickStatus,
    config: {
      db_size_threshold_bytes: DB_SIZE_DELTA_THRESHOLD_BYTES,
      business_ratio_threshold: BUSINESS_DELETE_RATIO_THRESHOLD,
      error_rate_threshold: ERROR_RATE_THRESHOLD,
      error_rate_window_min: ERROR_RATE_WINDOW_MIN,
      liveness_staleness_hours: LIVENESS_STALENESS_HOURS,
    },
  };
}

// Internal helpers exposed only for the test harness (not part of stable API).
export const __testing = {
  triggerRollback,
  tickDbSize,
  tickBusiness,
  tickErrorRate,
  tickLiveness,
  validateRetrySignoff: _validateRetrySignoff,
  resetState() {
    _running = false;
    _rollbackFired = false;
    _clearAllTimers();
    _dbSizeWindow = [];
    _businessWindow = {};
    _lastTickStatus = {};
  },
};

export default { startWatchdog, stopWatchdog, getWatchdogStatus };
