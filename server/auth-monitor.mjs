// Doc-C Layer 3 v0.4 — passive auth monitor (scheme D: projects/**/*.jsonl scan)
// CTO spec 2026-04-09, A 实施
//
// Scheme (E) CLAUDE_CODE_DIAGNOSTICS_FILE was empirically falsified by spike:
// `claude -p` headless path writes NO auth events to the diagnostics file.
// Scheme (D) is the only viable channel: tail CC session jsonl files under
//   <base>/<name>/.claude-config/projects/<cwd-encoded>/<sessionId>.jsonl
// Each claude invocation = a brand new <sessionId>.jsonl (no append to old).
//
// Detection strategy: scan every 2s, for each jsonl track (inode,size); on
// size growth read the new bytes, split lines, cheap regex pre-filter, then
// JSON.parse. Auth failures carry top-level `"error":"authentication_failed"`
// plus `"isApiErrorMessage":true` and a text body containing request_id +
// 401 / Invalid bearer token. Dedup per-file by line hash.
//
// Cold-seed on startup: record (inode,size) for all existing jsonl files
// without reading their content (so server restart doesn't replay historical
// 401s). Jsonl files that APPEAR after cold-seed are treated as fresh and
// scanned from size=0 — this catches every new CC session during runtime.
//
// Dependency injection (from process-manager.mjs):
//   setState(key, value)      — key = 'auth/<agent>/last_failure'
//   sendMessage(channel, fromAgent, content)
//   logger                    — console-compatible
//
// Exports: startAuthMonitor, stopAuthMonitor, clearAgent
// startAuthMonitor(processesRef, agentsBaseDir, deps) signature preserved.

