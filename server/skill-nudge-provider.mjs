/**
 * skill-nudge-provider.mjs — SkillNudgeProvider for the TeamMCP memory system.
 *
 * Detects repetitive workflow patterns in agent tool usage and writes them
 * as "pattern" memories so the system can nudge agents toward using skills.
 *
 * Type: MemorySystem Provider (extends MemoryProvider)
 * Subscribes to: memory_created events (from eventbus)
 * Monitors: cc_metrics PostToolUse events (via periodic scan)
 * Writes: pattern memories (category='pattern', level='important')
 * Integration: registered via ProviderRegistry in memory engine
 *
 * Non-goals (T2): no auto-apply, no cross-agent sharing, no agent runtime changes
 */

import { createMemory, getCcMetricsSince, getState, setState, getOrCreateDmChannel, saveMessage } from './db.mjs';
import { pushToAgent } from './sse.mjs';
import { MemoryProvider } from './memory-providers.mjs';

const LOG_PREFIX = '[SkillNudge]';

/** Gate 2 feature flag — DM notifications default off until Gate 1 soak passes */
const GATE2_ENABLED = process.env.GATE2_ENABLED === 'on';

// ── Constants ──────────────────────────────────────────────────

/** How often to scan cc_metrics for patterns (ms) */
const PATTERN_SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes

/** Minimum consecutive similar calls to trigger a nudge */
const MIN_CONSECUTIVE = 3;

/** Time window to consider calls "consecutive" (ms) */
const CONSECUTIVE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Minimum cross-session occurrences to trigger a nudge */
const MIN_CROSS_SESSION = 3;

/** Cooldown between nudges for the same pattern per agent (ms) */
const NUDGE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Max tool_input length for hashing */
const INPUT_HASH_LEN = 200;

// ── Logging ────────────────────────────────────────────────────

function log(...args) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${time}] ${LOG_PREFIX}`, ...args);
}

function logErr(...args) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.error(`[${time}] ${LOG_PREFIX}`, ...args);
}

// ── Pattern detection helpers ──────────────────────────────────

/**
 * Normalize a tool name for grouping. Strips version suffixes and
 * common prefixes to identify the "core" tool.
 */
function normalizeToolName(toolName) {
  if (!toolName) return 'unknown';
  // Common patterns: "tool_v2", "tool:action"
  return toolName.split(':')[0].split('_v')[0].toLowerCase();
}

/**
 * Create a lightweight signature for a tool call sequence.
 * Uses normalized tool names to detect workflow repetition.
 */
function buildSignature(toolNames) {
  return toolNames.map(normalizeToolName).join(' → ');
}

/**
 * Detect consecutive similar tool calls in a list of PostToolUse rows.
 * Returns array of { toolName, count, agent, sessionId, signature }.
 */
function detectConsecutivePatterns(rows) {
  const patterns = [];

  // Group by agent + session
  const sessions = new Map();
  for (const row of rows) {
    if (row.event !== 'PostToolUse') continue;
    if (!row.tool_name) continue;

    const key = `${row.agent}::${row.session_id || 'nosession'}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(row);
  }

  for (const [key, sessionRows] of sessions) {
    const [agent, sessionId] = key.split('::');

    // Sliding window: detect consecutive same-tool calls
    let i = 0;
    while (i < sessionRows.length) {
      const currentTool = normalizeToolName(sessionRows[i].tool_name);
      let count = 1;
      let j = i + 1;

      while (j < sessionRows.length && normalizeToolName(sessionRows[j].tool_name) === currentTool) {
        // Check time window
        const timeDiff = new Date(sessionRows[j].timestamp).getTime() - new Date(sessionRows[i].timestamp).getTime();
        if (timeDiff > CONSECUTIVE_WINDOW_MS) break;
        count++;
        j++;
      }

      if (count >= MIN_CONSECUTIVE) {
        patterns.push({
          type: 'consecutive',
          toolName: currentTool,
          count,
          agent,
          sessionId: sessionId !== 'nosession' ? sessionId : null,
          signature: `${currentTool} ×${count}`,
        });
        i = j; // skip past this run
      } else {
        i++;
      }
    }
  }

  return patterns;
}

/**
 * Detect cross-session repeated workflows (same tool sequence across sessions).
 * Returns array of { signature, occurrences, agent, sessionIds }.
 */
