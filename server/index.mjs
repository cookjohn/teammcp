import http from 'node:http';
import { handleRequest } from './router.mjs';
import { closeAllConnections, pushToAgents, getOnlineAgents } from './sse.mjs';
import { closeDb, getOverdueTasks, markOverdueNotified, saveMessage, getAllAgents, getSchedulesDue, updateScheduleNextRun, getNextCronRun, getCheckInDueTasks, updateCheckIn, getDoingTasks, saveNotification, updateTaskMetadata, getChannelMembers, getChannel, getPendingTasksCount, setState, sweepExpiredMemories } from './db.mjs';
import { subscribe } from './eventbus.mjs';
import { init as initCredentialManager, shutdown as shutdownCredentialManager } from './credential-manager.mjs';
import { startMemoryEngine, stopMemoryEngine } from './memory.mjs';
import db from './db.mjs';
import { getAgentByName } from './db.mjs';
// G1.F: registers the five default retention policies on import. Import
// MUST be after db.mjs so the registry primitive is initialized. Does NOT
// execute sweepAll — that's gated by the RETENTION_SWEEP=1 env flag.
import './retention-policies.mjs';
// G1.N: retention watchdog. Auto-starts when MEMORY_ENGINE=on AND RETENTION_SWEEP=1
// (i.e. inside the Gate 1 soak window). Manual control via startWatchdog/stopWatchdog.
// WATCHDOG_DISABLED=1 short-circuits even when both flags are on (emergency kill).
import { startWatchdog, stopWatchdog } from './retention-watchdog.mjs';
// CEO 2026-04-25: sweepAll auto-scheduler (see comment block in listen callback).
import { sweepAll } from './retention.mjs';
import { normalizeAddr } from './auth-token-utils.mjs';
import { attachWsServer, spawnPty } from './pty-manager.mjs';
// Phase 4-T1 (two-layer PTY) — gated by TEAMMCP_PTY_DAEMON=on. Imports
// are unconditional but the runtime calls below short-circuit when the
// flag is off. With the flag off, this entire daemon path is dormant
// and agents spawn locally via process-manager (HEAD behaviour).
import {
  ensureDaemon, startDaemonHealthMonitor, initDaemonWatchdog,
  onAgentsNeedRespawn, dedupeRestartAgent,
} from './daemon-launcher.mjs';
import {
  subscribeAll, onPtyOutput, onPtyExit, disconnectFromDaemon, listPtys, getScrollback,
} from './pty-daemon-client.mjs';

const PORT = process.env.TEAMMCP_PORT || 3100;
const BIND_HOST = process.env.TEAMMCP_BIND_HOST || '0.0.0.0';
const DAEMON_ENABLED = process.env.TEAMMCP_PTY_DAEMON === 'on';

// PTY Daemon connection (REQUIRED when DAEMON_ENABLED; exits on failure).
// When the flag is off the daemon path is dormant — agents continue to
// spawn locally via process-manager-impl-win.mjs.
let daemonConnected = false;
if (DAEMON_ENABLED) {
  const isDev = String(PORT) === '3200';
  try {
    console.log('[TeamMCP] Connecting to PTY Daemon (TEAMMCP_PTY_DAEMON=on)...');
    const result = await ensureDaemon({ isDev });
    daemonConnected = result.connected;
    if (!daemonConnected) {
      console.error('[TeamMCP] FATAL: TEAMMCP_PTY_DAEMON=on but daemon failed to connect.');
      console.error('[TeamMCP] Either unset TEAMMCP_PTY_DAEMON to use local pty.spawn, or investigate daemon-launcher logs.');
      process.exit(1);
    }
    console.log(`[TeamMCP] PTY Daemon connected (PID: ${result.pid}, spawned: ${result.spawned})`);
    await subscribeAll();
    console.log('[TeamMCP] Subscribed to all PTY output');
  } catch (err) {
    console.error('[TeamMCP] FATAL: PTY Daemon connection failed:', err.message);
    process.exit(1);
  }
}

