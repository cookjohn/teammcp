import http from 'node:http';
import { handleRequest } from './router.mjs';
import { closeAllConnections, pushToAgents, getOnlineAgents } from './sse.mjs';
import { closeDb, getOverdueTasks, markOverdueNotified, saveMessage, getAllAgents, getSchedulesDue, updateScheduleNextRun, getNextCronRun, getCheckInDueTasks, updateCheckIn, getChannelMembers, getChannel, getPendingTasksCount, setState } from './db.mjs';

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
try {
  const { init: initWeChat, sendToWeChat } = await import('./wechat-bridge.mjs');
  const { pushToAgent } = await import('./sse.mjs');

  initWeChat((text, fromUser, contextToken) => {
    // WeChat message received → save as Chairman message to #general
    saveMessage('general', 'Chairman', text, '[]', null, { source: 'wechat', context_token: contextToken, from_user_id: fromUser });

    // Push to CEO and Audit (Chairman's direct reports)
    const event = { type: 'message', channel: 'general', from: 'Chairman', content: text, metadata: { source: 'wechat', context_token: contextToken }, id: `wechat_${Date.now()}`, timestamp: new Date().toISOString() };
    pushToAgent('CEO', event);
    pushToAgent('Audit', event);
  });

  // TODO: Handle TeamMCP → WeChat direction
  // When a message is sent to Chairman as DM or @Chairman, forward via sendToWeChat()
  // This requires hooking into the message send route or SSE event flow

  console.log('[TeamMCP] WeChat bridge initialized');
} catch (e) {
  // WeChat bridge is optional, don't fail server startup
  console.log('[TeamMCP] WeChat bridge not available:', e.message);
}

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