function detectCrossSessionPatterns(rows) {
  const patterns = [];

  // Group PostToolUse rows by agent
  const agentSessions = new Map();
  for (const row of rows) {
    if (row.event !== 'PostToolUse') continue;
    if (!row.tool_name || !row.session_id) continue;

    const agent = row.agent;
    if (!agentSessions.has(agent)) agentSessions.set(agent, new Map());
    const sessions = agentSessions.get(agent);

    if (!sessions.has(row.session_id)) sessions.set(row.session_id, []);
    sessions.get(row.session_id).push(normalizeToolName(row.tool_name));
  }

  // For each agent, compare session signatures
  for (const [agent, sessions] of agentSessions) {
    const sessionSignatures = new Map(); // signature → Set<sessionId>
    for (const [sessionId, tools] of sessions) {
      if (tools.length < 2) continue; // need at least 2 calls to form a workflow
      // Take first 3-5 tool calls as the workflow signature
      const sig = buildSignature(tools.slice(0, Math.min(5, tools.length)));
      if (!sessionSignatures.has(sig)) sessionSignatures.set(sig, new Set());
      sessionSignatures.get(sig).add(sessionId);
    }

    for (const [sig, sessionSet] of sessionSignatures) {
      if (sessionSet.size >= MIN_CROSS_SESSION) {
        patterns.push({
          type: 'cross_session',
          signature: sig,
          occurrences: sessionSet.size,
          agent,
          sessionIds: [...sessionSet],
        });
      }
    }
  }

  return patterns;
}

// ── Nudge writing ──────────────────────────────────────────────

/**
 * Check if a nudge for this pattern was recently written (cooldown).
 */
function isNudgeOnCooldown(agent, signature) {
  try {
    const key = `nudge_cd_${agent}_${signature}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    const state = getState('memory', key);
    if (!state) return false;
    const lastNudge = new Date(state.value).getTime();
    return (Date.now() - lastNudge) < NUDGE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * Mark a nudge as written (for cooldown tracking).
 */
function markNudgeWritten(agent, signature) {
  try {
    const key = `nudge_cd_${agent}_${signature}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    setState('memory', key, new Date().toISOString(), 'skill-nudge-provider', 'nudge cooldown', {
      systemWrite: true,
      allowFieldCreation: true,
    });
  } catch {
    // Non-critical: cooldown tracking is best-effort
  }
}

/**
 * Send a DM nudge notification to the agent.
 * Gated behind GATE2_ENABLED flag (default off).
 */
function sendNudgeDm(agent, nudge) {
  if (!GATE2_ENABLED) return;

  try {
    const dmCh = getOrCreateDmChannel('System', agent);
    const content = `💡 Skill nudge: ${nudge.description}\nSuggested skill: ${nudge.suggested_skill_name} (confidence=${nudge.confidence})`;
    const dmMsg = saveMessage(dmCh.id, 'System', content, [agent], null, null, 'next');
    pushToAgent(agent, {
      type: 'message',
      channel: dmCh.id,
      from: 'System',
      content,
      mentions: [agent],
      id: dmMsg.id,
      timestamp: dmMsg.created_at,
    });
    log(`DM nudge sent to ${agent}: ${nudge.suggested_skill_name}`);
  } catch (err) {
    logErr(`Failed to send DM nudge to ${agent}: ${err.message}`);
  }
}

/**
 * Map a detected pattern to a nudge event and write it as a memory.
 */