import { readdirSync, existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const POLL_INTERVAL_MS = 2000;
// SecTest #1: must allow `.` for agents like `qwen3.6` (CC encodes `.` as `-`
// in cwd-encoded form, so `qwen3.6` filesystem dir maps to `qwen3-6` cwd-encoded;
// we still need to accept `.` here so the agent dir is walked at all).
const AGENT_NAME_REGEX = /^[A-Za-z0-9_\-.]{1,64}$/;
const PER_FILE_HASH_CAP = 500;
const DEFAULT_FILE_CAP = 5000;
const MIN_FILE_CAP = 100;
const MAX_FILE_CAP = 20000;
function resolveFileCap() {
  const rawEnv = process.env.AUTH_MONITOR_FILE_CAP;
  if (!rawEnv) return DEFAULT_FILE_CAP;
  const n = parseInt(rawEnv, 10);
  if (!Number.isFinite(n)) {
    console.error(`[auth-monitor] AUTH_MONITOR_FILE_CAP="${rawEnv}" is not a number; using default ${DEFAULT_FILE_CAP}`);
    return DEFAULT_FILE_CAP;
  }
  if (n < MIN_FILE_CAP) {
    console.error(`[auth-monitor] AUTH_MONITOR_FILE_CAP=${n} below min ${MIN_FILE_CAP}; clamping`);
    return MIN_FILE_CAP;
  }
  if (n > MAX_FILE_CAP) {
    console.error(`[auth-monitor] AUTH_MONITOR_FILE_CAP=${n} above max ${MAX_FILE_CAP}; clamping`);
    return MAX_FILE_CAP;
  }
  return n;
}
const GLOBAL_FILE_CAP = resolveFileCap();
const READ_CHUNK_MAX = 1 * 1024 * 1024;
const SCAN_DEPTH_DEFAULT = 3;
const SCAN_DEPTH_MAX = 10;
const SENTINEL_OFF = '__AUTH_MONITOR_OFF__';

function getScanDepth() {
  const raw = parseInt(process.env.AUTH_MONITOR_SCAN_DEPTH || '', 10);
  if (!Number.isFinite(raw) || raw < 1) return SCAN_DEPTH_DEFAULT;
  return Math.min(raw, SCAN_DEPTH_MAX);
}

// --- Detection ---------------------------------------------------------------

// v0.3 OUROBOROS FIX 2026-04-09:
// v0.2 line-level regex matched the watcher's own banner string when CC echoed it
// back inside subagent tool_result.content[].text — every agent that received an
// auth alert message would have the alert string in its own JSONL → self-hit loop.
// v0.3 hardens detection by:
//   1. JSON.parse line first; parse failure → null (no text fallback)
//   2. Only match TOP-LEVEL `rec.error === 'authentication_failed'` (literal equality,
//      not regex on serialized line — nested tool_result echoes can't trigger)
//   3. TEXT_REGEX fallback removed (semantic fragility too high)
//   4. When isApiErrorMessage===true, scan ONLY rec.message.content[].text fields
//      typed text/string for `\b401\b.*invalid.*bearer` — not the whole serialized line

const TEXT_401_BEARER = /\b401\b[\s\S]{0,200}invalid[\s\S]{0,40}bearer/i;

export function classifyLine(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!rec || typeof rec !== 'object') return null;

  // v0.3.1 SecTest [HIGH]: tighten record-type filter so subagent tool_result
  // echoes carrying top-level fields cannot self-trigger. CC writes the
  // synthetic auth-failure record only as type:"assistant" + message.role:"assistant".
  // JSONL is strictly one-record-per-line; nested content does not become a top-level record.
  if (rec.type !== 'assistant') return null;
  if (!rec.message || rec.message.role !== 'assistant') return null;
  // Reject tool_result echo paths defensively (a user/tool record incorrectly typed)
  if (rec.role === 'tool' || rec.toolUseResult) return null;

  // Strict top-level check (the assistant-synthetic auth-failure record CC writes)
  const topLevelAuthFail = rec.error === 'authentication_failed';
  const apiErrFlag = rec.isApiErrorMessage === true;
  if (!topLevelAuthFail && !apiErrFlag) return null;

  // If only the apiErrFlag fired, require evidence in the assistant text content
  // to avoid catching unrelated isApiErrorMessage=true paths.
  let messageText = '';
  if (rec.message && Array.isArray(rec.message.content)) {
    for (const part of rec.message.content) {
      if (part && (part.type === 'text' || typeof part.text === 'string')) {
        if (typeof part.text === 'string') messageText += part.text + ' ';
      }
    }
  }
  if (apiErrFlag && !topLevelAuthFail) {
    if (!TEXT_401_BEARER.test(messageText)) return null;
  }

  const sessionId = (typeof rec.sessionId === 'string') ? rec.sessionId : null;
  let requestId = null;
  const m = messageText.match(/request_id":"([^"]+)"/);
  if (m) requestId = m[1];

  const display = (messageText || `auth_failed in session ${sessionId || '?'}`).slice(0, 200);
  return { tag: 'auth_failed', display, sessionId, requestId };
}

// --- State -------------------------------------------------------------------

// Per jsonl path: { inode, size, matchedHashes:Set, lastAccess }
const fileState = new Map();

let timer = null;
let running = false;
let deps = null;
let agentsBaseDirRef = null;

function touch(filePath, entry) {
  fileState.delete(filePath);
  fileState.set(filePath, entry);
  entry.lastAccess = Date.now();
  while (fileState.size > GLOBAL_FILE_CAP) {
    const oldest = fileState.keys().next().value;
    fileState.delete(oldest);
  }
}

function rememberHash(entry, hash) {
  if (entry.matchedHashes.has(hash)) return false;
  entry.matchedHashes.add(hash);
  while (entry.matchedHashes.size > PER_FILE_HASH_CAP) {
    const oldest = entry.matchedHashes.values().next().value;
    entry.matchedHashes.delete(oldest);
  }
  return true;
}

function agentNameFromJsonlPath(jsonlPath) {
  // <base>/<name>/.claude-config/projects/<cwd-encoded>/<session>.jsonl
  // segments from end: [-1]=file, [-2]=cwd-encoded, [-3]=projects, [-4]=.claude-config, [-5]=name
  const parts = jsonlPath.split(/[\\/]/);
  return parts[parts.length - 5] || 'unknown';
}

// v0.4: recursive walker. Walks `root` to find all .jsonl files up to maxDepth.
// depth counts directory levels descended from root (root itself = depth 0).
// CC may stash subagent sessions under projects/<cwd>/subagents/<session>.jsonl
// which the flat walker used to miss.
export function walkJsonlFiles(root, maxDepth = SCAN_DEPTH_DEFAULT) {
  const out = [];
  function walk(dir, depth) {
    if (depth < 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'EACCES') {
        deps?.logger?.error?.(`[auth-monitor] readdir ${dir}: ${e.message}`);
      }
      return;
    }
    for (const d of entries) {
      const p = join(dir, d.name);
      if (d.isFile()) {
        if (d.name.endsWith('.jsonl')) out.push(p);
      } else if (d.isDirectory()) {
        if (depth > 0) walk(p, depth - 1);
      }
    }
  }
  walk(root, Math.min(Math.max(maxDepth, 1), SCAN_DEPTH_MAX));
  return out;
}

// v0.4 hardlink dedup (SecTest hardened):
// 1. BigInt inode key — Windows ReFS uses 128-bit FileId; Number truncation at
//    >2^53 causes silent FALSE dedup of distinct files. statSync(p,{bigint:true}).
// 2. Cross-agent hardlink canonical selection — prod uses xiaomi's distributor
//    which hardlinks the same shared session pool into every agent dir, so an
//    inode legitimately appears under MANY agent dirs. We cannot blanket-refuse.
//    Instead: for each inode, prefer the canonical whose path's agent segment
//    (segments[-5]) matches the cwd-encoded subdir (segments[-2]) decoded agent.
//    The cwd-encoded form is `C--Users-ssdlh-Desktop-agents-<agent>`; that lets
//    us identify the WRITING agent regardless of how many places the file is
//    hardlinked. An attacker who plants a hardlink in their own agent dir cannot
//    cause the canonical to point at their dir unless their cwd-encoded matches.
// 3. statSync errors no longer silently swallowed; logged.
// 4. raw[] hard cap (anti-OOM on adversarial readdir explosion).
const RAW_PATHS_CAP = 100000;
let lastDedupMetric = { rawCount: 0, uniqueCount: 0, ambiguous: 0, statErrors: 0 };

// SecTest v3 fixes (#1-#6):
// #1 extractCwdAgent: regex MUST allow '-' so hyphenated agent names like
//    `arc-agi-3` aren't dropped. CC encodes filesystem path-separators AND `.`
//    as `-`, so `qwen3.6` → `qwen3-6` in cwd-encoded form. We .→- escape the
//    segAgent before comparing, so dotted agent names match.
// #2 Case-insensitive: Windows file system is case-insensitive; compare lowercased.
// #3 Multi self-consistent tiebreaker: if two distinct paths in the same inode
//    are both self-consistent (e.g. attacker plants a self-consistent hardlink),
//    keep the one with EARLIEST mtime (proxy for "actually wrote first"); if mtimes
//    tie, DROP the inode (truly ambiguous).
// #5 metric exposure: lastDedupMetric is also written to state via emitMetricsToState
//    on every scan tick, so dashboards/audit can poll it.
function extractCwdAgent(cwdEncoded) {
  const m = cwdEncoded.match(/-Desktop-agents-([A-Za-z0-9_\-]+)$/);
  return m ? m[1] : null;
}

function normalizeAgent(name) {
  // Mirror CC's encoding (`.` → `-`) and lowercase for Windows-insensitive cmp.
  if (typeof name !== 'string') return null;
  return name.replace(/\./g, '-').toLowerCase();
}

function pathAgentSelfConsistent(p) {
  const parts = p.split(/[\\/]/);
  const idx = parts.indexOf('.claude-config');
  if (idx < 1) return null;
  const segAgent = parts[idx - 1];
  const projectsIdx = parts.indexOf('projects', idx);
  if (projectsIdx < 0 || projectsIdx + 1 >= parts.length) return null;
  const cwdAgent = extractCwdAgent(parts[projectsIdx + 1]);
  if (!cwdAgent) return { segAgent, cwdAgent: null, selfConsistent: false };
  const selfConsistent = normalizeAgent(segAgent) === normalizeAgent(cwdAgent);
  return { segAgent, cwdAgent, selfConsistent };
}

function dedupByInode(rawEntries /* [{path, agent}] */) {
  rawEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // BigInt Map keys use SameValueZero — distinct BigInt values are distinct keys.
  const byIno = new Map(); // BigInt → { selfConsistentPaths: Array<{path,mtimeMs}>, selfConsistentCanonical, statedAt }
  let statErrors = 0;
  for (const { path: p } of rawEntries) {
    let st;
    try { st = statSync(p, { bigint: true }); }
    catch (e) {
      statErrors += 1;
      deps?.logger?.error?.(`[auth-monitor] stat ${p} for dedup: ${e.code || e.message}`);
      continue;
    }
    if (!st.isFile()) continue;
    const key = st.ino;
    let entry = byIno.get(key);
    if (!entry) {
      entry = { selfConsistentPaths: [] };
      byIno.set(key, entry);
    }
    const info = pathAgentSelfConsistent(p);
    if (info && info.selfConsistent) {
      entry.selfConsistentPaths.push({ path: p, mtimeMs: Number(st.mtimeMs) });
    }
  }
  let ambiguousDropped = 0;
  let multiSelfConsistentDropped = 0;
  const out = [];
  for (const entry of byIno.values()) {
    if (entry.selfConsistentPaths.length === 0) {
      ambiguousDropped += 1;
      continue;
    }
    if (entry.selfConsistentPaths.length === 1) {
      out.push(entry.selfConsistentPaths[0].path);
      continue;
    }
    // Multi self-consistent: pick mtime-earliest as canonical (likely the
    // original writer); if mtimes tie within 1ms, drop as truly ambiguous.
    entry.selfConsistentPaths.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const m0 = entry.selfConsistentPaths[0].mtimeMs;
    const m1 = entry.selfConsistentPaths[1].mtimeMs;
    if (Math.abs(m1 - m0) < 1) {
      multiSelfConsistentDropped += 1;
      deps?.logger?.warn?.(`[auth-monitor] multi self-consistent inode mtime-tied, drop: ${entry.selfConsistentPaths.map(e => e.path).join(' | ')}`);
      continue;
    }
    out.push(entry.selfConsistentPaths[0].path);
  }
  if (ambiguousDropped > 0) {
    deps?.logger?.warn?.(`[auth-monitor] dropped ${ambiguousDropped} ambiguous inodes (no self-consistent agent path)`);
  }
  lastDedupMetric = {
    rawCount: rawEntries.length,
    uniqueCount: out.length,
    ambiguousDropped,
    multiSelfConsistentDropped,
    statErrors,
  };
  return out;
}

function listAgentJsonlPaths() {
  // v0.4: sentinel short-circuit BEFORE any readdirSync
  const canary = process.env.AUTH_MONITOR_CANARY;
  if (canary === SENTINEL_OFF) return [];

  let names;
  try {
    names = readdirSync(agentsBaseDirRef, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'EACCES') {
      deps.logger?.error?.(`[auth-monitor] readdir base failed: ${e.message}`);
    }
    return [];
  }
  const depth = getScanDepth();
  // SecTest #4: per-agent quota instead of global FIFO truncation. Prevents an
  // alphabetically-early adversarial agent from eating the entire cap and starving
  // legitimate agents that walk later.
  const validAgents = names.filter(d => d.isDirectory() && AGENT_NAME_REGEX.test(d.name) && (!canary || d.name === canary));
  const perAgentCap = validAgents.length > 0 ? Math.max(100, Math.floor(RAW_PATHS_CAP / validAgents.length)) : RAW_PATHS_CAP;
  const raw = []; // [{path, agent}]
  let truncatedAgents = 0;
  for (const d of validAgents) {
    const projectsDir = join(agentsBaseDirRef, d.name, '.claude-config', 'projects');
    if (!existsSync(projectsDir)) continue;
    const files = walkJsonlFiles(projectsDir, depth);
    let agentTaken = 0;
    for (const p of files) {
      if (agentTaken >= perAgentCap) { truncatedAgents += 1; break; }
      raw.push({ path: p, agent: d.name });
      agentTaken += 1;
    }
  }
  if (truncatedAgents > 0) {
    deps?.logger?.warn?.(`[auth-monitor] per-agent cap ${perAgentCap} hit on ${truncatedAgents} agent(s)`);
  }
  return dedupByInode(raw);
}

async function readRange(filePath, start, end) {
  const length = end - start;
  if (length <= 0) return '';
  const clamped = Math.min(length, READ_CHUNK_MAX);
  const readStart = end - clamped;
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(clamped);
    await fh.read(buf, 0, clamped, readStart);
    return buf.toString('utf-8');
  } finally {
    await fh.close();
  }
}

