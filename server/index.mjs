import http from 'node:http';
import { handleRequest } from './router.mjs';
import { closeAllConnections, pushToAgents, getOnlineAgents } from './sse.mjs';
import { closeDb, getOverdueTasks, markOverdueNotified, saveMessage, getAllAgents, getSchedulesDue, updateScheduleNextRun, getNextCronRun, getCheckInDueTasks, updateCheckIn, getDoingTasks, saveNotification, updateTaskMetadata, getChannelMembers, getChannel, getPendingTasksCount, setState } from './db.mjs';
import { subscribe } from './eventbus.mjs';

const PORT = process.env.TEAMMCP_PORT || 3100;

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

server.listen(PORT, () => {
  console.log(`[TeamMCP] Server running on http://localhost:${PORT}`);
});

// ── Task overdue reminder (every 60 seconds) ─────────────
setInterval(() => {
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

      setState('teammcp-dev', 'online_agents_count', String(onlineCount), 'System', 'Auto-computed', { isHumanOverride: true });
      setState('teammcp-dev', 'pending_tasks_count', String(pendingCount), 'System', 'Auto-computed', { isHumanOverride: true });
    } catch (e) {
      // Silent fail for auto-state inference
    }
  } catch (e) {
    console.error('[overdue] Check failed:', e.message);
  }
}, 60_000);

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
    let toolName = '', description = '';
    try {
      const pv = JSON.parse(event.proposed_value || '{}');
      toolName = pv.tool_name || '';
      description = pv.description || '';
    } catch {}
    const content = `[审批请求] ${toolName || event.field}\n${description}\n请求人：${event.proposed_by || 'unknown'}\n审批人：${event.approver || 'CEO'}`;
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
function shutdown(signal) {
  console.log(`\n[TeamMCP] Received ${signal}, shutting down...`);

  // Timeout: force exit after 5 seconds if server.close hangs
  const forceTimer = setTimeout(() => {
    console.log('[TeamMCP] Shutdown timeout, forcing exit');
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  // 1. Close all SSE connections first (unblocks server.close)
  closeAllConnections();
  console.log('[TeamMCP] SSE connections closed');

  // 2. Stop accepting new connections
  server.close(() => {
    console.log('[TeamMCP] HTTP server closed');

    // 3. Close database
    closeDb();
    console.log('[TeamMCP] Database closed');

    // 4. Exit
    console.log('[TeamMCP] Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
