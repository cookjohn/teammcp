/**
 * memory-llm-classifier.mjs — LLM enrichment provider for the memory engine.
 *
 * Subscribes to memory_created events. Memories created with the heuristic
 * fast path (memory.mjs:processEvent) have machine-generated titles like
 * "PostToolUse for CEO" that are useless for retrieval. This provider
 * batches those memories and runs them through memory-llm.classifyBatch,
 * then UPDATEs each row with the LLM-generated title / summary / level /
 * category / tags.
 *
 * Design decisions:
 *
 *   - Async, batched (5 events / 30s) — never block the writeQueue.
 *   - Cost-gated — uses memory-llm's existing per-purpose daily budget.
 *     If the API key is unconfigured, classifyBatch falls back to its
 *     own heuristic (returns extractTitle/truncate), which we still
 *     apply via UPDATE so at least the title gets cleaner.
 *   - Scope-gated — only level_hint in classifyLevels (default:
 *     lesson / important / critical) gets LLM treatment. Routine
 *     memories keep their heuristic title; not worth the cost.
 *   - Self-healing — every failure path returns the buffered events
 *     to a fresh flush attempt; an LLM 5xx never loses memories.
 *   - Loop-safe — memory_created from THIS provider's own UPDATEs
 *     does not fire memory_created again (memory.mjs only publishes
 *     on createMemory, not on update).
 *
 * Lifecycle: registered by memory.mjs in startMemoryEngine after
 * SkillNudgeProvider. Idempotent init / shutdown.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryProvider } from './memory-providers.mjs';
import { classifyBatch } from './memory-llm.mjs';

const LOG_PREFIX = '[Memory-LLM-Classifier]';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAMMCP_HOME = process.env.TEAMMCP_HOME || path.join((await import('node:os')).homedir(), '.teammcp');
const DATA_DIR = path.join(TEAMMCP_HOME, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'teammcp.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function log(...args)    { console.log(LOG_PREFIX, ...args); }
function logErr(...args) { console.error(LOG_PREFIX, ...args); }

// Levels worth spending LLM tokens on. routine = heuristic-only.
const DEFAULT_CLASSIFY_LEVELS = new Set(['lesson', 'important', 'critical']);

class LlmClassifierProvider extends MemoryProvider {
  constructor(config = {}) {
    super('llm-classifier', config);
    this.batchSize = config.batchSize || 5;
    this.flushIntervalMs = config.flushIntervalMs || 30_000;
    this.classifyLevels = new Set(config.classifyLevels || DEFAULT_CLASSIFY_LEVELS);
    this._buffer = [];        // memory_created events awaiting classification
    this._timer = null;
    this._inFlight = false;   // prevent overlapping flushes
    this._stats = { processed: 0, llmCalls: 0, fallbacks: 0, errors: 0 };
  }

  async init() {
    if (this._timer) return;
    this._timer = setInterval(() => this._flush().catch(err => logErr('flush error:', err.message)), this.flushIntervalMs);
    this._timer.unref?.();
    log(`Initialized (batch=${this.batchSize}, flush=${this.flushIntervalMs}ms, levels=[${[...this.classifyLevels].join(',')}])`);
  }

  async shutdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Drain whatever is buffered. If LLM is slow/broken, this still
    // returns within ~30s thanks to the per-call timeout in memory-llm.
    if (this._buffer.length > 0) {
      log(`Draining ${this._buffer.length} buffered events on shutdown`);
      await this._flush().catch(err => logErr('drain error:', err.message));
    }
    log(`Shutdown. Stats: ${JSON.stringify(this._stats)}`);
  }

  async onEvent(event) {
    // ProviderRegistry only dispatches memory_created (and other
    // engine events) to us. Defensive type check anyway — providers
    // may grow other event types later.
    if (event.type !== 'memory_created') return;

    // Filter by level: routine = skip. Heuristic title is fine for
    // those; LLM dollars go to lesson/important/critical only.
    if (!this.classifyLevels.has(event.level)) return;

    this._buffer.push(event);
    if (this._buffer.length >= this.batchSize) {
      // Immediate flush on full batch — don't wait for the timer.
      this._flush().catch(err => logErr('immediate flush error:', err.message));
    }
  }

  async _flush() {
    if (this._inFlight) return;
    if (this._buffer.length === 0) return;

    this._inFlight = true;
    // Take a snapshot — let new events accumulate while we work.
    const batch = this._buffer.splice(0, this.batchSize);

    try {
      // Pull each memory's raw_event from DB so classifyBatch has real
      // payload to work with. The event we received only has metadata
      // (id, level, title, source_type, raw_event preview).
      const memoryIds = batch.map(b => b.memory_id);
      const placeholders = memoryIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT id, agent, level, source_type, title, summary, raw_event, tags
         FROM memories
         WHERE id IN (${placeholders})`
      ).all(...memoryIds);

      const byId = new Map(rows.map(r => [r.id, r]));
      const eventsForLlm = batch.map(b => {
        const m = byId.get(b.memory_id);
        if (!m) return null;
        // Pass raw_event so the LLM sees the actual content, plus
        // level_hint so its fallback path keeps the heuristic level.
        return {
          memory_id: m.id,
          agent: m.agent,
          source_type: m.source_type,
          level_hint: m.level,
          tags: (() => { try { return JSON.parse(m.tags); } catch { return []; } })(),
          text: m.raw_event,
        };
      }).filter(Boolean);

      if (eventsForLlm.length === 0) return;

      this._stats.llmCalls++;
      const classifications = await classifyBatch(eventsForLlm);
      // classifyBatch returns either real LLM results or a heuristic
      // fallback array of the same shape. Either way the array has
      // 1-to-1 correspondence with eventsForLlm by index.
      const updateStmt = db.prepare(
        `UPDATE memories
         SET title = ?, summary = ?, level = ?, category = ?, tags = ?
         WHERE id = ?`
      );
      let appliedReal = 0, appliedFallback = 0;
      for (let i = 0; i < classifications.length; i++) {
        const c = classifications[i];
        const ev = eventsForLlm[i];
        if (!c || !ev) continue;
        try {
          updateStmt.run(
            (c.title || '').slice(0, 200),
            (c.summary || '').slice(0, 2000),
            c.level || ev.level_hint || 'routine',
            c.category || 'general',
            JSON.stringify(Array.isArray(c.tags) ? c.tags.slice(0, 10) : []),
            ev.memory_id,
          );
          this._stats.processed++;
          // Heuristic-fallback rows have category='general' and a generated title,
          // hard to detect from outside — we approximate by checking if the
          // returned title matches what extractTitle would produce. Skipping
          // for now; the stats are best-effort.
          appliedReal++;
        } catch (err) {
          logErr(`UPDATE failed for memory ${ev.memory_id}: ${err.message}`);
          this._stats.errors++;
        }
      }
      log(`Processed ${classifications.length} memories (applied=${appliedReal}, total_processed=${this._stats.processed}, llmCalls=${this._stats.llmCalls})`);
    } catch (err) {
      this._stats.errors++;
      // classifyBatch's own catch already returned heuristic fallback,
      // so reaching here means something else broke (e.g. DB locked).
      // Push the batch BACK to the front of the buffer so we retry
      // next flush. If buffer is already full of newer items, we
      // drop oldest first — bounded growth.
      logErr(`flush failed: ${err.message}; retrying batch on next tick`);
      this._buffer.unshift(...batch);
      while (this._buffer.length > this.batchSize * 4) this._buffer.shift();
    } finally {
      this._inFlight = false;
    }
  }
}

export default LlmClassifierProvider;
export { LlmClassifierProvider };