function emitAlert(agentName, jsonlPath, result) {
  const { tag, display, sessionId, requestId } = result;
  const line = (display || '').trim();
  if (!line) return;
  try {
    deps.setState(`auth/${agentName}/last_failure`, {
      ts: Date.now(),
      line,
      file: jsonlPath,
      reason: 'layer3-jsonl-error',
      tag,
      sessionId,
      requestId,
      event: 'authentication_failed',
    });
    // Doc-A §4.6 wiring: dual-write a single-value event key the HR path-a-driver
    // can subscribe to via subscribe_state pattern `auth/event/*`. Value is the
    // canonical tag (always 'api_auth' for v0.2 JSONL detection).
    deps.setState(`auth/event/${agentName}`, 'api_auth');
    // v0.4: audit state row (LRU self-managed by state system)
    deps.setState(`audit/auth-monitor/${Date.now()}-${agentName}`, {
      ts: Date.now(), agent: agentName, jsonlPath, sessionId, requestId, tag,
    });
  } catch (e) {
    deps.logger?.error?.(`[auth-monitor] setState failed for ${agentName}: ${e.message}`);
  }
  // v0.4: sessionId mismatch detection (jsonl filename sans .jsonl vs rec.sessionId)
  try {
    const parts = jsonlPath.split(/[\\/]/);
    const fname = parts[parts.length - 1] || '';
    const fileSid = fname.endsWith('.jsonl') ? fname.slice(0, -6) : fname;
    if (sessionId && fileSid && sessionId !== fileSid) {
      deps.setState('audit/auth-monitor/sessionId_mismatch', {
        ts: Date.now(), agent: agentName, jsonlPath, fileSid, recSid: sessionId,
      });
      deps.logger?.warn?.(`[auth-monitor] sessionId mismatch ${agentName}: file=${fileSid} rec=${sessionId}`);
    }
  } catch (e) {
    deps.logger?.error?.(`[auth-monitor] sid-mismatch check failed: ${e.message}`);
  }
  try {
    const sidShort = sessionId ? sessionId.slice(0, 8) : '?';
    const req = requestId || '?';
    const content = `🚨 [auth][${tag}] agent ${agentName} auth failure (session ${sidShort}, req ${req}): ${line}`;
    deps.sendMessage('general', content);
  } catch (e) {
    deps.logger?.error?.(`[auth-monitor] sendMessage failed for ${agentName}: ${e.message}`);
  }
}