// ── Pre-flight: refuse to start on a bloated DB ──────────────
// Normal size is a few tens of MB. If we boot on a multi-GB DB, something
// is silently looping (2026-04-17 incident: 201GB from memory dedup layer).
// Bypass with PREFLIGHT_DB_MAX_BYTES=0 if you truly need to boot for surgery.
{
  const maxBytes = Number(process.env.PREFLIGHT_DB_MAX_BYTES ?? 5 * 1024 * 1024 * 1024);
  if (maxBytes > 0) {
    const { statSync } = await import('node:fs');
    const path = await import('node:path');
    const dbPath = path.join(process.env.TEAMMCP_HOME || process.cwd(), 'data', 'teammcp.db');
    try {
      const size = statSync(dbPath).size;
      if (size > maxBytes) {
        console.error(`[TeamMCP] pre-flight FAILED: DB ${(size/1e9).toFixed(2)}GB exceeds ${(maxBytes/1e9).toFixed(2)}GB limit (${dbPath})`);
        console.error('[TeamMCP] Likely a write-amplification loop. Investigate before starting. Override with PREFLIGHT_DB_MAX_BYTES=0.');
        process.exit(1);
      }
      console.log(`[TeamMCP] pre-flight: DB ${(size/1e6).toFixed(2)}MB OK`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[TeamMCP] pre-flight: could not stat DB:', err.message);
    }
  }
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const ms = Date.now() - start;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${time}] ${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`);
    return origEnd(...args);
  };
  handleRequest(req, res);
});

// SSE long-lived connections: only disable request timeout
server.requestTimeout = 0;

server.listen(PORT, BIND_HOST, () => {
  const addr = server.address();
  const normalized = normalizeAddr(addr?.address);
  console.log(`[TeamMCP] bound to ${normalized}:${addr.port}`);
  console.log(`[TeamMCP] Server running on http://localhost:${PORT}`);
  // Initialize credential manager after server is listening
  initCredentialManager({
    setState,
    isApiKeyAgent: (name) => {
      try { return getAgentByName(name)?.auth_mode === 'api_key'; } catch { return false; }
    },
  });

  // ── PTY WebSocket Terminal ──────────────────
  attachWsServer(server);

  // ── PTY Daemon runtime wiring (Phase 4-T1) ──────────────
  // Gated on a successful daemon connection. With daemonConnected=false
  // (either DAEMON_ENABLED=false or daemon offline), this block is a
  // no-op and the local pty.spawn path remains active.
  if (daemonConnected) {
    // Output / exit fan-out: daemon push notifications → WS broadcast +
    // crash detection. pty-manager installs __ptyWsBroadcast and
    // __onPtyExit at module init.
    onPtyOutput((agent, dataBuffer) => {
      if (globalThis.__ptyWsBroadcast) globalThis.__ptyWsBroadcast(agent, dataBuffer);
    });
    onPtyExit((agent, exitCode) => {
      console.log(`[TeamMCP] PTY ${agent} exited (code ${exitCode})`);
      if (globalThis.__onPtyExit) globalThis.__onPtyExit(agent, exitCode);
    });

    // Watchdog injection: setState writes go to the `system` project's
    // `pty_daemon.status` field; restartAgent uses process-manager.
    initDaemonWatchdog({
      setState: (key, value, reason) => {
        try {
          const firstSlash = key.indexOf('/');
          const projectId = firstSlash > 0 ? key.slice(0, firstSlash) : 'system';
          const field = firstSlash > 0 ? key.slice(firstSlash + 1) : key;
          setState(projectId, field, value, 'system:pty-watchdog', reason || 'watchdog', { isHumanOverride: true });
        } catch (e) { console.error('[pty-watchdog] setState injection failed:', e.message); }
      },
      restartAgent: async (agentId) => {
        const { startAgent } = await import('./process-manager.mjs');
        return startAgent(agentId);
      },
      notify: (msg) => console.warn('[pty-watchdog]', msg),
    });

    // Lost-agent respawn (Option A): when the watchdog respawns the
    // daemon and Windows wipes all conpty handles, every tracked agent
    // needs restarting. dedupeRestartAgent coalesces with the watchdog's
    // injected-fn path so we don't double-respawn.
    onAgentsNeedRespawn(async (lost) => {
      if (!Array.isArray(lost) || lost.length === 0) return;
      console.log(`[TeamMCP] onAgentsNeedRespawn fired for ${lost.length} agent(s):`, lost);
      const { startAgent } = await import('./process-manager.mjs');
      for (const id of lost) {
        try {
          await dedupeRestartAgent(id, startAgent);
        } catch (e) {
          console.error(`[TeamMCP] respawn ${id} failed:`, e.message);
        }
      }
    });

    startDaemonHealthMonitor((h) => {
      if (h.failures > 0) console.warn(`[TeamMCP] Daemon health: ${h.failures} consecutive failures`);
    });
    console.log('[TeamMCP] PTY Daemon runtime wired (output/exit fan-out + watchdog + respawn hook)');

    // ── Phase 4-T1 G7: server-restart reattach ──────────
    // If the daemon was already alive (we did NOT spawn it this boot),
    // it has live agents that this server doesn't know about. Rebuild
    // process-manager's `processes` map + DaemonPtyHandle proxies so
    // Dashboard / stopAgent / crash detection work. Scrollback seed
    // (~100KB/agent) restores terminal UX after restart.
    (async () => {
      try {
        const listResult = await listPtys();
        const items = listResult?.handles || listResult?.agents || [];
        if (items.length === 0) {
          console.log('[TeamMCP] reattach: daemon has no running agents');
          return;
        }
        console.log(`[TeamMCP] reattach: ${items.length} agent(s) found in daemon`);
        const { reattachExistingAgent } = await import('./process-manager.mjs');
        for (const row of items) {
          const agentId = row.agent || row.agentId || row.name;
          if (!agentId) continue;
          let scrollback = '';
          try {
            const sb = await getScrollback(agentId, 1000);
            scrollback = sb?.data || sb?.scrollback || '';
          } catch (e) {
            console.warn(`[TeamMCP] reattach: getScrollback(${agentId}) failed: ${e.message}`);
          }
          try {
            await reattachExistingAgent(agentId, row, scrollback);
          } catch (e) {
            console.error(`[TeamMCP] reattach: ${agentId} failed: ${e.message}`);
          }
        }
      } catch (e) {
        console.error('[TeamMCP] reattach loop failed:', e.message);
      }
    })();
  }

  // ── Memory Engine (Phase 2) ──────────────────────────────
  // H1 fix: fail-fast if MEMORY_LLM_KEY is not set
  if (!process.env.MEMORY_LLM_KEY) {
    console.warn('[TeamMCP] MEMORY_LLM_KEY not set — memory engine LLM features disabled (classify/summarize/ask will fail)');
  }
  try {
    startMemoryEngine();
    console.log('[TeamMCP] Memory engine started');
  } catch (err) {
    console.error('[TeamMCP] Memory engine failed to start:', err.message);
  }

  // ── Retention Watchdog (G1.N) ────────────────────────────
  // Auto-start only inside the soak window: both MEMORY_ENGINE=on and
  // RETENTION_SWEEP=1. WATCHDOG_DISABLED=1 short-circuits in startWatchdog itself.
  if (process.env.MEMORY_ENGINE === 'on' && process.env.RETENTION_SWEEP === '1') {
    try {
      startWatchdog({ caller: 'index.mjs:soak-start' });
      console.log('[TeamMCP] Retention watchdog started (soak mode)');
    } catch (err) {
      console.error('[TeamMCP] Retention watchdog failed to start:', err.message);
    }

    // ── Retention Sweep Scheduler ────────────────────────
    // CEO 2026-04-25: Discovery during soak start — retention-policies.mjs
    // registers the 7 policies but nothing schedules sweepAll(). The previous
    // index.mjs soft-sweep timer was removed under "single-driver invariant"
    // assuming retention-policies.mjs would self-schedule, which it does not.
    // Without a scheduler, retention is dormant: R1 (DB日增<1MB) is unverifiable.
    // Add a 1h interval sweep here, gated on the same MEMORY_ENGINE=on +
    // RETENTION_SWEEP=1 conditions. First sweep at boot+5min so startup is clean.
    setTimeout(() => {
      sweepAll({ caller: 'scheduler:boot+5min' })
        .then(r => console.log(`[retention] boot+5min sweep done: scanned=${r.totals.scanned} hardDeleted=${r.totals.hardDeleted} bytesReclaimed=${r.totals.bytesReclaimed} errors=${r.totals.errors} duration=${r.durationMs}ms`))
        .catch(err => console.error('[retention] boot+5min sweep failed:', err.message));
    }, 5 * 60 * 1000).unref?.();
    const retentionTimer = setInterval(() => {
      sweepAll({ caller: 'scheduler:1h' })
        .then(r => console.log(`[retention] 1h sweep done: scanned=${r.totals.scanned} hardDeleted=${r.totals.hardDeleted} bytesReclaimed=${r.totals.bytesReclaimed} errors=${r.totals.errors} duration=${r.durationMs}ms`))
        .catch(err => console.error('[retention] 1h sweep failed:', err.message));
    }, 60 * 60 * 1000);
    retentionTimer.unref?.();
    process.once('SIGTERM', () => clearInterval(retentionTimer));
    process.once('SIGINT', () => clearInterval(retentionTimer));
    console.log('[TeamMCP] Retention sweep scheduler started (interval: 1h, first sweep at boot+5min)');
  } else {
    console.log(`[TeamMCP] Retention watchdog NOT started (MEMORY_ENGINE=${process.env.MEMORY_ENGINE || 'unset'}, RETENTION_SWEEP=${process.env.RETENTION_SWEEP || 'unset'})`);
  }

  // ── Memory TTL Sweep (Phase 4-integration-04) — DISABLED 2026-04-22 ───
  // CTO FAIL 13 ruling: memories_ttl (retention-policies.mjs) is the sole
  // scheduled driver for memory TTL cleanup, so R1 audit rows in
  // retention_event represent the full picture. The retention scanner
  // delegates to sweepExpiredMemories() via a customSweep hook, preserving
  // FTS atomicity, and writes retention_event audit rows for every pass.
  //
  // The HTTP route POST /api/memories/sweep in router.mjs still calls
  // sweepExpiredMemories() directly — that's an explicit admin API, not a
  // scheduled job, and is left intact.
  //
  // Previously here: setTimeout(boot+30s) + setInterval(6h) soft sweeps.
  // Removed to enforce single-driver invariant.
});

