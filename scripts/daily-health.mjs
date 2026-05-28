#!/usr/bin/env node
/**
 * TeamMCP — Daily Health Report
 *
 * Task G0.3. Computes DB health metrics and posts a concise summary to
 *   #teammcp-dev  (group channel)
 *   DM to CEO
 *   DM to Audit
 *
 * Metrics:
 *   1. teammcp.db file size (MB)
 *   2. Top 5 largest tables by row count
 *   3. `pending_approvals` backlog (status='pending')
 *
 * DB access is read-only. No schema or row writes.
 *
 * Env:
 *   TEAMMCP_HOME  — TeamMCP root (default: ~/.teammcp). DB resolved to
 *                   $TEAMMCP_HOME/data/teammcp.db, matching server/lib/paths.mjs.
 *   TEAMMCP_URL   — Server URL (default: http://localhost:3100)
 *   TEAMMCP_KEY   — API key for the posting agent (falls back to A's key
 *                   via $TEAMMCP_KEY; no hardcoding).
 *
 * Flags:
 *   --dry-run   Compute + print summary to stdout, do not POST.
 *
 * Exit codes:
 *   0  success
 *   1  config / DB error
 *   2  one or more sends failed (others may have succeeded)
 */

import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Config ─────────────────────────────────────────────────
const TEAMMCP_HOME = process.env.TEAMMCP_HOME || join(homedir(), '.teammcp');
const DB_PATH      = join(TEAMMCP_HOME, 'data', 'teammcp.db');
const API_URL      = process.env.TEAMMCP_URL || 'http://localhost:3100';
const API_KEY      = process.env.TEAMMCP_KEY;

const DRY_RUN = process.argv.includes('--dry-run');

const CHANNEL_GROUP = 'teammcp-dev';
const DM_RECIPIENTS = ['CEO', 'Audit'];

// ── Metrics collection ─────────────────────────────────────
function collectMetrics() {
  // DB file size (MB)
  const dbStat = statSync(DB_PATH);
  const dbSizeMB = dbStat.size / (1024 * 1024);

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  // Top 5 tables by row count.
  // SELECT name FROM sqlite_master then COUNT(*) per table.
  const tables = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%'
     ORDER BY name`
  ).all();

  const counts = [];
  for (const { name } of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get();
      counts.push({ name, rows: row.c });
    } catch {
      // Skip any table we can't count (virtual/shadow)
    }
  }
  counts.sort((a, b) => b.rows - a.rows);
  const top5 = counts.slice(0, 5);

  // pending_approvals backlog
  let pendingApprovals = 0;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM pending_approvals WHERE status='pending'`
    ).get();
    pendingApprovals = row.c;
  } catch (e) {
    // Table may not exist in older DBs; report 0 with a flag
    pendingApprovals = -1;
  }

  // ── Team chatter / idle detection ──────────────────────
  // Last non-System message timestamp on #teammcp-dev. Used to detect
  // group-wide idle / deadlock (see 2026-04-22 incident: 74h zombie team
  // went undetected because DB metrics looked normal).
  // Threshold via env TEAM_IDLE_WARN_HOURS (default 24, 0 disables).
  let chatter = null; // { lastTs, lastFrom, idleHours, threshold, disabled, error, none }
  const rawThr = process.env.TEAM_IDLE_WARN_HOURS;
  const threshold = rawThr === undefined ? 24 : parseInt(rawThr, 10);
  if (Number.isNaN(threshold) || threshold < 0) {
    chatter = { error: `Invalid TEAM_IDLE_WARN_HOURS=${rawThr}`, threshold: 24 };
  } else if (threshold === 0) {
    chatter = { disabled: true, threshold: 0 };
  } else {
    try {
      const row = db.prepare(
        `SELECT created_at, from_agent FROM messages
         WHERE channel_id = 'teammcp-dev'
           AND from_agent != 'System'
           AND from_agent IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`
      ).get();
      if (!row) {
        chatter = { none: true, threshold };
      } else {
        // created_at may be ISO ('2026-04-25T...') or SQLite default
        // ('YYYY-MM-DD HH:MM:SS' UTC). Date parses ISO directly; for the
        // SQLite default form append 'Z' so it's read as UTC.
        let ts = row.created_at;
        if (typeof ts === 'string' && !ts.includes('T') && !ts.endsWith('Z')) {
          ts = ts.replace(' ', 'T') + 'Z';
        }
        const lastMs = Date.parse(ts);
        if (Number.isNaN(lastMs)) {
          chatter = { error: `Unparseable created_at: ${row.created_at}`, threshold };
        } else {
          const idleHours = (Date.now() - lastMs) / 3600000;
          chatter = {
            lastTs: new Date(lastMs).toISOString(),
            lastFrom: row.from_agent,
            idleHours,
            threshold,
          };
        }
      }
    } catch (e) {
      chatter = { error: e.message, threshold };
    }
  }

  db.close();
  return { dbSizeMB, top5, pendingApprovals, chatter };
}

