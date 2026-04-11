/**
 * memory-llm.mjs — LLM Pipeline module for the TeamMCP memory system (Phase 2).
 *
 * Responsibilities:
 *   - LLMClient: multi-provider LLM client with config from DB, AES-256-GCM decryption, usage tracking
 *   - classifyBatch: batch event classification (up to 5 events)
 *   - deepSummary: detailed analysis for critical/important events
 *   - reviewSession: session review and summary generation
 *   - askMemory: natural language query over FTS5 candidates
 */

import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { subscribe } from './eventbus.mjs';

const LOG_PREFIX = '[Memory-LLM]';

// ── Database connection ────────────────────────────────────────────────────
// We open our own connection to the shared SQLite DB (db.mjs does not export
// the internal Database instance).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAMMCP_HOME = process.env.TEAMMCP_HOME || path.join((await import('node:os')).homedir(), '.teammcp');
const DATA_DIR = path.join(TEAMMCP_HOME, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'teammcp.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ── Logging helpers ────────────────────────────────────────────────────────

function log(...args)   { console.log(LOG_PREFIX, ...args); }
function logErr(...args) { console.error(LOG_PREFIX, ...args); }

// ── Crypto: AES-256-GCM key derivation & decryption ───────────────────────

/**
 * Derive a 32-byte encryption key from MEMORY_LLM_KEY env or TEAMMCP_HOME fallback.
 * Uses HKDF-like approach: HMAC-SHA256(seed, salt) truncated to 32 bytes.
 */
function getEncryptionKey() {
  const envKey = process.env.MEMORY_LLM_KEY;
  if (!envKey) {
    throw new Error('MEMORY_LLM_KEY environment variable is required for LLM API key encryption. Set it to a random 32+ character string.');
  }
  const salt = 'teammcp-memory-llm-v1';
  return createHmac('sha256', salt).update(envKey).digest(); // 32 bytes
}

/**
 * Decrypt an API key stored as { enc, iv, tag } in the DB.
 * @param {string} encHex   — ciphertext hex
 * @param {string} ivHex    — IV hex
 * @param {string} tagHex   — auth tag hex
 * @returns {string} plaintext API key
 */
function decryptApiKey(encHex, ivHex, tagHex) {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ── Cost estimation ───────────────────────────────────────────────────────

const COST_PER_1M = {
  // Anthropic Claude
  'claude-3-5-haiku-20241022':  { input: 0.25, output: 1.25 },
  'claude-3-haiku-20240307':    { input: 0.25, output: 1.25 },
  'claude-sonnet-4-20250514':   { input: 3.0,  output: 15.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0,  output: 15.0 },
  'claude-3-7-sonnet-20250219': { input: 3.0,  output: 15.0 },
  'claude-opus-4-20250514':     { input: 15.0, output: 75.0 },
  // OpenAI
  'gpt-4o-mini':                { input: 0.15, output: 0.6 },
  'gpt-4o':                     { input: 2.5,  output: 10.0 },
  'gpt-4-turbo':                { input: 10.0, output: 30.0 },
  'o3-mini':                    { input: 1.1,  output: 4.4 },
};

/**
 * Estimate cost in USD for a given model and token counts.
 * Falls back to a conservative estimate if model is unknown.
 */
function estimateCost(model, inputTokens, outputTokens) {
  const rates = COST_PER_1M[model];
  if (rates) {
    return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  }
  // Unknown model: conservative fallback ($5/1M in + $15/1M out)
  return (inputTokens * 5 + outputTokens * 15) / 1_000_000;
}

// ── Default fallback costs per purpose (max_daily_cost_usd) ───────────────

const DEFAULT_MAX_DAILY = {
  classify: 0.50,
  summarize: 0.50,
  review: 0.30,
  query: 0.20,
};

// ── LLMClient class ───────────────────────────────────────────────────────

class LLMClient {
  constructor() {
    /** @type {Map<string, object>} purpose → config row */
    this._configCache = new Map();
    this._loadAllConfigs();

    // Hot reload: listen for config changes from EventBus
    this._unsubscribe = subscribe('llm_config_changed', (event) => {
      log('Received llm_config_changed event, reloading config');
      this._loadAllConfigs();
    });
  }

  /**
   * Load all enabled llm_config rows from DB into cache.
   */
  _loadAllConfigs() {
    try {
      const rows = db.prepare('SELECT * FROM llm_config WHERE enabled = 1').all();
      this._configCache.clear();
      for (const row of rows) {
        this._configCache.set(row.purpose, row);
      }
      log(`Loaded ${rows.length} LLM config(s): ${[...this._configCache.keys()].join(', ')}`);
    } catch (err) {
      // Table may not exist yet during initial setup
      logErr('Failed to load llm_config:', err.message);
    }
  }

  /**
   * Get decoded config for a purpose.
   * @returns {{ provider, model, api_key, base_url, max_tokens, temperature, timeout_ms, max_daily_cost_usd }}
   */
  getConfig(purpose) {
    const row = this._configCache.get(purpose);
    if (!row) {
      throw new Error(`No LLM config found for purpose: ${purpose}`);
    }
    return {
      provider: row.provider,
      model: row.model,
      api_key: decryptApiKey(row.api_key_enc, row.api_key_iv, row.api_key_tag),
      base_url: row.base_url || null,
      max_tokens: row.max_tokens || 1024,
      temperature: row.temperature ?? 0.0,
      timeout_ms: row.timeout_ms || 30000,
      max_daily_cost_usd: row.max_daily_cost_usd ?? 1.0,
    };
  }

  /**
   * Check if today's cumulative cost for a purpose exceeds its daily budget.
   */
  isDailyBudgetExceeded(purpose) {
    try {
      const config = this._configCache.get(purpose);
      if (!config) return false; // No config = no budget to exceed

      const maxDaily = config.max_daily_cost_usd ?? 1.0;
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const row = db.prepare(`
        SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
        FROM llm_usage
        WHERE purpose = ? AND date(created_at) = ?
      `).get(purpose, today);

      const currentCost = row?.total_cost ?? 0;
      if (currentCost >= maxDaily) {
        log(`Daily budget exceeded for "${purpose}": $${currentCost.toFixed(4)} >= $${maxDaily.toFixed(2)}`);
        return true;
      }
      return false;
    } catch (err) {
      logErr('Budget check error:', err.message);
      return false; // Fail open — don't block on query errors
    }
  }

  /**
   * Record a usage entry in llm_usage.
   */
  recordUsage({ provider, model, purpose, inputTokens, outputTokens, cost, latencyMs, success = true, errorMessage = null }) {
    try {
      db.prepare(`
        INSERT INTO llm_usage (provider, model, purpose, input_tokens, output_tokens, estimated_cost_usd, latency_ms, success, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(provider, model, purpose, inputTokens, outputTokens, cost, latencyMs, success ? 1 : 0, errorMessage);
    } catch (err) {
      logErr('Failed to record usage:', err.message);
    }
  }

  /**
   * Call an LLM with retry + exponential backoff.
   * @param {string} purpose — config purpose key (e.g. 'classify', 'summarize')
   * @param {Array<{role: string, content: string}>} messages — chat messages
   * @param {{ timeout?: number }} options
   * @returns {{ content: string, inputTokens: number, outputTokens: number, cost: number, latencyMs: number }}
   */
  async chat(purpose, messages, options = {}) {
    if (this.isDailyBudgetExceeded(purpose)) {
      throw new Error(`Daily budget exceeded for purpose: ${purpose}`);
    }

    const config = this.getConfig(purpose);
    const timeout = options.timeout || config.timeout_ms;
    const maxRetries = 3;
    const baseDelayMs = 2000;

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // 2s, 4s, 8s
        log(`Retry ${attempt}/${maxRetries} for "${purpose}" after ${delay}ms`);
        await sleep(delay);
      }

      const startTime = Date.now();
      try {
        const result = await this._callProvider(config, messages, timeout);
        const latencyMs = Date.now() - startTime;
        const cost = estimateCost(config.model, result.inputTokens, result.outputTokens);

        this.recordUsage({
          provider: config.provider,
          model: config.model,
          purpose,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost,
          latencyMs,
          success: true,
        });

        return { ...result, cost, latencyMs };
      } catch (err) {
        lastError = err;
        logErr(`Attempt ${attempt + 1} failed for "${purpose}": ${err.message}`);

        // Record failed attempt (no token counts on failure)
        if (attempt === maxRetries) {
          this.recordUsage({
            provider: config.provider,
            model: config.model,
            purpose,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            latencyMs: Date.now() - startTime,
            success: false,
            errorMessage: err.message,
          });
        }
      }
    }

    throw lastError;
  }

  /**
   * Dispatch to the appropriate provider API.
   */
  async _callProvider(config, messages, timeout) {
    switch (config.provider) {
      case 'anthropic':
        return this._callAnthropic(config, messages, timeout);
      case 'openai':
      case 'openrouter':
      case 'custom':
        return this._callOpenAICompatible(config, messages, timeout);
      default:
        throw new Error(`Unsupported LLM provider: ${config.provider}`);
    }
  }

  /**
   * Call Anthropic Messages API.
   */
  async _callAnthropic(config, messages, timeout) {
    const baseUrl = config.base_url || 'https://api.anthropic.com';
    const url = `${baseUrl}/v1/messages`;

    const body = {
      model: config.model,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.api_key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      const content = data.content?.[0]?.text || '';

      return {
        content,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Call OpenAI-compatible API (OpenAI / OpenRouter / Custom).
   */
  async _callOpenAICompatible(config, messages, timeout) {
    let baseUrl;
    switch (config.provider) {
      case 'openai':
        baseUrl = config.base_url || 'https://api.openai.com';
        break;
      case 'openrouter':
        baseUrl = config.base_url || 'https://openrouter.ai/api/v1';
        break;
      case 'custom':
        baseUrl = config.base_url;
        break;
    }
    const url = `${baseUrl}/chat/completions`;

    const body = {
      model: config.model,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
      messages,
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.api_key}`,
    };

    // OpenRouter optional headers
    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://teammcp.dev';
      headers['X-Title'] = 'TeamMCP Memory';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`${config.provider} API ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';

      return {
        content,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Destroy the client (unsubscribe from EventBus).
   */
  destroy() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

// ── Shared LLM client instance ────────────────────────────────────────────

let _client = null;

function getClient() {
  if (!_client) {
    _client = new LLMClient();
  }
  return _client;
}

// ── Prompt templates ──────────────────────────────────────────────────────

function buildClassifyPrompt(events) {
  const eventLines = events.map((e, i) =>
    `  [${i + 1}] ${JSON.stringify(e)}`
  ).join('\n');

  return [
    {
      role: 'system',
      content: `You are a system event classifier. Output ONLY valid JSON, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Classify the following system events. For each event, provide:
- level: critical(崩溃/安全/阻塞) | important(决策/架构/里程碑) | lesson(经验/踩坑) | routine(常规)
- category: error | decision | milestone | debug | security | pattern | general
- title: <80 characters
- summary: <200 characters
- tags: array of relevant tags

Output a JSON array: [{"index": 1, "level": "...", "category": "...", "title": "...", "summary": "...", "tags": [...]}]

Events:
${eventLines}`,
    },
  ];
}

function buildDeepSummaryPrompt(event) {
  return [
    {
      role: 'system',
      content: `You are a technical analyst. Output ONLY valid JSON, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Provide a detailed analysis of this event:
${JSON.stringify(event, null, 2)}

Output JSON with this exact structure:
{
  "title": "concise title (<80 chars)",
  "summary": "detailed summary (<500 chars)",
  "root_cause": "root cause analysis (optional, omit if not applicable)",
  "action_items": ["action 1", "action 2"],
  "tags": ["tag1", "tag2"],
  "related_context": "brief note on related context or precedents"
}`,
    },
  ];
}

function buildReviewPrompt(metrics) {
  return [
    {
      role: 'system',
      content: `You are a session reviewer for an AI agent team. Output ONLY valid JSON, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Review the following session metrics and generate a summary:

${JSON.stringify(metrics, null, 2)}

Output JSON:
{
  "summary": "concise session summary (<500 chars)",
  "key_actions": ["action 1", "action 2"],
  "lessons": ["lesson 1", "lesson 2"]
}`,
    },
  ];
}

function buildAskMemoryPrompt(question, candidates) {
  return [
    {
      role: 'system',
      content: `You are a memory search assistant. Answer the user's question based on the provided memory entries. Output ONLY valid JSON, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Question: ${question}

Relevant memory entries:
${candidates.map((c, i) => `[${i + 1}] ${JSON.stringify(c)}`).join('\n')}

Output JSON:
{
  "answer": "direct answer to the question",
  "sources": [1, 3],
  "confidence": "high | medium | low",
  "related_notes": "any caveats or related context"
}`,
    },
  ];
}

// ── classifyBatch ─────────────────────────────────────────────────────────

/**
 * Classify a batch of preprocessed events (up to 5 per batch).
 * @param {Array<object>} events — preprocessed event objects (max 5)
 * @returns {Promise<Array<{index: number, level: string, category: string, title: string, summary: string, tags: string[]}>>}
 */
async function classifyBatch(events) {
  if (!events || events.length === 0) return [];

  const batch = events.slice(0, 5);
  const client = getClient();

  try {
    const messages = buildClassifyPrompt(batch);
    const result = await client.chat('classify', messages, { timeout: 30000 });

    const parsed = JSON.parse(result.content);
    if (!Array.isArray(parsed)) {
      throw new Error('classify response is not a JSON array');
    }
    return parsed;
  } catch (err) {
    logErr(`classifyBatch failed: ${err.message}`);

    // Fallback: use level_hint from event, generate basic title/summary from raw text
    return batch.map((event, i) => ({
      index: i + 1,
      level: event.level_hint || 'routine',
      category: 'general',
      title: extractTitle(event),
      summary: truncate(event.text || event.raw || event.message || JSON.stringify(event).slice(0, 200), 200),
      tags: event.tags || [],
    }));
  }
}

// ── deepSummary ───────────────────────────────────────────────────────────

/**
 * Generate a detailed analysis for a critical or important event.
 * @param {object} event — the event to analyze
 * @returns {Promise<{title: string, summary: string, root_cause?: string, action_items: string[], tags: string[], related_context: string}>}
 */
async function deepSummary(event) {
  const client = getClient();

  try {
    const messages = buildDeepSummaryPrompt(event);
    const result = await client.chat('summarize', messages, { timeout: 30000 });

    const parsed = JSON.parse(result.content);
    // Ensure summary is under 500 chars
    if (parsed.summary && parsed.summary.length > 500) {
      parsed.summary = parsed.summary.slice(0, 497) + '...';
    }
    return {
      title: parsed.title || extractTitle(event),
      summary: parsed.summary || '',
      root_cause: parsed.root_cause || undefined,
      action_items: parsed.action_items || [],
      tags: parsed.tags || [],
      related_context: parsed.related_context || '',
    };
  } catch (err) {
    logErr(`deepSummary failed: ${err.message}`);

    // Fallback: basic extraction
    return {
      title: extractTitle(event),
      summary: truncate(event.text || event.raw || event.message || JSON.stringify(event).slice(0, 500), 500),
      action_items: [],
      tags: event.tags || [],
      related_context: '',
    };
  }
}

// ── reviewSession ─────────────────────────────────────────────────────────

/**
 * Generate a session review summary from cc_metrics.
 * @param {Array<object>} metrics — array of cc_metrics for a session
 * @returns {Promise<{summary: string, key_actions: string[], lessons: string[]}>}
 */
async function reviewSession(metrics) {
  const client = getClient();

  try {
    const messages = buildReviewPrompt(metrics);
    const result = await client.chat('review', messages, { timeout: 30000 });

    const parsed = JSON.parse(result.content);
    return {
      summary: parsed.summary || '',
      key_actions: parsed.key_actions || [],
      lessons: parsed.lessons || [],
    };
  } catch (err) {
    logErr(`reviewSession failed: ${err.message}`);
    return {
      summary: `Session with ${metrics.length} metric entries (LLM review unavailable)`,
      key_actions: [],
      lessons: [],
    };
  }
}

// ── askMemory ─────────────────────────────────────────────────────────────

/**
 * Answer a natural language question using memory candidates.
 * @param {string} question — the user's question
 * @param {Array<object>} candidates — top 10 FTS5 search candidates
 * @returns {Promise<{answer: string, sources: number[], confidence: string, related_notes: string}>}
 */
async function askMemory(question, candidates) {
  const client = getClient();

  try {
    const messages = buildAskMemoryPrompt(question, candidates);
    const result = await client.chat('query', messages, { timeout: 30000 });

    const parsed = JSON.parse(result.content);
    return {
      answer: parsed.answer || 'No relevant information found.',
      sources: parsed.sources || [],
      confidence: parsed.confidence || 'low',
      related_notes: parsed.related_notes || '',
    };
  } catch (err) {
    logErr(`askMemory failed: ${err.message}`);
    return {
      answer: 'Memory query failed. Please try again.',
      sources: [],
      confidence: 'low',
      related_notes: `Error: ${err.message}`,
    };
  }
}

// ── Utility functions ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

/**
 * Extract a short title from an event object.
 * Checks common field names: title, name, event, message, text, raw.
 */
function extractTitle(event) {
  const text = event.title || event.name || event.event || event.message || event.text || event.raw || '';
  return truncate(text, 80);
}

// ── Exports ───────────────────────────────────────────────────────────────

export {
  LLMClient,
  classifyBatch,
  deepSummary,
  reviewSession,
  askMemory,
};

export default {
  LLMClient,
  classifyBatch,
  deepSummary,
  reviewSession,
  askMemory,
};