// ── Task overdue reminder (DISABLED by Chairman 2026-04-11) ─────────────
const _DISABLED_TASK_MANAGER = () => {
  try {
    const overdue = getOverdueTasks();
    for (const task of overdue) {
      const channel = task.channel || 'teammcp-dev';
      const mention = task.assignee || task.creator;
      const content = `⏰ 任务已到期提醒：**${task.title}** [${task.priority}]\n截止时间：${task.due_date}\n负责人：${mention}\nTask ID: ${task.id}`;
      const mentions = mention ? JSON.stringify([mention]) : '[]';
      saveMessage(channel, 'System', content, mentions, null);

      // SSE push to task assignee and creator only
      const overdueTargets = new Set();
      if (task.assignee) overdueTargets.add(task.assignee);
      if (task.creator) overdueTargets.add(task.creator);
      const msgEvent = { type: 'message', channel, from: 'System', content, mentions: mention ? [mention] : [], id: `sys_overdue_${task.id}_${Date.now()}`, timestamp: new Date().toISOString() };
      pushToAgents([...overdueTargets], msgEvent);

      markOverdueNotified(task.id);
      console.log(`[overdue] Notified: ${task.title} (${task.id})`);
    }

    // Check-in reminders
    const checkins = getCheckInDueTasks();
    for (const task of checkins) {
      const channel = task.channel || 'teammcp-dev';
      const mention = task.assignee || task.creator;
      let meta = {};
      try { meta = JSON.parse(task.metadata || '{}'); } catch {}
      const progress = meta.progress !== undefined ? ` (进度: ${meta.progress}%)` : '';
      const content = `📋 定期 Check-in 提醒：**${task.title}**${progress}\n请汇报当前进展。\n负责人：${mention}\nTask ID: ${task.id}`;
      const mentions = mention ? JSON.stringify([mention]) : '[]';
      saveMessage(channel, 'System', content, mentions, null);
      const checkinTargets = new Set();
      if (task.assignee) checkinTargets.add(task.assignee);
      if (task.creator) checkinTargets.add(task.creator);
      pushToAgents([...checkinTargets], { type: 'message', channel, from: 'System', content, mentions: mention ? [mention] : [], id: `sys_checkin_${task.id}_${Date.now()}`, timestamp: new Date().toISOString() });
      updateCheckIn(task.id);
      console.log(`[checkin] Reminded: ${task.title} (${task.id})`);
    }
    // Check-in reminders (continued above)
    // ... code above ...

    // ── Doing task timeout detection (every 60 seconds) ──
    // Timeout levels: 30min → level 1, 60min → level 2, 120min → level 3
    const TIMEOUT_L1 = 30 * 60 * 1000;  // 30 minutes
    const TIMEOUT_L2 = 60 * 60 * 1000;  // 60 minutes
    const TIMEOUT_L3 = 120 * 60 * 1000; // 120 minutes
    const COOLDOWN = 15 * 60 * 1000;    // 15 minute cooldown between escalations

    const doingTasks = getDoingTasks();
    const now = Date.now();

    for (const task of doingTasks) {
      const lastUpdate = new Date(task.updated_at).getTime();
      const idleTime = now - lastUpdate;

      // Parse metadata for escalation tracking
      let meta = {};
      try { meta = JSON.parse(task.metadata || '{}'); } catch {}
      const lastEscalation = meta.last_escalation_time || 0;

      // Level 3: 120+ minutes idle → critical alert to all
      if (idleTime > TIMEOUT_L3) {
        if (now - lastEscalation > COOLDOWN) {
          const notifId = `notif_timeout3_${task.id}_${Date.now()}`;
          const content = `[严重] 任务"${task.title}"已失控超2小时无响应！\n负责人：${task.assignee}\nTask ID: ${task.id}`;
          saveNotification(notifId, 'Chairman', 'wechat', content, task.id);
          saveMessage('teammcp-dev', 'System', content, '[]', null);
          pushToAgents(['CEO', 'Audit', task.assignee].filter(Boolean), {
            type: 'message',
            channel: 'teammcp-dev',
            from: 'System',
            content,
            mentions: [],
            id: `sys_timeout3_${task.id}_${Date.now()}`,
            timestamp: new Date().toISOString()
          });
          meta.last_escalation_time = now;
          meta.escalation_level = 3;
          updateTaskMetadata(task.id, meta);
          console.log(`[timeout L3] Task ${task.id} escalated to critical`);
        }
      }
      // Level 2: 60+ minutes idle → escalate to CEO
      else if (idleTime > TIMEOUT_L2) {
        if (now - lastEscalation > COOLDOWN) {
          const notifId = `notif_timeout2_${task.id}_${Date.now()}`;
          const content = `[升级] 任务"${task.title}"已超时1小时无响应\n负责人：${task.assignee}\n上次更新：${task.updated_at}`;
          saveNotification(notifId, 'CEO', 'wechat', content, task.id);
          saveNotification(notifId + '_assignee', task.assignee, 'wechat', `[催促] 任务"${task.title}"已超时1小时，请立即处理！`, task.id);
          pushToAgents(['CEO', task.assignee].filter(Boolean), {
            type: 'message',
            channel: 'teammcp-dev',
            from: 'System',
            content,
            mentions: task.assignee ? [task.assignee] : [],
            id: `sys_timeout2_${task.id}_${Date.now()}`,
            timestamp: new Date().toISOString()
          });
          meta.last_escalation_time = now;
          meta.escalation_level = 2;
          updateTaskMetadata(task.id, meta);
          console.log(`[timeout L2] Task ${task.id} escalated to CEO`);
        }
      }
      // Level 1: 30+ minutes idle → remind assignee
      else if (idleTime > TIMEOUT_L1) {
        if (now - lastEscalation > COOLDOWN) {
          const notifId = `notif_timeout1_${task.id}_${Date.now()}`;
          const content = `[催促] 任务"${task.title}"已30分钟无更新，请汇报进度\n负责人：${task.assignee}\nTask ID: ${task.id}`;
          saveNotification(notifId, task.assignee, 'wechat', content, task.id);
          pushToAgents([task.assignee].filter(Boolean), {
            type: 'message',
            channel: 'teammcp-dev',
            from: 'System',
            content,
            mentions: task.assignee ? [task.assignee] : [],
            id: `sys_timeout1_${task.id}_${Date.now()}`,
            timestamp: new Date().toISOString()
          });
          meta.last_escalation_time = now;
          meta.escalation_level = 1;
          updateTaskMetadata(task.id, meta);
          console.log(`[timeout L1] Task ${task.id} reminded assignee`);
        }
      }
    }

    // ── Auto-state inference: compute and update system state fields ──
    try {
      const onlineAgents = getOnlineAgents();
      const onlineCount = onlineAgents.length;
      const pendingCount = getPendingTasksCount();

      setState('teammcp-dev', 'online_agents_count', String(onlineCount), 'System', 'Auto-computed', { systemWrite: true, allowFieldCreation: true });
      setState('teammcp-dev', 'pending_tasks_count', String(pendingCount), 'System', 'Auto-computed', { systemWrite: true, allowFieldCreation: true });
    } catch (e) {
      // Silent fail for auto-state inference
    }
  } catch (e) {
    console.error('[overdue] Check failed:', e.message);
  }
};
// _DISABLED_TASK_MANAGER above — disabled by Chairman 2026-04-11