function writeNudge(pattern) {
  const agent = pattern.agent || 'system';
  const signature = pattern.signature || pattern.toolName;

  // Cooldown check
  if (isNudgeOnCooldown(agent, signature)) {
    log(`Cooldown active for ${agent}:${signature}, skipping`);
    return null;
  }

  const nudge = buildNudgeEvent(pattern);
  if (!nudge || nudge.confidence < 0.5) {
    log(`Low confidence (${nudge?.confidence}), skipping nudge for ${agent}:${signature}`);
    return null;
  }

  // Create memory
  const memory = createMemory({
    agent,
    level: 'important',
    category: 'pattern',
    title: nudge.description,
    summary: JSON.stringify({
      pattern: nudge.pattern,
      frequency: nudge.frequency,
      suggested_skill_name: nudge.suggested_skill_name,
      confidence: nudge.confidence,
    }),
    raw_event: JSON.stringify(pattern),
    source_type: 'skill-nudge',
    source_id: `nudge_${agent}_${Date.now()}`,
    event_hash: `snudge_${agent}_${signature}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16),
    tags: JSON.stringify(['pattern', 'nudge', nudge.suggested_skill_name]),
    related_ids: '[]',
    ttl_days: 180,
  });

  // Mark cooldown
  markNudgeWritten(agent, signature);

  // DM notification (gated behind GATE2_ENABLED)
  sendNudgeDm(agent, nudge);

  log(`Nudge written: ${memory.id} "${nudge.description}" (confidence=${nudge.confidence})`);
  return memory;
}

/**
 * Build a nudge event from a detected pattern.
 * Returns { pattern, frequency, suggested_skill_name, description, confidence } or null.
 */
function buildNudgeEvent(pattern) {
  if (pattern.type === 'consecutive') {
    const toolName = pattern.toolName;
    const count = pattern.count;

    // Confidence: higher with more repetitions, capped at 0.95
    const confidence = Math.min(0.5 + (count - MIN_CONSECUTIVE) * 0.15, 0.95);

    return {
      pattern: `${toolName}_repeated`,
      frequency: count,
      suggested_skill_name: `auto-${toolName}`,
      description: `Agent "${pattern.agent}" called "${toolName}" ${count} times consecutively in session ${pattern.sessionId || 'N/A'}. Consider creating a skill to automate this workflow.`,
      confidence,
    };
  }

  if (pattern.type === 'cross_session') {
    const confidence = Math.min(0.6 + (pattern.occurrences - MIN_CROSS_SESSION) * 0.1, 0.95);

    return {
      pattern: `workflow_${pattern.signature.replace(/ → /g, '_').replace(/[^a-zA-Z0-9_]/g, '')}`,
      frequency: pattern.occurrences,
      suggested_skill_name: `workflow-${pattern.signature.replace(/ → /g, '-').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`,
      description: `Agent "${pattern.agent}" repeated workflow "${pattern.signature}" across ${pattern.occurrences} sessions. Consider creating a skill to encapsulate this pattern.`,
      confidence,
    };
  }

  return null;
}

// ── SkillNudgeProvider class ───────────────────────────────────

class SkillNudgeProvider extends MemoryProvider {
  constructor(config = {}) {
    super('skill-nudge', config);

    /** Scan timer */
    this._scanTimer = null;

    /** Last scanned cc_metrics id */
    this._lastScannedId = 0;

    /** In-memory buffer of recent PostToolUse rows per agent (for consecutive detection) */
    this._recentToolCalls = new Map(); // agent → [{ tool_name, timestamp, session_id }]

    /** Max rows per agent to keep in buffer */
    this._maxBufferPerAgent = 50;
  }

  /**
   * Initialize: load last scan position, start periodic cc_metrics scan.
   */
  async init() {
    // Load last scanned position
    try {
      const state = getState('memory', 'nudge_last_scanned_id');
      this._lastScannedId = state ? parseInt(state.value, 10) || 0 : 0;
    } catch {
      this._lastScannedId = 0;
    }

    // Start periodic scan
    this._scanTimer = setInterval(() => this._scanCcMetrics(), PATTERN_SCAN_INTERVAL);

    // Run first scan shortly after init
    setTimeout(() => this._scanCcMetrics(), 2000);

    log(`Initialized (lastScannedId=${this._lastScannedId}, scanInterval=${PATTERN_SCAN_INTERVAL / 1000}s)`);
  }

  /**
   * Handle memory_created events: feed into consecutive pattern detection.
   * Only interested in PostToolUse-sourced memories.
   */
  async onEvent(event) {
    if (event.type !== 'memory_created') return;

    // We primarily detect patterns from cc_metrics scan, but also
    // listen to memory_created to catch real-time PostToolUse events
    // that came through the memory engine.
    if (event.source_type !== 'cc_metrics') return;

    // Feed into buffer if we have the raw tool info
    try {
      if (event.raw_event) {
        const raw = typeof event.raw_event === 'string' ? JSON.parse(event.raw_event) : event.raw_event;
        if (raw.event === 'PostToolUse' && raw.tool_name) {
          this._addToBuffer(event.agent || 'system', {
            tool_name: raw.tool_name,
            timestamp: raw.timestamp || event.timestamp,
            session_id: event.memory_id, // approximate; real session_id from cc_metrics scan
          });
        }
      }
    } catch {
      // Parse errors are fine; we'll detect patterns from the periodic scan
    }

    // Also check buffer for consecutive patterns
    this._checkBufferPatterns(event.agent || 'system');
  }

  /**
   * Add a tool call to the agent's buffer.
   */
  _addToBuffer(agent, toolCall) {
    if (!this._recentToolCalls.has(agent)) {
      this._recentToolCalls.set(agent, []);
    }
    const buffer = this._recentToolCalls.get(agent);
    buffer.push(toolCall);

    // Trim old entries
    if (buffer.length > this._maxBufferPerAgent) {
      buffer.splice(0, buffer.length - this._maxBufferPerAgent);
    }
  }

  /**
   * Check the buffer for consecutive patterns and write nudges.
   */
  _checkBufferPatterns(agent) {
    const buffer = this._recentToolCalls.get(agent);
    if (!buffer || buffer.length < MIN_CONSECUTIVE) return;

    // Check the last N entries for consecutive same-tool calls
    const lastTool = normalizeToolName(buffer[buffer.length - 1].tool_name);
    let count = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (normalizeToolName(buffer[i].tool_name) === lastTool) {
        count++;
      } else {
        break;
      }
    }

    if (count >= MIN_CONSECUTIVE) {
      const pattern = {
        type: 'consecutive',
        toolName: lastTool,
        count,
        agent,
        sessionId: buffer[buffer.length - 1].session_id || null,
        signature: `${lastTool} ×${count}`,
      };
      writeNudge(pattern);

      // Clear the consecutive run from buffer to avoid re-triggering
      buffer.splice(buffer.length - count, count);
    }
  }

  /**
   * Periodic scan of cc_metrics for PostToolUse patterns.
   */
  async _scanCcMetrics() {
    try {
      const rows = getCcMetricsSince(this._lastScannedId, 500);
      if (rows.length === 0) return;

      let maxId = this._lastScannedId;

      // Filter to PostToolUse rows
      const postToolUseRows = [];
      for (const row of rows) {
        if (row.id > maxId) maxId = row.id;
        if (row.event === 'PostToolUse') {
          postToolUseRows.push(row);
          this._addToBuffer(row.agent, {
            tool_name: row.tool_name,
            timestamp: row.timestamp,
            session_id: row.session_id,
          });
        }
      }

      // Run pattern detection on the batch
      if (postToolUseRows.length >= MIN_CONSECUTIVE) {
        // Consecutive patterns
        const consecutive = detectConsecutivePatterns(postToolUseRows);
        for (const p of consecutive) {
          writeNudge(p);
        }

        // Cross-session patterns (need larger data set, use buffer)
        const crossSession = detectCrossSessionPatterns(postToolUseRows);
        for (const p of crossSession) {
          writeNudge(p);
        }
      }

      // Persist scan position
      this._lastScannedId = maxId;
      setState('memory', 'nudge_last_scanned_id', String(maxId), 'skill-nudge-provider', 'scan position', {
        systemWrite: true,
        allowFieldCreation: true,
      });

      log(`Scanned ${rows.length} cc_metrics rows (${postToolUseRows.length} PostToolUse, id up to ${maxId})`);
    } catch (err) {
      logErr(`cc_metrics scan error: ${err.message}`);
    }
  }

  /**
   * Query: return detected patterns as search results.
   * Supports { q, agent, limit }.
   */
  async query(query) {
    const { q, agent, limit = 10 } = query;

    // Search pattern memories
    try {
      const { getMemories } = await import('./db.mjs');
      const result = getMemories({
        category: 'pattern',
        agent: agent || undefined,
        search: q || undefined,
        limit,
      });

      return (result.memories || []).map(m => ({
        source: 'memory',
        id: m.id,
        content: `${m.title} ${m.summary}`.trim(),
        title: m.title,
        summary: m.summary,
        agent: m.agent,
        level: m.level,
        tags: m.tags,
        score: 1.0, // pattern memories are high relevance when queried
      }));
    } catch (err) {
      logErr(`query error: ${err.message}`);
      return [];
    }
  }

  /**
   * Shutdown: clear timers, flush state.
   */
  async shutdown() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
    this._recentToolCalls.clear();
    log('Shutdown complete');
  }
}

// ── Exports ────────────────────────────────────────────────────

export default SkillNudgeProvider;
export { SkillNudgeProvider };
