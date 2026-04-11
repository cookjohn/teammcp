/**
 * memory-providers.mjs — Provider Framework + Registry for the TeamMCP memory system (Phase 2).
 *
 * Responsibilities:
 *   - MemoryProvider: base class for pluggable memory providers
 *   - ProviderRegistry: registers providers, dispatches events, aggregates queries
 *   - TeamSearchProvider: unified search across messages_fts + memories_fts
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG_PREFIX = '[Memory-Providers]';

// ── Database connection ────────────────────────────────────────────────────
// We open our own connection to the shared SQLite DB (db.mjs does not export
// the internal Database instance). Same pattern as memory-llm.mjs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAMMCP_HOME = process.env.TEAMMCP_HOME || path.join((await import('node:os')).homedir(), '.teammcp');
const DATA_DIR = path.join(TEAMMCP_HOME, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'teammcp.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ── Logging helpers ────────────────────────────────────────────────────────

function log(...args)    { console.log(LOG_PREFIX, ...args); }
function logErr(...args) { console.error(LOG_PREFIX, ...args); }

// ── FTS5 query sanitization ────────────────────────────────────────────────

/**
 * Sanitize a user query string for safe use with SQLite FTS5 MATCH.
 * Splits on whitespace, escapes internal double-quotes, wraps each token
 * in double-quotes so FTS5 treats them as literal terms.
 * @param {string} query
 * @returns {string} sanitized FTS5 MATCH expression, or '' if empty
 */
function sanitizeFtsQuery(query) {
  if (!query || typeof query !== 'string') return '';
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

// ── MemoryProvider base class ──────────────────────────────────────────────

/**
 * Base class for memory providers. Subclass this to add new storage/indexing
 * strategies to the memory system.
 *
 * Lifecycle: init() → onEvent() / query() ... → shutdown()
 */
class MemoryProvider {
  /**
   * @param {string} name — unique provider name (e.g. 'team-search', 'sqlite')
   * @param {object} config — provider-specific configuration
   */
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.enabled = config.enabled !== false; // default true
  }

  /**
   * Called once during ProviderRegistry.initAll().
   * Override to perform async setup (open connections, warm caches, etc.).
   */
  async init() { }

  /**
   * Called for every event dispatched by the registry.
   * Override to index, store, or react to events.
   * @param {object} event — { type, ...payload, timestamp }
   */
  async onEvent(event) { }

  /**
   * Called by ProviderRegistry.queryAll() to retrieve results from this provider.
   * Override to return provider-specific results.
   * @param {object} query — query parameters (shape depends on caller)
   * @returns {Promise<Array<object>>} results array (may be empty)
   */
  async query(query) {
    return [];
  }

  /**
   * Called once during ProviderRegistry.shutdownAll().
   * Override to release resources (close connections, flush buffers, etc.).
   */
  async shutdown() { }
}

// ── ProviderRegistry ───────────────────────────────────────────────────────

/**
 * Manages a collection of MemoryProvider instances.
 * Handles lifecycle (init / shutdown), event dispatch, and query aggregation.
 */
class ProviderRegistry {
  constructor() {
    /** @type {Map<string, MemoryProvider>} name → provider */
    this._providers = new Map();
  }

  /**
   * Register a provider instance.
   * @param {MemoryProvider} provider
   * @throws {Error} if a provider with the same name is already registered
   */
  register(provider) {
    if (!(provider instanceof MemoryProvider)) {
      throw new Error(`Provider must extend MemoryProvider: ${provider?.name ?? typeof provider}`);
    }
    if (this._providers.has(provider.name)) {
      throw new Error(`Provider already registered: ${provider.name}`);
    }
    this._providers.set(provider.name, provider);
    log(`Registered provider: ${provider.name} (enabled=${provider.enabled})`);
  }

  /**
   * Call init() on all registered providers.
   */
  async initAll() {
    for (const [name, provider] of this._providers) {
      if (!provider.enabled) {
        log(`Skipping init for disabled provider: ${name}`);
        continue;
      }
      try {
        await provider.init();
        log(`Initialized provider: ${name}`);
      } catch (err) {
        logErr(`Failed to init provider "${name}": ${err.message}`);
      }
    }
  }

  /**
   * Dispatch an event to all enabled providers that have overridden onEvent.
   * Errors are caught per-provider so one failure does not block others.
   * @param {object} event — { type, ...payload, timestamp }
   */
  async dispatchEvent(event) {
    for (const [name, provider] of this._providers) {
      if (!provider.enabled) continue;
      // Skip providers that haven't overridden onEvent (base class is a no-op)
      if (provider.onEvent === MemoryProvider.prototype.onEvent) continue;
      try {
        await provider.onEvent(event);
      } catch (err) {
        logErr(`onEvent error in provider "${name}": ${err.message}`);
      }
    }
  }