// ── Scheduled message dispatcher (every 60 seconds) ──────
setInterval(() => {
  try {
    const due = getSchedulesDue();
    for (const sched of due) {
      // Save the message to the channel
      saveMessage(sched.channel, sched.created_by, sched.content, '[]', null);

      // SSE push to channel members
      const schedChannel = getChannel(sched.channel);
      const schedTargets = schedChannel ? getChannelMembers(sched.channel) : [];
      const msgEvent = {
        type: 'message',
        channel: sched.channel,
        from: sched.created_by,
        content: sched.content,
        mentions: [],
        id: `sched_msg_${sched.id}_${Date.now()}`,
        timestamp: new Date().toISOString(),
      };
      pushToAgents(schedTargets, msgEvent);

      // Calculate next run and update
      const nextRun = getNextCronRun(sched.cron_expr, new Date());
      if (nextRun) {
        updateScheduleNextRun(sched.id, nextRun.toISOString());
      }

      console.log(`[schedule] Fired: ${sched.id} → #${sched.channel}`);
    }
  } catch (e) {
    console.error('[schedule] Check failed:', e.message);
  }
}, 60_000);

// ── WeChat Bridge (optional) ─────────────────────
let sendToWeChat = null;
try {
  const wechatMod = await import('./wechat-bridge.mjs');
  sendToWeChat = wechatMod.sendToWeChat;
  const { pushToAgent } = await import('./sse.mjs');

  wechatMod.init((text, fromUser, contextToken) => {
    // WeChat message received → save as Chairman message to #general
    saveMessage('general', 'Chairman', text, '[]', null, { source: 'wechat', context_token: contextToken, from_user_id: fromUser });

    // Push to CEO and Audit (Chairman's direct reports)
    const event = { type: 'message', channel: 'general', from: 'Chairman', content: text, metadata: { source: 'wechat', context_token: contextToken }, id: `wechat_${Date.now()}`, timestamp: new Date().toISOString() };
    pushToAgent('CEO', event);
    pushToAgent('Audit', event);
  });

  console.log('[TeamMCP] WeChat bridge initialized');
} catch (e) {
  // WeChat bridge is optional, don't fail server startup
  console.log('[TeamMCP] WeChat bridge not available:', e.message);
}