async function pollOneFile(jsonlPath) {
  let st;
  try {
    // SecTest v4 #3: BigInt integral chain — coldSeed/pollOneFile/dedupByInode
    // must all use bigint:true so 128-bit ReFS FileId comparison is exact.
    st = statSync(jsonlPath, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EACCES') return;
    deps.logger?.error?.(`[auth-monitor] stat ${jsonlPath}: ${e.message}`);
    return;
  }
  const inode = st.ino;          // BigInt
  const size = Number(st.size);  // Number — file size always fits
  const prev = fileState.get(jsonlPath);

  if (!prev) {
    // New file discovered after cold-seed → scan from zero.
    const entry = { inode, size: 0, matchedHashes: new Set(), lastAccess: Date.now() };
    touch(jsonlPath, entry);
    if (size > 0) {
      await scanRange(jsonlPath, entry, 0, size);
    }
    return;
  }

  // BigInt-safe inode comparison: BigInt !== BigInt works via SameValueZero.
  if (prev.inode !== inode || size < prev.size) {
    // Rotated/truncated — reset and scan from start.
    const entry = { inode, size: 0, matchedHashes: new Set(), lastAccess: Date.now() };
    touch(jsonlPath, entry);
    if (size > 0) {
      await scanRange(jsonlPath, entry, 0, size);
    }
    return;
  }

  if (size === prev.size) {
    prev.lastAccess = Date.now();
    return;
  }

  await scanRange(jsonlPath, prev, prev.size, size);
}

async function scanRange(jsonlPath, entry, from, to) {
  let text;
  try {
    text = await readRange(jsonlPath, from, to);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    deps.logger?.error?.(`[auth-monitor] read ${jsonlPath}: ${e.message}`);
    return;
  }
  entry.size = to;
  entry.lastAccess = Date.now();

  const agentName = agentNameFromJsonlPath(jsonlPath);
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    const result = classifyLine(raw);
    if (!result) continue;
    const hash = createHash('sha1').update(raw).digest('hex').slice(0, 16);
    if (!rememberHash(entry, hash)) continue;
    emitAlert(agentName, jsonlPath, result);
  }
}

