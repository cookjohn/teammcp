import crypto from 'node:crypto';
import { createMemory, getState, setState, getCcMetricsSince } from './db.mjs';
import { subscribe, subscribeAll } from './eventbus.mjs';

// ── Constants ────────────────────────────────────────────

const CC_METRICS_SCAN_INTERVAL = 5 * 60 * 1000;  // 5 minutes
const DEDUP_CLEANUP_INTERVAL = 10 * 60 * 1000;   // 10 minutes
const DEDUP_WINDOW_MS = 60 * 60 * 1000;           // 1 hour
const RAW_TRUNCATE_LEN = 2000;
const HASH_TRUNCATE_LEN = 500;
const HASH_PREFIX_LEN = 16;

// Map eventbus event types to memory level hints
const EVENT_INTEREST = {
  'state_changed':          'important',
  'approval_requested':     'important',
  'approval_resolved':      'important',
  'agent_online':           'routine',
  'knowledge_gap_detected': 'lesson',
  'audit_alert':            'critical',
};

// Keywords for message filtering
const MEMORY_KEYWORDS = [
  '决定', '方案', '架构', '崩溃', 'bug', 'error', 'deadlock',
  'fix', 'refactor', 'security', 'vulnerability',
];

// ── Logging ──────────────────────────────────────────────

