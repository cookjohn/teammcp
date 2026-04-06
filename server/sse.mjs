import { setAgentStatus, getUnreadMessages, getUnreadCount, getUnreadMentions, getLastNMessages, getStateChangesSince, getAgentByName, batchUpdateReadStatus, saveMessage, getReportsTo } from './db.mjs';
import { isStopped } from './process-manager.mjs';

// Map: agentName → Set<res>  (one agent may have multiple SSE connections)
const connections = new Map();

// Agent output ring buffer: agentName → Array (max 100 entries per agent)
const AGENT_OUTPUT_MAX = 100;
const agentOutputBuffers = new Map();

export function pushAgentOutput(agentName, data) {
  // Store in ring buffer
  if (!agentOutputBuffers.has(agentName)) {
    agentOutputBuffers.set(agentName, []);
  }
  const buf = agentOutputBuffers.get(agentName);
  buf.push(data);
  if (buf.length > AGENT_OUTPUT_MAX) buf.shift();

  // Push to all SSE connections (Dashboard will filter by agent)
  const payload = `data: ${JSON.stringify({ type: 'agent-output', agent: agentName, ...data })}\n\n`;
  for (const [, set] of connections) {
    for (const r of set) {
      try { r.write(payload); } catch {}
    }
  }
}

export function getAgentOutputBuffer(agentName) {
  return agentOutputBuffers.get(agentName) || [];
}

// Agent error tracking: agentName → Array (max 50 entries)
const AGENT_ERROR_MAX = 50;
const agentErrorBuffers = new Map();

export function pushAgentError(agentName, data) {
  if (!agentErrorBuffers.has(agentName)) {
    agentErrorBuffers.set(agentName, []);
  }
  const buf = agentErrorBuffers.get(agentName);
  buf.push(data);
  if (buf.length > AGENT_ERROR_MAX) buf.shift();

  const payload = `data: ${JSON.stringify({ type: 'agent-error', agent: agentName, ...data })}\n\n`;
  for (const [, set] of connections) {
    for (const r of set) {
      try { r.write(payload); } catch {}
    }
  }
}

export function getAgentErrorBuffer(agentName) {
  return agentErrorBuffers.get(agentName) || [];
}

export function pushSessionEvent(agentName, data) {
  const payload = `data: ${JSON.stringify({
    type: 'session-event',
    agent: agentName,
    ...data
  })}\n\n`;
  for (const [, set] of connections) {
    for (const r of set) {
      try { r.write(payload); } catch {}
    }
  }
}

// Crash detection: track pending restart timers to avoid duplicate restarts
const crashTimers = new Map(); // agentName → timerId
const CRASH_DETECT_DELAY_MS = 30_000; // 30 seconds before declaring crash
const AUTO_RESTART_ENABLED = process.env.TEAMMCP_AUTO_RESTART === '1';

// Restart rate limiting: max 3 restarts per 5 minutes per agent
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;
const restartHistory = new Map(); // agentName → [timestamp, ...]

/**
 * Register an SSE connection for an agent.
 */