// ── Approval notification → WeChat push ───────────────
subscribe('approval_requested', (event) => {
  try {
    let toolName = '', description = '', inputPreview = '';
    try {
      const pv = JSON.parse(event.proposed_value || '{}');
      toolName = pv.tool_name || '';
      description = pv.description || '';
      inputPreview = pv.input_preview || '';
    } catch {}
    const shortCode = (event.approval_id || '').slice(-4);
    const content = `[审批请求 #${shortCode}] ${toolName || event.field}\n${description}${inputPreview ? '\n操作内容：' + inputPreview : ''}\n请求人：${event.proposed_by || 'unknown'}\n回复：批准 ${shortCode} / 拒绝 ${shortCode}`;
    const notifId = `notif_approval_${event.approval_id}_${Date.now()}`;
    saveNotification(notifId, event.approver || 'CEO', 'wechat', content);

    // Push to WeChat immediately
    if (sendToWeChat) {
      sendToWeChat(content, '').catch(e => {
        console.error('[Approval] WeChat push failed:', e.message);
      });
    } else {
      console.warn('[Approval] WeChat not connected, notification saved to DB only');
    }
    console.log(`[Approval] Notification processed for ${event.approval_id}`);
  } catch (e) {
    console.error('[Approval] WeChat notification error:', e.message);
  }
});

// ── Graceful shutdown ──────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[TeamMCP] Received ${signal}, shutting down...`);

  // Timeout: force exit after 5 seconds if server.close hangs
  const forceTimer = setTimeout(() => {
    console.log('[TeamMCP] Shutdown timeout, forcing exit');
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  // 1. Disconnect from PTY Daemon (Daemon keeps running — that's the point).
  // Idempotent: noop if we never connected.
  if (daemonConnected) {
    try { disconnectFromDaemon(); console.log('[TeamMCP] PTY Daemon disconnected'); } catch {}
  }

  // 2. Close all SSE connections first (unblocks server.close)
  closeAllConnections();
  console.log('[TeamMCP] SSE connections closed');

  // 3. Stop memory engine (before closing DB)
  try { await stopMemoryEngine(); console.log('[TeamMCP] Memory engine stopped'); } catch {}

  // 3. Stop accepting new connections
  server.close(() => {
    console.log('[TeamMCP] HTTP server closed');

    // 4. Close database
    closeDb();
    console.log('[TeamMCP] Database closed');

    // 5. Exit
    console.log('[TeamMCP] Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