function log(...args) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${time}] [Memory]`, ...args);
}

// ── WriteQueue ───────────────────────────────────────────

class WriteQueue {
  constructor(maxSize = 500) {
    this.queue = [];
    this.maxSize = maxSize;
    this.processing = false;
  }

  enqueue(event) {
    if (this.queue.length >= this.maxSize) {
      // When full, drop Routine events first
      const routineIdx = this.queue.findIndex(e => e.level_hint === 'routine');
      if (routineIdx >= 0) {
        this.queue.splice(routineIdx, 1);
      } else {
        this.queue.shift(); // FIFO fallback
      }
    }
    this.queue.push(event);
    this.drain();
  }

  async drain() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const event = this.queue.shift();
      try {
        await processEvent(event);
      } catch (err) {
        console.error('[Memory] WriteQueue error:', err.message);
      }
    }
    this.processing = false;
  }

  get length() {
    return this.queue.length;
  }
}

// ── Preprocessing ────────────────────────────────────────

function preprocessEvent(event) {
  let raw = JSON.stringify(event.raw || event);
  if (raw.length > RAW_TRUNCATE_LEN) {
    raw = raw.slice(0, RAW_TRUNCATE_LEN - 50) + '... [truncated]';
  }
  // Redact secrets: API keys, tokens, passwords
  raw = raw.replace(/(?:sk-|AKIA|ghp_|token[=:])\S{10,}/gi, '[REDACTED]');
  raw = raw.replace(/password['":\s]*[^\s,}]+/gi, 'password: [REDACTED]');
  event.raw_text = raw;
  return event;
}

// ── Deduplication ────────────────────────────────────────

// In-memory hash window: hash → timestamp of when it was seen
const hashWindow = new Map();

function computeEventHash(event) {
  const source = event.source_type || 'unknown';
  const agent = event.agent || 'system';
  const content = (event.raw_text || JSON.stringify(event.raw || event)).slice(0, HASH_TRUNCATE_LEN);
  const input = source + agent + content;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, HASH_PREFIX_LEN);
}

function isDuplicate(hash) {
  // Check in-memory window
  if (hashWindow.has(hash)) {
    const seenAt = hashWindow.get(hash);
    if (Date.now() - seenAt < DEDUP_WINDOW_MS) {
      return true;
    }
    // Expired entry, remove it
    hashWindow.delete(hash);
  }

  // Check DB for recent duplicate
  try {
    const oneHourAgo = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
    const existing = getState('memory', `dup_${hash}`);
    if (existing) {
      const ts = existing.value;
      if (ts && new Date(ts).getTime() > Date.now() - DEDUP_WINDOW_MS) {
        return true;
      }
    }
  } catch {
    // If DB check fails, rely on in-memory window only
  }

  return false;
}

function markHashSeen(hash) {
  hashWindow.set(hash, Date.now());
  // Persist to DB for cross-process dedup
  try {
    setState('memory', `dup_${hash}`, new Date().toISOString(), 'memory-engine', 'dedup tracking', {
          systemWrite: true,
          allowFieldCreation: true,
        });
  } catch {
    // Non-critical: in-memory dedup still works within single process
  }
}

function cleanupHashWindow() {
  const now = Date.now();
  let cleaned = 0;
  for (const [hash, ts] of hashWindow) {
    if (now - ts >= DEDUP_WINDOW_MS) {
      hashWindow.delete(hash);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log(`Dedup cleanup: removed ${cleaned} expired hashes (${hashWindow.size} remaining)`);
  }
}

// ── Quick title/summary generators ──────────────────────

function generateQuickTitle(event) {
  const type = event.type || event.source_type || 'event';
  const agent = event.agent || 'system';
  const content = (event.raw_text || JSON.stringify(event.raw || event)).slice(0, 80);
  return `[${type}] ${agent}: ${content}`;
}

function generateQuickSummary(event) {
  const raw = event.raw_text || JSON.stringify(event.raw || event);
  return raw.slice(0, 200);
}

// ── Core event processing ───────────────────────────────

async function processEvent(event) {
  // 1. Preprocess
  const processed = preprocessEvent(event);

  // 2. Compute hash
  const hash = computeEventHash(processed);

  // 3. Dedup check (in-memory + DB)
  if (isDuplicate(hash)) {
    log(`Duplicate skipped: ${hash}`);
    return;
  }

  // 4. Determine TTL based on level
  const level = processed.level_hint || 'routine';
  const ttl_days = level === 'critical' ? 365 : level === 'important' ? 180 : 90;

  // 5. Create memory in DB
  const memory = createMemory({
    agent: processed.agent || 'system',
    session_id: processed.session_id || null,
    level,
    category: 'general',
    title: generateQuickTitle(processed),
    summary: generateQuickSummary(processed),
    raw_event: processed.raw_text || JSON.stringify(processed.raw || processed).slice(0, 2000),
    source_type: processed.source_type,
    source_id: processed.source_id || null,
    event_hash: hash,
    tags: '[]',
    related_ids: '[]',
    ttl_days,
  });

  // 6. Mark hash as seen
  markHashSeen(hash);

  // 7. Log
  log(`Memory created: ${memory.id} [${level}] ${memory.title}`);

  return memory;
}

// ── Event source: EventBus ───────────────────────────────

let eventbusUnsub = null;
let messagesUnsub = null;

function handleEventbusEvent(event) {
  // Filter: skip events produced by the memory engine itself (avoids infinite loop)
  if (event.project_id === 'memory') return;
  if (event.changed_by === 'memory-engine') return;

  const levelHint = EVENT_INTEREST[event.type] || 'routine';
  writeQueue.enqueue({
    ...event,
    level_hint: levelHint,
    source_type: 'eventbus',
    source_id: `eb_${event.type}_${event.timestamp}`,
    agent: event.agent || event.changed_by || 'system',
  });
}

function subscribeEventbus() {
  eventbusUnsub = subscribeAll(handleEventbusEvent);
  log('Subscribed to EventBus events');
}

function unsubscribeEventbus() {
  if (eventbusUnsub) {
    eventbusUnsub();
    eventbusUnsub = null;
    log('Unsubscribed from EventBus');
  }
}

// ── Event source: cc_metrics periodic scan ───────────────

let ccMetricsTimer = null;

async function scanCcMetrics() {
  try {
    // Read last scanned position
    const lastScanned = getState('memory', 'last_scanned_id');
    const lastId = lastScanned ? parseInt(lastScanned.value, 10) || 0 : 0;

    // Fetch new rows
    const rows = getCcMetricsSince(lastId, 200);
    if (rows.length === 0) return;

    let maxId = lastId;
    for (const row of rows) {
      if (row.id > maxId) maxId = row.id;

      // Map event type to level hint
      let levelHint = 'routine';
      if (row.event === 'CrashLoopDetected') levelHint = 'critical';
      else if (row.event === 'StopFailure') levelHint = 'critical';
      else if (row.event === 'SessionStart' || row.event === 'SessionEnd') levelHint = 'routine';
      else if (row.event === 'PostToolUse' && row.error) levelHint = 'lesson';

      writeQueue.enqueue({
        level_hint: levelHint,
        source_type: 'cc_metrics',
        source_id: `ccm_${row.id}`,
        agent: row.agent,
        session_id: row.session_id,
        type: row.event,
        raw: {
          event: row.event,
          tool_name: row.tool_name,
          tool_input: row.tool_input,
          tool_response: row.tool_response,
          model: row.model,
          reason: row.reason,
          error: row.error,
          extra_json: row.extra_json,
          timestamp: row.timestamp,
        },
      });
    }

    // Persist scan position
    setState('memory', 'last_scanned_id', String(maxId), 'memory-engine', 'cc_metrics scan position', {
          systemWrite: true,
          allowFieldCreation: true,
        });
    log(`cc_metrics scan: processed ${rows.length} rows (id ${lastId + 1}..${maxId})`);
  } catch (err) {
    console.error('[Memory] cc_metrics scan error:', err.message);
  }
}

function startCcMetricsScan() {
  // Run first scan asynchronously (don't block event loop at startup)
  setTimeout(() => scanCcMetrics(), 100);
  ccMetricsTimer = setInterval(scanCcMetrics, CC_METRICS_SCAN_INTERVAL);
  log(`cc_metrics scan started (interval: ${CC_METRICS_SCAN_INTERVAL / 1000}s)`);
}

function stopCcMetricsScan() {
  if (ccMetricsTimer) {
    clearInterval(ccMetricsTimer);
    ccMetricsTimer = null;
    log('cc_metrics scan stopped');
  }
}

// ── Event source: Messages hook (keyword filtering) ─────

function handleMessageSaved(event) {
  if (event.type !== 'message_saved') return;

  const content = (event.content || '').toLowerCase();
  const mentions = event.mentions || [];

  // Filter conditions
  let shouldCapture = false;
  let levelHint = 'routine';

  // a. System alert messages
  if (event.from === 'System' || event.from_agent === 'System') {
    shouldCapture = true;
    levelHint = 'important';
  }

  // b. Keyword matching
  if (!shouldCapture && content) {
    for (const kw of MEMORY_KEYWORDS) {
      if (content.includes(kw.toLowerCase())) {
        shouldCapture = true;
        levelHint = 'lesson';
        break;
      }
    }
  }

  // c. Messages @mentioning >= 3 people (coordinated decisions)
  if (!shouldCapture && mentions.length >= 3) {
    shouldCapture = true;
    levelHint = 'important';
  }

  if (!shouldCapture) return;

  writeQueue.enqueue({
    level_hint: levelHint,
    source_type: 'message',
    source_id: `msg_${event.id || Date.now()}`,
    agent: event.from || event.from_agent || 'unknown',
    type: 'message_saved',
    raw: {
      channel: event.channel,
      from: event.from || event.from_agent,
      content: event.content,
      mentions,
      timestamp: event.timestamp,
    },
  });
}

function subscribeMessages() {
  messagesUnsub = subscribe('*', (event) => {
    if (event.type === 'message_saved') {
      handleMessageSaved(event);
    }
  });
  log('Subscribed to message_saved events');
}

function unsubscribeMessages() {
  if (messagesUnsub) {
    messagesUnsub();
    messagesUnsub = null;
    log('Unsubscribed from messages');
  }
}

// ── Dedup cleanup timer ──────────────────────────────────

let dedupCleanupTimer = null;

function startDedupCleanup() {
  dedupCleanupTimer = setInterval(cleanupHashWindow, DEDUP_CLEANUP_INTERVAL);
  log(`Dedup cleanup started (interval: ${DEDUP_CLEANUP_INTERVAL / 1000}s)`);
}

function stopDedupCleanup() {
  if (dedupCleanupTimer) {
    clearInterval(dedupCleanupTimer);
    dedupCleanupTimer = null;
    log('Dedup cleanup stopped');
  }
}

// ── Module state ─────────────────────────────────────────

let writeQueue = null;
let engineRunning = false;

// ── Exported API ─────────────────────────────────────────

/**
 * Start the memory engine.
 * Call from index.mjs during server startup.
 */
export function startMemoryEngine() {
  if (engineRunning) {
    log('Engine already running, skipping start');
    return;
  }

  writeQueue = new WriteQueue(500);
  subscribeEventbus();
  subscribeMessages();
  startCcMetricsScan();
  startDedupCleanup();

  engineRunning = true;
  log('Memory engine started');
}

/**
 * Stop the memory engine.
 * Call during server shutdown.
 */
export async function stopMemoryEngine() {
  if (!engineRunning) return;

  stopCcMetricsScan();
  stopDedupCleanup();
  unsubscribeEventbus();
  unsubscribeMessages();

  // Drain remaining queue items
  if (writeQueue && writeQueue.length > 0) {
    log(`Draining ${writeQueue.length} remaining events...`);
    await writeQueue.drain();
  }

  engineRunning = false;
  writeQueue = null;
  log('Memory engine stopped');
}

/**
 * Ingest a manual event (for testing or direct API use).
 * @param {object} event - Event object with at minimum: source_type, raw or raw_text
 * @returns {Promise<object|null>} Created memory or null if deduplicated
 */
export function ingestEvent(event) {
  if (!writeQueue) {
    throw new Error('Memory engine not started. Call startMemoryEngine() first.');
  }
  const enriched = {
    level_hint: event.level_hint || 'routine',
    source_type: event.source_type || 'manual',
    source_id: event.source_id || `manual_${Date.now()}`,
    agent: event.agent || 'system',
    ...event,
  };
  writeQueue.enqueue(enriched);
  return { enqueued: true, queueLength: writeQueue.length };
}

/**
 * Get engine status for monitoring.
 */
export function getMemoryEngineStatus() {
  return {
    running: engineRunning,
    queueLength: writeQueue ? writeQueue.length : 0,
    dedupWindowSize: hashWindow.size,
  };
}