// ── Formatter ──────────────────────────────────────────────
function formatChatter(chatter) {
  if (!chatter) return null;
  if (chatter.disabled) return null; // threshold=0, omit entirely
  if (chatter.error) {
    return `Team chatter check failed: ${chatter.error}`;
  }
  if (chatter.none) {
    return 'Team chatter: NO non-system messages ever found ⚠️';
  }
  const idleStr = chatter.idleHours.toFixed(1);
  if (chatter.idleHours > chatter.threshold) {
    return [
      '⚠️ TEAM IDLE WARNING:',
      `  Last #teammcp-dev non-system message: ${chatter.lastTs} by ${chatter.lastFrom}`,
      `  Idle for: ${idleStr}h (threshold: ${chatter.threshold}h)`,
      '  Possible cause: deadlock, all agents zombie, or genuine quiet period',
    ].join('\n');
  }
  return `Team chatter: last @ ${chatter.lastTs} by ${chatter.lastFrom} (${idleStr}h ago) ✓`;
}

function formatSummary({ dbSizeMB, top5, pendingApprovals, chatter }) {
  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16);

  const lines = [];
  lines.push(`[daily-health] ${stamp}`);
  lines.push(`DB size: ${dbSizeMB.toFixed(2)} MB`);
  lines.push(`Top 5 tables (by rows):`);
  for (const t of top5) {
    lines.push(`  - ${t.name}: ${t.rows} rows`);
  }
  const backlogTxt = pendingApprovals < 0
    ? 'pending_approvals: (table missing)'
    : `pending_approvals backlog: ${pendingApprovals}`;
  lines.push(backlogTxt);

  const chatterLine = formatChatter(chatter);
  if (chatterLine) lines.push(chatterLine);

  return lines.join('\n');
}

// ── Sender ─────────────────────────────────────────────────
async function postMessage(channel, content) {
  const resp = await fetch(`${API_URL}/api/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ channel, content }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`POST /api/send → ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  let metrics;
  try {
    metrics = collectMetrics();
  } catch (e) {
    console.error(`[daily-health] Metrics collection failed: ${e.message}`);
    process.exit(1);
  }

  const summary = formatSummary(metrics);
  console.log(summary);

  if (DRY_RUN) {
    console.log('\n[daily-health] DRY RUN — no messages sent.');
    return;
  }

  if (!API_KEY) {
    console.error('[daily-health] TEAMMCP_KEY is not set. Cannot post.');
    process.exit(1);
  }

  const targets = [
    CHANNEL_GROUP,
    ...DM_RECIPIENTS.map((r) => `dm:${r}`),
  ];

  let failures = 0;
  for (const target of targets) {
    try {
      const r = await postMessage(target, summary);
      console.log(`[daily-health] sent → ${target} (id: ${r.id || '?'})`);
    } catch (e) {
      failures++;
      console.error(`[daily-health] FAILED → ${target}: ${e.message}`);
    }
  }

  if (failures > 0) process.exit(2);
}

main().catch((e) => {
  console.error(`[daily-health] Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