// SecTest v4 #1: throttle metrics emission to ≥60s and use a fixed key
// (`audit/auth-monitor/metrics`) — caller is expected to treat this as
// last-known snapshot, not a time-series. The snapshot itself carries `ts`.
// 60s noise floor avoids the 30 writes/min that 2s-poll would otherwise produce.
const METRICS_THROTTLE_MS = 60_000;
let lastMetricsEmittedAt = 0;
function emitMetricsToState() {
  const now = Date.now();
  if (now - lastMetricsEmittedAt < METRICS_THROTTLE_MS) return;
  lastMetricsEmittedAt = now;
  try {
    deps?.setState?.('audit/auth-monitor/metrics', {
      ts: now,
      rawCount: lastDedupMetric.rawCount,
      uniqueCount: lastDedupMetric.uniqueCount,
      ambiguousDropped: lastDedupMetric.ambiguousDropped,
      multiSelfConsistentDropped: lastDedupMetric.multiSelfConsistentDropped || 0,
      statErrors: lastDedupMetric.statErrors,
      tracked: fileState.size,
      cap: GLOBAL_FILE_CAP,
    });
  } catch (e) {
    deps?.logger?.error?.(`[auth-monitor] emitMetricsToState: ${e.message}`);
  }
}

async function pollAll() {
  if (!agentsBaseDirRef) return;
  const paths = listAgentJsonlPaths();
  for (const p of paths) {
    try {
      await pollOneFile(p);
    } catch (e) {
      deps.logger?.error?.(`[auth-monitor] poll ${p} unexpected: ${e.message}`);
    }
  }
  emitMetricsToState();
}