function log(msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${time}] [SSE] ${msg}`);
}

function removeConnection(agentName, res) {
  const set = connections.get(agentName);
  if (set) {
    set.delete(res);
    if (set.size === 0) {
      connections.delete(agentName);
      setAgentStatus(agentName, 'offline');
      log(`${agentName} disconnected`);
      scheduleCrashDetection(agentName);
    }
  }
}

/**
 * Schedule crash detection: if agent doesn't reconnect within CRASH_DETECT_DELAY_MS,
 * broadcast a crash notification and optionally auto-restart.
 */
function scheduleCrashDetection(agentName) {
  // Clear any existing timer for this agent
  if (crashTimers.has(agentName)) {
    clearTimeout(crashTimers.get(agentName));
  }

  const timerId = setTimeout(async () => {
    crashTimers.delete(agentName);

    // Check if agent reconnected during the wait
    if (isOnline(agentName)) return;

    // Skip crash alert for agents that were intentionally stopped
    if (isStopped(agentName)) {
      log(`${agentName}: skipping crash detection (intentionally stopped)`);
      return;
    }

    log(`${agentName} failed to reconnect within ${CRASH_DETECT_DELAY_MS / 1000}s — declaring crash`);

    // Broadcast crash notification to all connected agents
    const crashNotice = {
      type: 'message',
      channel: 'teammcp-dev',
      from: 'System',
      content: `⚠️ Agent ${agentName} 已离线超过 ${CRASH_DETECT_DELAY_MS / 1000} 秒，疑似崩溃。`,
      mentions: [],
      id: `sys_crash_${agentName}_${Date.now()}`,
      timestamp: new Date().toISOString()
    };

    // Save to DB so offline agents see it on reconnect
    try {
      saveMessage('teammcp-dev', 'System', crashNotice.content, JSON.stringify([]), null);
    } catch (e) {
      log(`Failed to save crash notice to DB: ${e.message}`);
    }

    for (const [name, set] of connections) {
      const payload = `data: ${JSON.stringify(crashNotice)}\n\n`;
      for (const r of set) {
        try { r.write(payload); } catch {}
      }
    }

    // Auto-restart if enabled (with rate limiting)
    if (AUTO_RESTART_ENABLED) {
      const now = Date.now();
      const history = restartHistory.get(agentName) || [];
      const recentRestarts = history.filter(t => now - t < RESTART_WINDOW_MS);
      restartHistory.set(agentName, recentRestarts);

      if (recentRestarts.length >= MAX_RESTARTS) {
        log(`${agentName}: restart rate limit reached (${MAX_RESTARTS}/${RESTART_WINDOW_MS / 60000}min), skipping auto-restart`);
        const rateLimitNotice = {
          type: 'message',
          channel: 'teammcp-dev',
          from: 'System',
          content: `🚫 Agent ${agentName} 自动重启已达上限（${MAX_RESTARTS} 次/${RESTART_WINDOW_MS / 60000} 分钟），停止自动重启。请人工排查。`,
          mentions: [],
          id: `sys_ratelimit_${agentName}_${now}`,
          timestamp: new Date().toISOString()
        };
        try { saveMessage('teammcp-dev', 'System', rateLimitNotice.content, JSON.stringify([]), null); } catch {}
        for (const [name, set] of connections) {
          const payload = `data: ${JSON.stringify(rateLimitNotice)}\n\n`;
          for (const r of set) { try { r.write(payload); } catch {} }
        }
        return;
      }

      recentRestarts.push(now);
      restartHistory.set(agentName, recentRestarts);

      log(`Attempting auto-restart for ${agentName} (${recentRestarts.length}/${MAX_RESTARTS})...`);
      try {
        const { startAgent, cleanupStaleProcEntry } = await import('./process-manager.mjs');
        // Clean up stale process entry so startAgent doesn't reject as "already tracked"
        cleanupStaleProcEntry(agentName);
        await startAgent(agentName);
        log(`${agentName} auto-restart initiated`);

        const restartNotice = {
          type: 'message',
          channel: 'teammcp-dev',
          from: 'System',
          content: `🔄 Agent ${agentName} 自动重启已触发。`,
          mentions: [],
          id: `sys_restart_${agentName}_${Date.now()}`,
          timestamp: new Date().toISOString()
        };
        try {
          saveMessage('teammcp-dev', 'System', restartNotice.content, JSON.stringify([]), null);
        } catch (e) {
          log(`Failed to save restart notice to DB: ${e.message}`);
        }
        for (const [name, set] of connections) {
          const payload = `data: ${JSON.stringify(restartNotice)}\n\n`;
          for (const r of set) {
            try { r.write(payload); } catch {}
          }
        }
      } catch (e) {
        log(`Auto-restart failed for ${agentName}: ${e.message}`);
        const failNotice = {
          type: 'message',
          channel: 'teammcp-dev',
          from: 'System',
          content: `❌ Agent ${agentName} 自动重启失败: ${e.message}`,
          mentions: [],
          id: `sys_restart_fail_${agentName}_${Date.now()}`,
          timestamp: new Date().toISOString()
        };
        try {
          saveMessage('teammcp-dev', 'System', failNotice.content, JSON.stringify([]), null);
        } catch (e2) {
          log(`Failed to save restart failure notice: ${e2.message}`);
        }
        for (const [name, set] of connections) {
          const payload = `data: ${JSON.stringify(failNotice)}\n\n`;
          for (const r of set) {
            try { r.write(payload); } catch {}
          }
        }
      }
    }
  }, CRASH_DETECT_DELAY_MS);

  crashTimers.set(agentName, timerId);
  log(`${agentName}: crash detection scheduled (${CRASH_DETECT_DELAY_MS / 1000}s)`);
}

export function addConnection(agentName, res) {
  // Cancel any pending crash detection — agent is back
  if (crashTimers.has(agentName)) {
    clearTimeout(crashTimers.get(agentName));
    crashTimers.delete(agentName);
    log(`${agentName}: crash detection cancelled (reconnected)`);
  }

  if (!connections.has(agentName)) {
    connections.set(agentName, new Set());
  }
  connections.get(agentName).add(res);
  setAgentStatus(agentName, 'online');
  log(`${agentName} connected (total: ${connections.get(agentName).size})`);

  // Disable socket timeout for this SSE connection
  res.socket?.setTimeout(0);
  res.socket?.setNoDelay(true);
  res.socket?.setKeepAlive(true, 30000);

  // Send keepalive every 15s (shorter interval to prevent proxy/firewall timeouts)
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // Connection dead — clean up
      clearInterval(keepalive);
      removeConnection(agentName, res);
    }
  }, 15000);

  res.on('close', () => {
    clearInterval(keepalive);
    removeConnection(agentName, res);
  });

  res.on('error', () => {
    clearInterval(keepalive);
    removeConnection(agentName, res);
  });
}

/**
 * Push an SSE event to a specific agent.
 */
export function pushToAgent(agentName, data) {
  const set = connections.get(agentName);
  if (!set || set.size === 0) {
    log(`→ ${agentName}: MISSED (offline)`);
    return false;
  }

  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {
      removeConnection(agentName, res);
    }
  }
  log(`→ ${agentName}: ${data.type} from ${data.from || '?'} (${(data.content || '').slice(0, 40)}...)`);
  return true;
}

/**
 * Push to multiple agents.
 */
const PUSH_STAGGER_MS = 1500; // Stagger pushes to avoid API rate limit storms

export function pushToAgents(agentNames, data) {
  agentNames.forEach((name, i) => {
    if (i === 0) {
      pushToAgent(name, data); // First agent immediately
    } else {
      setTimeout(() => pushToAgent(name, data), i * PUSH_STAGGER_MS);
    }
  });
}

/**
 * Push status change to relevant agents only (per command chain).
 * Only direct superior (from DB) + Chairman (Dashboard) are notified, not all agents.
 */
export function broadcastStatus(agentName, status) {
  const data = { type: 'status', agent: agentName, status };
  const payload = `data: ${JSON.stringify(data)}\n\n`;

  // Notify: direct superior (from DB) + always Chairman (Dashboard)
  const targets = new Set();
  const superior = getReportsTo(agentName);
  if (superior) targets.add(superior);
  targets.add('Chairman');

  for (const target of targets) {
    if (target === agentName) continue;
    const set = connections.get(target);
    if (!set) continue;
    for (const res of set) {
      try { res.write(payload); } catch {
        removeConnection(target, res);
      }
    }
  }
}

const SUMMARY_THRESHOLD = 20;

/**
 * Send missed messages to an agent on reconnect.
 * If a channel has more than SUMMARY_THRESHOLD unread messages,
 * send a reconnect_manifest summary instead of individual messages.
 *
 * Read-status updates are collected and applied in a single transaction
 * only after all pushes succeed, to prevent inconsistent state on crash.
 */
export function sendMissedMessages(agentName, channelIds) {
  const manifests = [];
  const readUpdates = []; // Collect all read-status updates, apply in transaction after push

  for (const chId of channelIds) {
    const count = getUnreadCount(agentName, chId);

    if (count === 0) continue;

    if (count <= SUMMARY_THRESHOLD) {
      // Normal replay for small number of unread messages
      const missed = getUnreadMessages(agentName, chId);
      for (const msg of missed) {
        const pushed = pushToAgent(agentName, {
          type: 'message',
          channel: msg.channel_id,
          from: msg.from_agent,
          content: msg.content,
          mentions: msg.mentions ? JSON.parse(msg.mentions) : [],
          id: msg.id,
          timestamp: msg.created_at,
          replyTo: msg.reply_to || null
        });
        if (pushed) {
          readUpdates.push({ agentName, channelId: chId, msgId: msg.id });
        }
      }
    } else {
      // Summary mode: send manifest instead of flooding messages
      const mentions = getUnreadMentions(agentName, chId);
      const lastMessages = getLastNMessages(chId, 5);
      const topicSummary = lastMessages
        .map(m => `[${m.from_agent}] ${m.content.split('\n')[0].slice(0, 100)}`)
        .join(' | ');

      manifests.push({
        channel: chId,
        unread_count: count,
        mentions: mentions.map(m => ({
          id: m.id,
          from: m.from_agent,
          content: m.content,
          timestamp: m.created_at,
          replyTo: m.reply_to || null
        })),
        topic_summary: topicSummary
      });

      // Push @mention messages individually as P0, only mark sent ones as read
      for (const msg of mentions) {
        const pushed = pushToAgent(agentName, {
          type: 'message',
          channel: msg.channel_id,
          from: msg.from_agent,
          content: msg.content,
          mentions: msg.mentions ? JSON.parse(msg.mentions) : [],
          id: msg.id,
          timestamp: msg.created_at,
          replyTo: msg.reply_to || null
        });
        if (pushed) {
          readUpdates.push({ agentName, channelId: chId, msgId: msg.id });
        }
      }
    }
  }

  // Query shared state changes since agent's last_seen timestamp
  const agent = getAgentByName(agentName);
  const lastSeen = agent?.last_seen;
  const stateChanges = lastSeen ? getStateChangesSince(lastSeen).map(c => ({
    project_id: c.project_id,
    field: c.field,
    old_value: c.old_value,
    new_value: c.new_value,
    changed_by: c.changed_by,
    timestamp: c.timestamp
  })) : [];

  // Send the reconnect manifest if there's anything to report
  if (manifests.length > 0 || stateChanges.length > 0) {
    const pushed = pushToAgent(agentName, {
      type: 'reconnect_manifest',
      channels: manifests,
      state_changes: stateChanges,
      message: `You were offline. ${manifests.length} channel(s) had more than ${SUMMARY_THRESHOLD} unread messages and were summarized. ${stateChanges.length} state change(s) occurred. @mentions were delivered. Use get_history for full details.`
    });
    if (!pushed) {
      // Agent went offline during reconnect — don't mark anything as read
      log(`${agentName}: reconnect manifest FAILED (agent offline), skipping read-status update`);
      return;
    }
    log(`${agentName}: reconnect manifest sent (${manifests.length} summarized channels, ${stateChanges.length} state changes)`);
  }

  // Apply all read-status updates in a single transaction after successful pushes
  if (readUpdates.length > 0) {
    batchUpdateReadStatus(readUpdates);
    log(`${agentName}: marked ${readUpdates.length} read-status update(s) in transaction`);
  }
}

/**
 * Check if an agent is currently connected.
 */
export function isOnline(agentName) {
  const set = connections.get(agentName);
  return set && set.size > 0;
}

export function getOnlineAgents() {
  return [...connections.keys()];
}

/**
 * Close all SSE connections (for graceful shutdown).
 */
export function closeAllConnections() {
  // Cancel all pending crash detection timers (graceful shutdown, not a crash)
  for (const [, timerId] of crashTimers) {
    clearTimeout(timerId);
  }
  crashTimers.clear();

  for (const [agentName, set] of connections) {
    for (const res of set) {
      try { res.end(); } catch {}
    }
    set.clear();
    setAgentStatus(agentName, 'offline');
  }
  connections.clear();
}