  /**
   * Query all enabled providers and aggregate results.
   * Results are merged and sorted by score (descending). Providers that
   * don't return a score get score = 0 and sort to the end.
   * @param {object} query — query parameters
   * @returns {Promise<Array<object>>} aggregated, score-sorted results
   */
  async queryAll(query) {
    const allResults = [];

    const promises = [];
    for (const [name, provider] of this._providers) {
      if (!provider.enabled) continue;
      if (provider.query === MemoryProvider.prototype.query) continue;

      promises.push(
        provider.query(query)
          .then(results => {
            if (Array.isArray(results)) {
              for (const r of results) {
                // Tag each result with its source provider
                r._provider = name;
              }
              allResults.push(...results);
            }
          })
          .catch(err => {
            logErr(`query error in provider "${name}": ${err.message}`);
          })
      );
    }

    await Promise.all(promises);

    // Sort by score descending; items without score sort last
    allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return allResults;
  }

  /**
   * Call shutdown() on all registered providers.
   */
  async shutdownAll() {
    for (const [name, provider] of this._providers) {
      if (!provider.enabled) continue;
      try {
        await provider.shutdown();
        log(`Shutdown provider: ${name}`);
      } catch (err) {
        logErr(`Failed to shutdown provider "${name}": ${err.message}`);
      }
    }
  }

  /**
   * Get a registered provider by name.
   * @param {string} name
   * @returns {MemoryProvider | undefined}
   */
  get(name) {
    return this._providers.get(name);
  }

  /**
   * List all registered provider names.
   * @returns {string[]}
   */
  list() {
    return [...this._providers.keys()];
  }
}

// ── TeamSearchProvider ─────────────────────────────────────────────────────

/**
 * Read-only provider that unifies FTS5 search across messages and memories.
 *
 * - onEvent(): no-op (does not store or index anything)
 * - query({ q, limit }): searches messages_fts and memories_fts, merges and ranks
 *
 * Result shape:
 * {
 *   source: 'message' | 'memory',
 *   id,                           // original row id
 *   content,                      // matched text content
 *   score,                        // FTS5 rank (negated so higher = better)
 *   created_at / agent / ...      // source-specific fields
 * }
 */
class TeamSearchProvider extends MemoryProvider {
  constructor(config = {}) {
    super('team-search', config);
  }

  /**
   * No-op: this provider is read-only.
   */
  async onEvent(event) {
    // intentionally empty — read-only provider
  }

  /**
   * Unified search across messages_fts and memories_fts.
   * @param {object} query
   * @param {string} query.q — search terms
   * @param {number} [query.limit=20] — max results per source (total may be up to 2x)
   * @returns {Promise<Array<object>>} merged results sorted by score
   */
  async query(query) {
    const { q, limit = 20 } = query;
    const sanitized = sanitizeFtsQuery(q);
    if (!sanitized) return [];

    const messageResults = this._searchMessages(sanitized, limit);
    const memoryResults = this._searchMemories(sanitized, limit);

    // Merge and sort by score descending
    const merged = [...messageResults, ...memoryResults];
    merged.sort((a, b) => b.score - a.score);

    return merged;
  }

  /**
   * Search messages_fts.
   * @param {string} sanitized — already-sanitized FTS5 MATCH expression
   * @param {number} limit
   * @returns {Array<object>}
   */
  _searchMessages(sanitized, limit) {
    try {
      const rows = db.prepare(`
        SELECT id, channel_id, from_agent, content, created_at, rank
        FROM messages_fts
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(sanitized, limit);

      return rows.map(row => ({
        source: 'message',
        id: row.id,
        content: row.content,
        channel_id: row.channel_id,
        from_agent: row.from_agent,
        created_at: row.created_at,
        // FTS5 rank is negative (closer to 0 = better); negate so higher = better
        score: -(row.rank ?? 0),
      }));
    } catch (err) {
      logErr(`_searchMessages failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Search memories_fts. Gracefully returns [] if the table does not exist yet.
   * @param {string} sanitized — already-sanitized FTS5 MATCH expression
   * @param {number} limit
   * @returns {Array<object>}
   */
  _searchMemories(sanitized, limit) {
    try {
      // Check if memories_fts table exists
      const hasTable = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'
      `).get();
      if (!hasTable) return [];

      const rows = db.prepare(`
        SELECT id, agent, level, title, summary, tags, rank
        FROM memories_fts
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(sanitized, limit);

      return rows.map(row => ({
        source: 'memory',
        id: row.id,
        content: `${row.title} ${row.summary}`.trim(),
        title: row.title,
        summary: row.summary,
        agent: row.agent,
        level: row.level,
        tags: row.tags,
        score: -(row.rank ?? 0),
      }));
    } catch (err) {
      logErr(`_searchMemories failed: ${err.message}`);
      return [];
    }
  }
}

// ── Exports ────────────────────────────────────────────────────────────────

export {
  MemoryProvider,
  ProviderRegistry,
  TeamSearchProvider,
};

export default {
  MemoryProvider,
  ProviderRegistry,
  TeamSearchProvider,
};
