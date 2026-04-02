import http from 'node:http';
import { handleRequest } from './router.mjs';
import { closeAllConnections, pushToAgents } from './sse.mjs';
import { closeDb, getOverdueTasks, markOverdueNotified, saveMessage, getAllAgents } from './db.mjs';

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

      // SSE push to all agents
      const allAgents = getAllAgents().map(a => a.name);
      const msgEvent = { type: 'message', channel, from: 'System', content, mentions: mention ? [mention] : [], id: `sys_overdue_${task.id}_${Date.now()}`, timestamp: new Date().toISOString() };
      pushToAgents(allAgents, msgEvent);

      markOverdueNotified(task.id);
      console.log(`[overdue] Notified: ${task.title} (${task.id})`);
    }
  } catch (e) {
    console.error('[overdue] Check failed:', e.message);
  }
}, 60_000);

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