function coldSeed() {
  // v0.4: sentinel short-circuit — no stat, no readdir
  if (process.env.AUTH_MONITOR_CANARY === SENTINEL_OFF) {
    deps.logger?.log?.('[auth-monitor] cold-seed skipped (sentinel)');
    return;
  }
  const paths = listAgentJsonlPaths();
  const agentSet = new Set();
  for (const jsonlPath of paths) {
    try {
      // SecTest v4 #3: integral BigInt chain
      const st = statSync(jsonlPath, { bigint: true });
      touch(jsonlPath, {
        inode: st.ino,             // BigInt
        size: Number(st.size),     // Number
        matchedHashes: new Set(),
        lastAccess: Date.now(),
      });
      agentSet.add(agentNameFromJsonlPath(jsonlPath));
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'EACCES') {
        deps.logger?.error?.(`[auth-monitor] seed ${jsonlPath}: ${e.message}`);
      }
    }
  }
  deps.logger?.log?.(`[auth-monitor] cold-seed complete, ${fileState.size} jsonl file(s) tracked across ${agentSet.size} agent(s)`);
}

export function startAuthMonitor(processesRef /* unused, compat */, agentsBaseDir, injected) {
  if (running) return;
  if (!agentsBaseDir || !injected) {
    throw new Error('startAuthMonitor: missing required args');
  }
  if (typeof injected.setState !== 'function' || typeof injected.sendMessage !== 'function') {
    throw new Error('startAuthMonitor: deps must include setState + sendMessage');
  }
  agentsBaseDirRef = agentsBaseDir;
  deps = { logger: console, ...injected };
  running = true;
  try { coldSeed(); } catch (e) { deps.logger?.error?.(`[auth-monitor] cold-seed failed: ${e.message}`); }
  timer = setInterval(() => {
    pollAll().catch(e => deps.logger?.error?.(`[auth-monitor] tick: ${e.message}`));
  }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const canary = process.env.AUTH_MONITOR_CANARY;
  if (canary === SENTINEL_OFF) {
    deps.logger?.log?.('[auth-monitor] disabled (sentinel)');
  } else if (canary) {
    deps.logger?.log?.(`[auth-monitor] canary mode: ${canary}`);
  } else {
    deps.logger?.log?.(`[auth-monitor] full scan (depth=${getScanDepth()})`);
  }
  deps.logger?.log?.(`[auth-monitor] GLOBAL_FILE_CAP=${GLOBAL_FILE_CAP} (env=${process.env.AUTH_MONITOR_FILE_CAP || 'unset'})`);
  deps.logger?.log?.(`[auth-monitor] inode dedup: ${lastDedupMetric.rawCount} paths → ${lastDedupMetric.uniqueCount} unique inodes (dropped ${lastDedupMetric.ambiguousDropped} ambiguous, stat errors ${lastDedupMetric.statErrors})`);
  deps.logger?.log?.('[auth-monitor] started (Doc-C Layer 3 v0.4 jsonl-scan, recursive walker + audit rows)');
}

export function stopAuthMonitor() {
  if (!running) return;
  if (timer) { clearInterval(timer); timer = null; }
  running = false;
  fileState.clear();
  deps?.logger?.log?.('[auth-monitor] stopped');
}

// Drop all tracked jsonl entries belonging to the given agent.
export function clearAgent(name) {
  if (!agentsBaseDirRef || !name) return;
  const prefix = join(agentsBaseDirRef, name, '.claude-config', 'projects');
  for (const key of Array.from(fileState.keys())) {
    if (key.startsWith(prefix)) fileState.delete(key);
  }
}
