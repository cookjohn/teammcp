import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerAgent, getAllAgents, getAgentByName,
  saveMessage, getMessages, getMessage, editMessage, deleteMessage, searchMessages,
  getChannel, createChannel, getChannelsForAgent, getChannelMembers, addChannelMember, removeChannelMember,
  getOrCreateDmChannel, updateReadStatus, setAgentStatus,
  createTask, getTask, getTasks, updateTask, deleteTask, getTaskHistory, updateMessageMetadata,
  getTaskWithChildren, getCheckInDueTasks, updateCheckIn,
  MANAGERS,
  getState, setState, getStateHistory, subscribeToState,
  getPendingApprovals, resolveApproval,
  addReaction, removeReaction, getReactions, getReactionsForMessages,
  pinMessage, unpinMessage, getPinnedMessages, isPinned,
  AUDIT_ROLES, STATE_ADMINS,
  auditGetAllState, auditGetChangeLog,
  auditGenerateComplianceReport, auditGenerateEfficiencyReport, auditGenerateAnomalyReport,
  saveAuditReport, getAuditReports,
  getAgentProfile, upsertAgentProfile,
  checkKnowledgeGaps, updateLastKnownVersions,
  routeTask, concludeDiscussion, getPublicAuditReports,
  getUnreadCount, getUnreadMessages, getUnreadMentions, getLastNMessages,
  getLastUnreadMessageId, getStateChangesSince,
  createSchedule, getSchedules, deleteSchedule,
  saveFile, getFile,
  getReportsTo, setReportsTo, getSubordinates,
  ackMessage, getMessageAcks,
  setUseResume, getUseResume
} from './db.mjs';
import { requireAuth } from './auth.mjs';
import {
  addConnection, pushToAgent, pushToAgents,
  broadcastStatus, sendMissedMessages, isOnline, getOnlineAgents,
  pushAgentOutput, getAgentOutputBuffer,
  pushAgentError, getAgentErrorBuffer
} from './sse.mjs';
import { startAgent, stopAgent, screenshotAgent, sendKeysToAgent, getAgentProcessStatus, checkProcessPermission } from './process-manager.mjs';
import { publish } from './eventbus.mjs';
import { AGENTS_DIR } from './lib/paths.mjs';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const PUBLIC_DIR = join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const startedAt = Date.now();

// ── Inbox helpers ────────────────────────────────────────

function formatInboxMessage(msg) {
  return {
    id: msg.id,
    channel: msg.channel_id,
    from: msg.from_agent,
    content: msg.content,
    mentions: (() => { try { return msg.mentions ? JSON.parse(msg.mentions) : []; } catch { return []; } })(),
    replyTo: msg.reply_to || null,
    timestamp: msg.created_at,
  };
}

// ── Rate limiter (10 msg/s per agent) ───────────────────

const rateBuckets = new Map();
const offlineNotifyCache = new Map(); // "offline_notify_{agent}" → timestamp (5 min debounce)

function checkRate(agentName) {
  const now = Date.now();
  if (!rateBuckets.has(agentName)) {
    rateBuckets.set(agentName, []);
  }
  const bucket = rateBuckets.get(agentName);
  // Remove timestamps older than 1s
  while (bucket.length && bucket[0] < now - 1000) bucket.shift();
  if (bucket.length >= 10) return false;
  bucket.push(now);
  return true;
}

// ── Config ──────────────────────────────────────────────

const REGISTER_SECRET = process.env.TEAMMCP_REGISTER_SECRET || '';

// Ensure Chairman always receives push events (admin oversight from Dashboard)
function ensureChairman(targets, excludeName) {
  if (!targets.includes('Chairman') && excludeName !== 'Chairman') {
    targets.unshift('Chairman'); // Chairman first — highest priority, no stagger delay
  }
  return targets;
}
const MAX_BODY_SIZE = 8 * 1024 * 1024; // 8MB (supports base64-encoded files up to ~5MB)
const MAX_CONTENT_LENGTH = 10000; // characters
const MAX_HISTORY_LIMIT = 200;

// ── Register rate limiter (5 per minute per IP) ─────────

const registerBuckets = new Map();

function checkRegisterRate(ip) {
  const now = Date.now();
  if (!registerBuckets.has(ip)) {
    registerBuckets.set(ip, []);
  }
  const bucket = registerBuckets.get(ip);
  while (bucket.length && bucket[0] < now - 60000) bucket.shift();
  if (bucket.length >= 5) return false;
  bucket.push(now);
  return true;
}

// ── Helpers ─────────────────────────────────────────────

function isValidUtf8(buf) {
  // Check for UTF-8 replacement character (U+FFFD = ef bf bd), which indicates
  // the input contained bytes that are not valid UTF-8 (e.g. GBK-encoded Chinese)
  const str = buf.toString('utf8');
  return !str.includes('\ufffd') && buf.toString('hex').indexOf('efbfbd') === -1;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Check Content-Type charset — reject non-UTF-8 encodings early
    const contentType = req.headers['content-type'] || '';
    const charsetMatch = contentType.match(/charset\s*=\s*([^\s;]+)/i);
    if (charsetMatch) {
      const charset = charsetMatch[1].toLowerCase().replace(/['"]/g, '');
      if (charset !== 'utf-8' && charset !== 'utf8') {
        reject(Object.assign(new Error(`Unsupported charset: ${charset}. Only UTF-8 is accepted`), { statusCode: 400 }));
        return;
      }
    }

    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        if (!isValidUtf8(buf)) {
          reject(Object.assign(new Error('Request body must be UTF-8 encoded'), { statusCode: 400 }));
          return;
        }
        resolve(JSON.parse(buf.toString('utf8')));
      }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ── Router ──────────────────────────────────────────────

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS (for potential web dashboard)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static file serving (no auth) ──────────────────
  if (method === 'GET' && !path.startsWith('/api/')) {
    let filePath = path === '/' ? '/index.html' : path;
    // Prevent directory traversal
    if (filePath.includes('..')) { res.writeHead(403); res.end(); return; }
    const fullPath = join(PUBLIC_DIR, filePath);
    try {
      const data = await readFile(fullPath);
      const ext = extname(fullPath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
      return;
    } catch {
      // Fall through to API routes / 404
    }
  }

  try {
    // ── POST /api/register (no auth required, but rate-limited + optional secret) ─
    if (method === 'POST' && path === '/api/register') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!checkRegisterRate(ip)) {
        return json(res, { error: 'Registration rate limit exceeded (5/min)' }, 429);
      }

      const body = await readBody(req);

      if (REGISTER_SECRET && body.secret !== REGISTER_SECRET) {
        return json(res, { error: 'Invalid or missing registration secret' }, 403);
      }

      if (!body.name) return json(res, { error: 'name is required' }, 400);

      // Check for U+FFFD replacement characters in name/role (indicates encoding corruption)
      if (body.name.includes('\ufffd')) {
        return json(res, { error: 'name contains invalid characters (encoding error detected)' }, 400);
      }
      if (body.role && body.role.includes('\ufffd')) {
        return json(res, { error: 'role contains invalid characters (encoding error detected)' }, 400);
      }

      const agent = registerAgent(body.name, body.role);

      // Optionally create agent directory structure (for wizard/Dashboard use)
      if (body.createDirectory && (process.env.AGENTS_BASE_DIR || AGENTS_DIR)) {
        try {
          const agentsBase = process.env.AGENTS_BASE_DIR || AGENTS_DIR;
          const agentDir = join(agentsBase, body.name);
          if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
          // Create .claude-config
          const configDir = join(agentDir, '.claude-config');
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
          // Create .mcp.json
          const mcpJsonPath = join(agentDir, '.mcp.json');
          if (!existsSync(mcpJsonPath)) {
            const packageRoot = join(fileURLToPath(import.meta.url), '..', '..');
            const mcpClientPath = join(packageRoot, 'mcp-client', 'teammcp-channel.mjs').replace(/\\/g, '/');
            const serverUrl = process.env.TEAMMCP_URL || `http://localhost:${process.env.TEAMMCP_PORT || 3100}`;
            writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { teammcp: { command: 'node', args: [mcpClientPath], env: { AGENT_NAME: body.name, TEAMMCP_KEY: agent.api_key, TEAMMCP_URL: serverUrl } } } }, null, 2), 'utf-8');
          }
          // Create CLAUDE.md
          const claudeMdPath = join(agentDir, 'CLAUDE.md');
          if (!existsSync(claudeMdPath)) {
            writeFileSync(claudeMdPath, `你是 ${body.name}（${body.role || 'AI Assistant'}）。\n\n## 沟通方式\n\n- 通过 teammcp 的 send_message / send_dm 工具与团队沟通\n- 收到消息后根据你的角色定义来响应\n`, 'utf-8');
          }
        } catch (e) { console.error(`[register] Directory creation failed: ${e.message}`); }
      }

      return json(res, { apiKey: agent.api_key, agent: { name: agent.name, role: agent.role } });
    }

    // ── GET /api/health (no auth required) ────────────
    if (method === 'GET' && path === '/api/health') {
      const onlineAgents = getOnlineAgents();
      const allAgents = getAllAgents();
      const uptimeMs = Date.now() - startedAt;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const hours = Math.floor(uptimeSec / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const seconds = uptimeSec % 60;

      return json(res, {
        status: 'ok',
        uptime: `${hours}h ${minutes}m ${seconds}s`,
        uptimeMs,
        agents: {
          total: allAgents.length,
          online: onlineAgents.length,
          onlineNames: onlineAgents,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // ── GET /api/setup-status (no auth — first-time setup detection) ──
    if (method === 'GET' && path === '/api/setup-status') {
      const allAgents = getAllAgents();
      return json(res, { agents_count: allAgents.length, needs_setup: allAgents.length === 0, server_version: '1.0.0' });
    }

    // ── All other endpoints require auth ──────────────
    if (path.startsWith('/api/') && path !== '/api/register' && path !== '/api/health' && path !== '/api/setup-status') {
      if (!requireAuth(req, res)) return;
    }

    // ── GET /api/wechat/status ──
    if (method === 'GET' && path === '/api/wechat/status') {
      const { getStatus } = await import('./wechat-bridge.mjs');
      return json(res, getStatus());
    }

    // ── POST /api/wechat/login (Chairman/CEO only) ──
    if (method === 'POST' && path === '/api/wechat/login') {
      if (req.agent.name !== 'Chairman' && req.agent.name !== 'CEO') {
        return json(res, { error: 'Only Chairman or CEO can manage WeChat connection' }, 403);
      }
      const { startLogin } = await import('./wechat-bridge.mjs');
      const result = await startLogin();
      return json(res, result);
    }

    // ── POST /api/wechat/disconnect (Chairman/CEO only) ──
    if (method === 'POST' && path === '/api/wechat/disconnect') {
      if (req.agent.name !== 'Chairman' && req.agent.name !== 'CEO') {
        return json(res, { error: 'Only Chairman or CEO can manage WeChat connection' }, 403);
      }
      const { stopPolling } = await import('./wechat-bridge.mjs');
      stopPolling();
      return json(res, { ok: true, status: 'disconnected' });
    }

    // ── POST /api/wechat/send-file (send local file to WeChat) ──
    if (method === 'POST' && path === '/api/wechat/send-file') {
      if (req.agent.name !== 'Chairman' && req.agent.name !== 'CEO') {
        return json(res, { error: 'Only Chairman or CEO can send files to WeChat' }, 403);
      }
      try {
        const body = await readBody(req);
        const { uploadAndSendFile, getStatus } = await import('./wechat-bridge.mjs');
        if (!getStatus().connected) return json(res, { error: 'WeChat not connected' }, 400);
        const filePath = body.file_path;
        if (!filePath || !existsSync(filePath)) return json(res, { error: 'File not found' }, 404);
        const fileData = readFileSync(filePath);
        const fileName = filePath.split(/[/\\]/).pop();
        await uploadAndSendFile(fileData, fileName, '', '');
        return json(res, { ok: true, fileName, size: fileData.length });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    // ── GET /api/me (returns current agent identity) ──
    if (method === 'GET' && path === '/api/me') {
      return json(res, { name: req.agent.name, role: req.agent.role, status: req.agent.status });
    }

    // ── POST /api/send ────────────────────────────────
    if (method === 'POST' && path === '/api/send') {
      const body = await readBody(req);
      if (!body.channel || !body.content) {
        return json(res, { error: 'channel and content are required' }, 400);
      }

      if (body.content.length > MAX_CONTENT_LENGTH) {
        return json(res, { error: `Content too long (max ${MAX_CONTENT_LENGTH} characters)` }, 400);
      }

      if (!checkRate(req.agent.name)) {
        return json(res, { error: 'Rate limit exceeded (10 msg/s)' }, 429);
      }

      // Auto-extract @mentions from text (supports names with dots like qwen3.6)
      // Only include names that correspond to registered agents
      const textMentions = (body.content.match(/@([\w.][\w.]*)/g) || []).map(m => m.slice(1)).filter(name => getAgentByName(name));
      if (textMentions.length > 0) {
        body.mentions = [...new Set([...(body.mentions || []), ...textMentions])];
      }

      // Server-side validation: strip source=dashboard from non-CEO agents
      if (body.metadata && typeof body.metadata === 'object' && body.metadata.source === 'dashboard') {
        if (req.agent.name !== 'Chairman' && req.agent.name !== 'CEO') {
          delete body.metadata.source;
          delete body.metadata.role;
        }
      }

      let channelId = body.channel;
      let channel;

      // DM shorthand: "dm:AgentName" (2 parts) vs full DM channel ID "dm:A:B" (3 parts)
      if (channelId.startsWith('dm:') && channelId.split(':').length === 2) {
        const recipient = channelId.slice(3);
        const recipientAgent = getAgentByName(recipient);
        if (!recipientAgent) return json(res, { error: `Agent "${recipient}" not found` }, 404);
        channel = getOrCreateDmChannel(req.agent.name, recipient);
        channelId = channel.id;
      } else if (channelId.startsWith('dm:') && channelId.split(':').length === 3) {
        // Full DM channel ID (dm:AgentA:AgentB) — look up directly
        channel = getChannel(channelId);
        if (!channel) {
          // Try to create via getOrCreateDmChannel
          const parts = channelId.split(':');
          channel = getOrCreateDmChannel(parts[1], parts[2]);
          channelId = channel.id;
        }
      } else {
        channel = getChannel(channelId);
        if (!channel) return json(res, { error: `Channel "${channelId}" not found` }, 404);
      }

      // Topic channel: sender must be a member
      if (channel.type === 'topic') {
        const members = getChannelMembers(channelId);
        if (!members.includes(req.agent.name)) {
          return json(res, { error: 'Not a member of this topic channel' }, 403);
        }
      }

      // Inherit wechat source from replied message (for reply chain tracking)
      if (body.replyTo) {
        try {
          const origMsg = getMessage(body.replyTo);
          if (origMsg) {
            const origMeta = typeof origMsg.metadata === 'string' ? JSON.parse(origMsg.metadata || '{}') : (origMsg.metadata || {});
            if (origMeta.source === 'wechat' || origMeta.source === 'wechat_reply') {
              if (!body.metadata) body.metadata = {};
              body.metadata.source = body.metadata.source || 'wechat_reply';
              body.metadata.context_token = body.metadata.context_token || origMeta.context_token;
              body.metadata.from_user_id = body.metadata.from_user_id || origMeta.from_user_id;
            }
          }
        } catch {}
      }

      const mentions = body.mentions || [];
      const msg = saveMessage(channelId, req.agent.name, body.content, mentions, body.replyTo, body.metadata);

      // ── Push per design doc section 7 ──────────────
      const event = {
        type: 'message',
        channel: channelId,
        from: req.agent.name,
        content: msg.content,
        mentions,
        id: msg.id,
        timestamp: msg.created_at,
        replyTo: msg.reply_to || null,
        metadata: body.metadata || null
      };

      // Always update sender's own read_status (so they don't get their own messages on reconnect)
      updateReadStatus(req.agent.name, channelId, msg.id);

      if (channel.type === 'dm') {
        // DM: push to the other party
        const parts = channelId.split(':');  // dm:agent1:agent2
        const other = parts[1] === req.agent.name ? parts[2] : parts[1];
        pushToAgent(other, event);
        // Update read_status for online recipient (delivered = read in SSE model)
        if (isOnline(other)) updateReadStatus(other, channelId, msg.id);

        // Forward DMs to Chairman → WeChat (only for wechat-sourced reply chains)
        const msgMeta = body.metadata || {};
        if (other === 'Chairman' && req.agent.name !== 'Chairman' && (msgMeta.source === 'wechat_reply' || msgMeta.source === 'wechat')) {
          try {
            const { sendToWeChat, uploadAndSendFile, getStatus } = await import('./wechat-bridge.mjs');
            if (getStatus().connected) {
              const prefix = `[TeamMCP DM] ${req.agent.name}`;
              const text = `${prefix}:\n${body.content.replace(/\*\*/g, '').slice(0, 2000)}`;
              sendToWeChat(text, '').catch(e => console.error('[wechat→] DM text failed:', e.message));
              // Send file attachments if any
              const meta = body.metadata || {};
              if (meta.attachments && Array.isArray(meta.attachments)) {
                for (const att of meta.attachments) {
                  if (att.file_id) {
                    try {
                      const fileMeta = getFile(att.file_id);
                      if (fileMeta) {
                        const filePath = join(__dirname, 'uploads', att.file_id);
                        if (existsSync(filePath)) {
                          const fileData = readFileSync(filePath);
                          uploadAndSendFile(fileData, fileMeta.original_name || 'file', '', '').catch(e => console.error('[wechat→] file send failed:', e.message));
                        }
                      }
                    } catch (e) { console.error('[wechat→] attachment error:', e.message); }
                  }
                }
              }
            }
          } catch (e) { console.error('[wechat] bridge import failed:', e.message); }
        }

      } else if (channel.type === 'group') {
        // Group: push to channel members except sender + always include Chairman (admin oversight)
        const groupMembers = ensureChairman(getChannelMembers(channelId).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(groupMembers, event);
        // Update read_status for online recipients to prevent duplicates on reconnect
        for (const a of groupMembers) {
          if (isOnline(a)) updateReadStatus(a, channelId, msg.id);
        }
        // Forward @Chairman mentions → WeChat (only for wechat-sourced messages)
        const groupMeta = body.metadata || {};
        if (body.mentions && body.mentions.includes('Chairman') && req.agent.name !== 'Chairman' && (groupMeta.source === 'wechat_reply' || groupMeta.source === 'wechat')) {
          try {
            const { sendToWeChat, getStatus } = await import('./wechat-bridge.mjs');
            if (getStatus().connected) {
              const prefix = `[${channelId}] ${req.agent.name}`;
              const text = `${prefix}:\n${body.content.replace(/\*\*/g, '').slice(0, 2000)}`;
              sendToWeChat(text, '').catch(e => console.error('[wechat→] mention text failed:', e.message));
            }
          } catch {}
        }

      } else if (channel.type === 'topic') {
        // Topic: push to all subscribers except sender + always include Chairman (admin oversight)
        const topicTargets = ensureChairman(getChannelMembers(channelId).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(topicTargets, event);
        // Update read_status for online recipients
        for (const a of topicTargets) {
          if (isOnline(a)) updateReadStatus(a, channelId, msg.id);
        }
      }

      // Notify CEO when mentioned/targeted agents are offline
      const offlineTargets = new Set();
      if (channel.type === 'dm') {
        const parts = channelId.split(':');
        const other = parts[1] === req.agent.name ? parts[2] : parts[1];
        if (!isOnline(other) && other !== 'CEO' && other !== 'Chairman') offlineTargets.add(other);
      } else if (body.mentions && Array.isArray(body.mentions)) {
        for (const m of body.mentions) {
          if (!isOnline(m) && m !== 'CEO' && m !== 'Chairman' && m !== req.agent.name) offlineTargets.add(m);
        }
      }
      // Send DM to Chairman (and CEO) for each offline target (debounced: 5 min)
      for (const target of offlineTargets) {
        const cacheKey = `offline_notify_${target}`;
        if (!offlineNotifyCache.has(cacheKey) || Date.now() - offlineNotifyCache.get(cacheKey) > 300_000) {
          offlineNotifyCache.set(cacheKey, Date.now());
          const notifyContent = `Agent ${target} 当前离线，有来自 ${req.agent.name} 的消息待处理。是否需要启动？`;
          // Notify Chairman
          const chairDm = getOrCreateDmChannel('System', 'Chairman');
          const chairMsg = saveMessage(chairDm.id, 'System', notifyContent, JSON.stringify(['Chairman']), null);
          pushToAgent('Chairman', { type: 'message', channel: chairDm.id, from: 'System', content: notifyContent, mentions: ['Chairman'], id: chairMsg.id, timestamp: chairMsg.created_at });
          // Also notify CEO
          const ceoDm = getOrCreateDmChannel('System', 'CEO');
          const ceoMsg = saveMessage(ceoDm.id, 'System', notifyContent, JSON.stringify(['CEO']), null);
          pushToAgent('CEO', { type: 'message', channel: ceoDm.id, from: 'System', content: notifyContent, mentions: ['CEO'], id: ceoMsg.id, timestamp: ceoMsg.created_at });
        }
      }

      return json(res, { id: msg.id, timestamp: msg.created_at });
    }

    // ── PUT /api/messages/:id (edit message) ──────────
    if (method === 'PUT' && path.startsWith('/api/messages/') && path.split('/').length === 4) {
      const msgId = path.split('/').pop();
      const msg = getMessage(msgId);
      if (!msg) return json(res, { error: 'Message not found' }, 404);
      if (msg.from_agent !== req.agent.name) return json(res, { error: 'Only the sender can edit this message' }, 403);
      if (msg.deleted) return json(res, { error: 'Cannot edit a deleted message' }, 400);

      const body = await readBody(req);
      if (!body.content) return json(res, { error: 'content is required' }, 400);

      const updated = editMessage(msgId, body.content);
      const channel = getChannel(msg.channel_id);

      // Push edit event to channel members
      const event = { type: 'message_edited', channel: msg.channel_id, id: msgId, content: updated.content, edited_at: updated.edited_at, from: msg.from_agent };
      if (channel.type === 'dm') {
        const parts = msg.channel_id.split(':');
        const other = parts[1] === req.agent.name ? parts[2] : parts[1];
        pushToAgent(other, event);
      } else if (channel.type === 'group') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      } else if (channel.type === 'topic') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      }

      return json(res, { id: updated.id, content: updated.content, edited_at: updated.edited_at });
    }

    // ── POST /api/messages/:id/ack (delivery confirmation) ──────
    if (method === 'POST' && path.match(/^\/api\/messages\/[^/]+\/ack$/) && path.split('/').length === 5) {
      const msgId = path.split('/')[3];
      ackMessage(msgId, req.agent.name);
      // Push ack event to all connections (for Dashboard display)
      const ackEvent = { type: 'message_acked', message_id: msgId, agent: req.agent.name, timestamp: new Date().toISOString() };
      // Push to Chairman for Dashboard
      pushToAgent('Chairman', ackEvent);
      return json(res, { ok: true, message_id: msgId, agent: req.agent.name });
    }

    // ── DELETE /api/messages/:id (soft delete) ──────
    if (method === 'DELETE' && path.startsWith('/api/messages/') && path.split('/').length === 4) {
      const msgId = path.split('/').pop();
      const msg = getMessage(msgId);
      if (!msg) return json(res, { error: 'Message not found' }, 404);
      if (msg.from_agent !== req.agent.name) return json(res, { error: 'Only the sender can delete this message' }, 403);
      if (msg.deleted) return json(res, { error: 'Message already deleted' }, 400);

      deleteMessage(msgId);
      const channel = getChannel(msg.channel_id);

      // Push delete event to channel members
      const event = { type: 'message_deleted', channel: msg.channel_id, id: msgId, from: msg.from_agent };
      if (channel.type === 'dm') {
        const parts = msg.channel_id.split(':');
        const other = parts[1] === req.agent.name ? parts[2] : parts[1];
        pushToAgent(other, event);
      } else if (channel.type === 'group') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      } else if (channel.type === 'topic') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      }

      return json(res, { id: msgId, deleted: true });
    }

    // ── GET /api/events (SSE) ─────────────────────────
    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');

      const agentName = req.agent.name;
      setAgentStatus(agentName, 'online');
      addConnection(agentName, res);
      broadcastStatus(agentName, 'online');
      publish('agent_online', { agent_id: agentName });

      // Missed messages on reconnect disabled — agents start fresh
      // const channels = getChannelsForAgent(agentName);
      // sendMissedMessages(agentName, channels.map(c => c.id));

      return; // Keep connection open
    }

    // ── GET /api/search ──────────────────────────────
    if (method === 'GET' && path === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q || !q.trim()) return json(res, { error: 'q (search query) is required' }, 400);

      const channel = url.searchParams.get('channel') || undefined;
      const from = url.searchParams.get('from') || undefined;
      const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
      const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 20 : rawLimit, 100));
      const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
      const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

      // DM privacy: if searching a specific DM channel, check membership
      if (channel && channel.startsWith('dm:')) {
        const parts = channel.split(':');
        if (!parts.includes(req.agent.name)) {
          return json(res, { error: 'Access denied to this DM channel' }, 403);
        }
      }

      let results, total;
      try {
        ({ results, total } = searchMessages(q.trim(), { channel, from, limit, offset }));
      } catch (e) {
        // FTS5 query error (e.g. malformed syntax that slipped through sanitization)
        return json(res, { error: 'Invalid search query', details: e.message }, 400);
      }

      // Filter out DM messages the requester is not part of
      const filtered = results.filter(r => {
        if (r.channel_id.startsWith('dm:')) {
          return r.channel_id.split(':').includes(req.agent.name);
        }
        return true;
      });

      return json(res, { results: filtered, total: filtered.length, query: q.trim() });
    }

    // ── GET /api/history ──────────────────────────────
    if (method === 'GET' && path === '/api/history') {
      const channel = url.searchParams.get('channel') || 'general';
      const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 50 : rawLimit, MAX_HISTORY_LIMIT));
      const before = url.searchParams.get('before') || undefined;

      const ch = getChannel(channel);
      if (!ch) return json(res, { error: `Channel "${channel}" not found` }, 404);

      // DM privacy check
      if (ch.type === 'dm') {
        const members = getChannelMembers(channel);
        if (!members.includes(req.agent.name)) {
          return json(res, { error: 'Access denied to this DM' }, 403);
        }
      }

      const result = getMessages(channel, limit, before);
      // Attach reactions to each message
      if (result.messages.length > 0) {
        const msgIds = result.messages.map(m => m.id);
        const reactionsMap = getReactionsForMessages(msgIds);
        for (const msg of result.messages) {
          msg.reactions = reactionsMap[msg.id] || [];
        }
      }
      // Content is stored raw — return as-is
      return json(res, result);
    }

    // ── GET /api/inbox ──────────────────────────────────
    if (method === 'GET' && path === '/api/inbox') {
      const rawDetailLimit = parseInt(url.searchParams.get('detail_limit') || '10', 10);
      const rawSummaryThreshold = parseInt(url.searchParams.get('summary_threshold') || '20', 10);
      const detailLimit = Math.max(1, Math.min(isNaN(rawDetailLimit) ? 10 : rawDetailLimit, 50));
      const summaryThreshold = Math.max(1, Math.min(isNaN(rawSummaryThreshold) ? 20 : rawSummaryThreshold, 200));

      const channels = getChannelsForAgent(req.agent.name)
        .filter(ch => ch.unread > 0)
        .map(ch => {
          const unreadCount = getUnreadCount(req.agent.name, ch.id);
          const ackId = getLastUnreadMessageId(req.agent.name, ch.id);

          if (!ackId || unreadCount === 0) return null;

          if (unreadCount <= summaryThreshold) {
            return {
              channel: ch.id,
              channel_type: ch.type,
              channel_name: ch.name,
              unread_count: unreadCount,
              delivery_mode: 'messages',
              ack_id: ackId,
              messages: getUnreadMessages(req.agent.name, ch.id)
                .slice(-detailLimit)
                .map(formatInboxMessage),
            };
          }

          const mentions = getUnreadMentions(req.agent.name, ch.id)
            .slice(-detailLimit)
            .map(formatInboxMessage);
          const recentMessages = getLastNMessages(ch.id, Math.min(detailLimit, 5))
            .map(formatInboxMessage);

          return {
            channel: ch.id,
            channel_type: ch.type,
            channel_name: ch.name,
            unread_count: unreadCount,
            delivery_mode: 'summary',
            ack_id: ackId,
            mentions,
            recent_messages: recentMessages,
            topic_summary: recentMessages
              .map(msg => `[${msg.from}] ${msg.content.split('\n')[0].slice(0, 100)}`)
              .join(' | '),
          };
        })
        .filter(Boolean);

      const stateChanges = req.agent.last_seen
        ? getStateChangesSince(req.agent.last_seen).map(change => ({
            project_id: change.project_id,
            field: change.field,
            old_value: change.old_value,
            new_value: change.new_value,
            changed_by: change.changed_by,
            timestamp: change.timestamp,
          }))
        : [];

      return json(res, {
        agent: req.agent.name,
        total_unread: channels.reduce((sum, ch) => sum + ch.unread_count, 0),
        channel_count: channels.length,
        channels,
        state_changes: stateChanges,
      });
    }

    // ── POST /api/inbox/ack ─────────────────────────────
    if (method === 'POST' && path === '/api/inbox/ack') {
      const body = await readBody(req);
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return json(res, { error: 'items[] is required' }, 400);
      }

      const acknowledgements = [];

      for (const item of body.items) {
        if (!item || !item.channel || !item.ack_id) {
          return json(res, { error: 'Each item must include channel and ack_id' }, 400);
        }

        const ch = getChannel(item.channel);
        if (!ch) {
          return json(res, { error: `Channel "${item.channel}" not found` }, 404);
        }

        if (ch.type === 'dm' || ch.type === 'topic') {
          const members = getChannelMembers(item.channel);
          if (!members.includes(req.agent.name)) {
            return json(res, { error: `Access denied to this ${ch.type}` }, 403);
          }
        }

        const msg = getMessage(item.ack_id);
        if (!msg || msg.channel_id !== item.channel) {
          return json(res, { error: `Invalid ack_id "${item.ack_id}" for channel "${item.channel}"` }, 400);
        }

        updateReadStatus(req.agent.name, item.channel, item.ack_id);
        acknowledgements.push({ channel: item.channel, ack_id: item.ack_id });
      }

      return json(res, {
        acknowledged: acknowledgements.length,
        items: acknowledgements,
      });
    }

    // ── POST /api/agent-output ────────────────────────
    // Accepts both direct POSTs and Claude Code HTTP hook payloads
    if (method === 'POST' && path === '/api/agent-output') {
      const body = await readBody(req);
      const agentName = req.agent.name;

      // Map Claude Code hook payload fields to our format
      const event = body.hook_event_name || body.event || 'unknown';
      const toolName = body.tool_name || null;
      const toolInput = body.tool_input || null;
      const rawResult = body.tool_result || body.output || null;
      const message = body.last_assistant_message || body.message || null;

      // Truncate tool_result to 500 chars (Audit requirement)
      const toolResult = typeof rawResult === 'string' && rawResult.length > 500
        ? rawResult.slice(0, 500) + '... [truncated]'
        : rawResult;

      pushAgentOutput(agentName, {
        event,
        tool_name: toolName,
        tool_input: toolInput,
        tool_result: toolResult,
        message: typeof message === 'string' && message.length > 500
          ? message.slice(0, 500) + '... [truncated]'
          : message,
        timestamp: new Date().toISOString()
      });
      return json(res, { ok: true });
    }

    // ── GET /api/agent-output/:name ─────────────────
    if (method === 'GET' && path.startsWith('/api/agent-output/') && path.split('/').length === 4) {
      const name = path.split('/')[3];
      return json(res, { agent: name, output: getAgentOutputBuffer(name) });
    }

    // ── POST /api/agent-error ──────────────────────────
    // Receives error/failure events from Claude Code hooks (StopFailure, rate limits, etc.)
    if (method === 'POST' && path === '/api/agent-error') {
      const body = await readBody(req);
      const agentName = req.agent.name;
      const reason = typeof body.stop_reason === 'string' ? body.stop_reason : (body.reason || 'unknown');
      const message = typeof body.message === 'string' && body.message.length > 500
        ? body.message.slice(0, 500) + '... [truncated]'
        : (body.message || '');

      pushAgentError(agentName, {
        reason,
        message,
        event: body.hook_event_name || body.event || 'StopFailure',
        timestamp: new Date().toISOString()
      });

      // Also broadcast as a system message to teammcp-dev for visibility
      if (reason === 'rate_limit' || reason.includes('rate') || reason.includes('limit')) {
        const content = `⚠️ Agent ${agentName} 触发 rate limit: ${message || reason}`;
        saveMessage('teammcp-dev', 'System', content, JSON.stringify([agentName]), null);
        const errorTargets = ['Chairman', 'CEO'].filter(n => n !== agentName);
        pushToAgents(errorTargets, { type: 'message', channel: 'teammcp-dev', from: 'System', content, mentions: [agentName], id: `sys_error_${agentName}_${Date.now()}`, timestamp: new Date().toISOString() });
      }

      return json(res, { ok: true });
    }

    // ── GET /api/agent-errors/:name ─────────────────
    if (method === 'GET' && path.startsWith('/api/agent-errors/') && path.split('/').length === 4) {
      const name = path.split('/')[3];
      return json(res, { agent: name, errors: getAgentErrorBuffer(name) });
    }

    // ── POST /api/schedules ─────────────────────────────
    if (method === 'POST' && path === '/api/schedules') {
      const body = await readBody(req);
      if (!body.channel || !body.content || !body.cron_expr) {
        return json(res, { error: 'channel, content, and cron_expr are required' }, 400);
      }
      try {
        const schedule = createSchedule(body.channel, body.content, body.cron_expr, req.agent.name);
        return json(res, { schedule }, 201);
      } catch (e) {
        return json(res, { error: e.message }, 400);
      }
    }

    // ── GET /api/schedules ──────────────────────────────
    if (method === 'GET' && path === '/api/schedules') {
      const schedules = getSchedules(req.agent.name);
      return json(res, { schedules });
    }

    // ── DELETE /api/schedules/:id ───────────────────────
    if (method === 'DELETE' && path.startsWith('/api/schedules/') && path.split('/').length === 4) {
      const id = path.split('/')[3];
      try {
        const result = deleteSchedule(id, req.agent.name);
        return json(res, result);
      } catch (e) {
        const status = e.message.includes('Not authorized') ? 403 : 404;
        return json(res, { error: e.message }, status);
      }
    }

    // ── POST /api/files — Upload file (base64 JSON body) ────
    if (method === 'POST' && path === '/api/files') {
      const body = await readBody(req);
      if (!body.name || !body.content) return json(res, { error: 'name and content (base64) are required' }, 400);

      const ext = body.name.split('.').pop()?.toLowerCase();
      const ALLOWED_EXTENSIONS = ['txt','md','json','js','ts','py','log','yaml','yml','jpg','png','gif','csv','html','css'];
      if (!ALLOWED_EXTENSIONS.includes(ext)) return json(res, { error: `File type .${ext} not allowed` }, 400);

      const buffer = Buffer.from(body.content, 'base64');
      if (buffer.length > 5 * 1024 * 1024) return json(res, { error: 'File too large (max 5MB)' }, 400);

      const crypto = await import('node:crypto');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      const FILE_MIME_MAP = { txt:'text/plain', md:'text/markdown', json:'application/json', js:'application/javascript', ts:'application/typescript', py:'text/x-python', log:'text/plain', yaml:'text/yaml', yml:'text/yaml', jpg:'image/jpeg', png:'image/png', gif:'image/gif', csv:'text/csv', html:'text/html', css:'text/css' };
      const mimeType = FILE_MIME_MAP[ext] || 'application/octet-stream';

      const fileId = `file_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const uploadsDir = join(__dirname, 'uploads');
      if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
      writeFileSync(join(uploadsDir, fileId), buffer);

      saveFile(fileId, body.name, mimeType, buffer.length, sha256, req.agent.name, body.channel || null);

      return json(res, { file_id: fileId, file_name: body.name, file_size: buffer.length, mime_type: mimeType, sha256, created_at: new Date().toISOString() }, 201);
    }

    // ── GET /api/files/:id — Download file ────────────────
    if (method === 'GET' && path.startsWith('/api/files/') && !path.includes('/meta') && path.split('/').length === 4) {
      const fileId = path.split('/')[3];
      const fileMeta = getFile(fileId);
      if (!fileMeta) return json(res, { error: 'File not found' }, 404);

      if (fileMeta.channel) {
        const members = getChannelMembers(fileMeta.channel);
        if (!members.includes(req.agent.name) && req.agent.name !== fileMeta.uploaded_by && req.agent.name !== 'Chairman') {
          return json(res, { error: 'Access denied' }, 403);
        }
      } else if (req.agent.name !== fileMeta.uploaded_by && req.agent.name !== 'Chairman') {
        return json(res, { error: 'Access denied' }, 403);
      }

      const filePath = join(__dirname, 'uploads', fileId);
      if (!existsSync(filePath)) return json(res, { error: 'File data not found' }, 404);

      const data = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': fileMeta.mime_type,
        'Content-Disposition': `attachment; filename="${fileMeta.original_name}"`,
        'Content-Length': data.length
      });
      res.end(data);
      return;
    }

    // ── GET /api/files/:id/meta — File metadata ──────────
    if (method === 'GET' && path.match(/^\/api\/files\/[^/]+\/meta$/) && path.split('/').length === 5) {
      const fileId = path.split('/')[3];
      const fileMeta = getFile(fileId);
      if (!fileMeta) return json(res, { error: 'File not found' }, 404);
      return json(res, fileMeta);
    }

    // ── GET /api/channels ─────────────────────────────
    if (method === 'GET' && path === '/api/channels') {
      const channels = getChannelsForAgent(req.agent.name);
      return json(res, channels);
    }

    // ── GET /api/agents ───────────────────────────────
    if (method === 'GET' && path === '/api/agents') {
      const agents = getAllAgents();
      return json(res, agents.map(a => ({
        name: a.name,
        role: a.role,
        status: isOnline(a.name) ? 'online' : a.status,
        lastSeen: a.last_seen,
        reports_to: a.reports_to || null,
        use_resume: a.use_resume !== 0
      })));
    }

    // ── PATCH /api/agents/:name ───────────────────────
    if (method === 'PATCH' && path.match(/^\/api\/agents\/[^/]+$/) && path.split('/').length === 4) {
      const name = decodeURIComponent(path.split('/')[3]);
      if (req.agent.name !== 'Chairman' && req.agent.name !== 'CEO' && req.agent.name !== 'HR') {
        return json(res, { error: 'Only Chairman, CEO or HR can modify agents' }, 403);
      }
      const body = await readBody(req);
      const target = getAgentByName(name);
      if (!target) return json(res, { error: 'Agent not found' }, 404);
      if (body.reports_to !== undefined) setReportsTo(name, body.reports_to);
      if (body.use_resume !== undefined) setUseResume(name, body.use_resume);
      return json(res, { ok: true, agent: name, reports_to: body.reports_to, use_resume: body.use_resume });
    }

    // ── POST /api/agents/:name/start ───────────────────
    if (method === 'POST' && path.match(/^\/api\/agents\/[^/]+\/start$/)) {
      const name = path.split('/')[3];
      if (!checkProcessPermission(req.agent)) {
        return json(res, { error: 'Only CEO or HR can start agents' }, 403);
      }
      const target = getAgentByName(name);
      if (!target) return json(res, { error: `Agent "${name}" not registered` }, 404);
      if (isOnline(name)) return json(res, { error: `Agent "${name}" is already online` }, 400);

      try {
        const { pid } = await startAgent(name);
        return json(res, { name, pid, status: 'starting' });
      } catch (err) {
        return json(res, { error: err.message }, err.statusCode || 500);
      }
    }

    // ── POST /api/agents/:name/stop ─────────────────────
    if (method === 'POST' && path.match(/^\/api\/agents\/[^/]+\/stop$/)) {
      const name = path.split('/')[3];
      if (!checkProcessPermission(req.agent)) {
        return json(res, { error: 'Only CEO or HR can stop agents' }, 403);
      }
      const target = getAgentByName(name);
      if (!target) return json(res, { error: `Agent "${name}" not registered` }, 404);

      try {
        const result = await stopAgent(name);
        return json(res, { name, status: 'stopped', ...result });
      } catch (err) {
        return json(res, { error: err.message }, err.statusCode || 500);
      }
    }

    // ── POST /api/agents/:name/screenshot ──────────────
    if (method === 'POST' && path.match(/^\/api\/agents\/[^/]+\/screenshot$/)) {
      const name = path.split('/')[3];
      if (!checkProcessPermission(req.agent)) {
        return json(res, { error: 'Only CEO or HR can screenshot agents' }, 403);
      }

      try {
        const { path: imgPath } = await screenshotAgent(name);
        return json(res, { name, screenshot: imgPath });
      } catch (err) {
        return json(res, { error: err.message }, err.statusCode || 500);
      }
    }

    // ── POST /api/agents/:name/sendkeys ─────────────────
    if (method === 'POST' && path.match(/^\/api\/agents\/[^/]+\/sendkeys$/)) {
      const name = path.split('/')[3];
      const body = await readBody(req);
      if (!body.keys) return json(res, { error: 'keys is required' }, 400);

      if (!checkProcessPermission(req.agent)) {
        return json(res, { error: 'Only CEO or HR can send keys to agents' }, 403);
      }

      try {
        const result = await sendKeysToAgent(name, body.keys);
        return json(res, { name, ...result });
      } catch (err) {
        return json(res, { error: err.message }, err.statusCode || 500);
      }
    }

    // ── POST /api/channels ────────────────────────────
    if (method === 'POST' && path === '/api/channels') {
      const body = await readBody(req);
      if (!body.id || !body.type) {
        return json(res, { error: 'id and type are required' }, 400);
      }
      if (!['group', 'dm', 'topic'].includes(body.type)) {
        return json(res, { error: 'type must be group, dm, or topic' }, 400);
      }

      const existing = getChannel(body.id);
      if (existing) return json(res, { error: `Channel "${body.id}" already exists` }, 409);

      const members = body.members || [];
      // Creator is always a member
      if (!members.includes(req.agent.name)) members.push(req.agent.name);

      const ch = createChannel(body.id, body.type, body.name, body.description, req.agent.name, members);
      return json(res, ch, 201);
    }

    // ── GET /api/channels/:id/members ─────────────────
    if (method === 'GET' && path.match(/^\/api\/channels\/[^/]+\/members$/) && path.split('/').length === 5) {
      const channelId = decodeURIComponent(path.split('/')[3]);
      const members = getChannelMembers(channelId);
      return json(res, { channel: channelId, members });
    }

    // ── POST /api/channels/:id/members (add member) ───
    if (method === 'POST' && path.match(/^\/api\/channels\/[^/]+\/members$/) && path.split('/').length === 5) {
      const channelId = decodeURIComponent(path.split('/')[3]);
      if (req.agent.name !== 'Chairman' && req.agent.name !== 'CEO') {
        return json(res, { error: 'Only Chairman or CEO can manage members' }, 403);
      }
      const body = await readBody(req);
      if (!body.agent_name) return json(res, { error: 'agent_name is required' }, 400);
      const agent = getAgentByName(body.agent_name);
      if (!agent) return json(res, { error: `Agent "${body.agent_name}" not found` }, 404);
      addChannelMember(channelId, body.agent_name);
      return json(res, { ok: true, channel: channelId, added: body.agent_name });
    }

    // ── DELETE /api/channels/:id/members/:name (remove member) ───
    if (method === 'DELETE' && path.match(/^\/api\/channels\/[^/]+\/members\/[^/]+$/) && path.split('/').length === 6) {
      const channelId = decodeURIComponent(path.split('/')[3]);
      const agentName = decodeURIComponent(path.split('/')[5]);
      if (req.agent.name !== 'Chairman' && req.agent.name !== 'CEO') {
        return json(res, { error: 'Only Chairman or CEO can manage members' }, 403);
      }
      removeChannelMember(channelId, agentName);
      return json(res, { ok: true, channel: channelId, removed: agentName });
    }

    // ── POST /api/tasks (create task) ─────────────────
    if (method === 'POST' && path === '/api/tasks') {
      const body = await readBody(req);

      // M1: Validate priority enum
      const VALID_PRIORITIES = ['urgent', 'high', 'medium', 'low'];
      if (body.priority && !VALID_PRIORITIES.includes(body.priority)) {
        return json(res, { error: `Invalid priority: must be one of ${VALID_PRIORITIES.join(', ')}` }, 400);
      }

      // M1: Validate status enum
      const VALID_STATUSES = ['todo', 'doing', 'done'];
      if (body.status && !VALID_STATUSES.includes(body.status)) {
        return json(res, { error: `Invalid status: must be one of ${VALID_STATUSES.join(', ')}` }, 400);
      }

      let title = body.title;
      let channel = body.channel || null;
      let source_msg = body.source_msg || null;

      if (source_msg) {
        const msg = getMessage(source_msg);
        if (!msg) return json(res, { error: 'Source message not found' }, 404);

        // M3: Check if message already has a task
        const existingMeta = msg.metadata ? JSON.parse(msg.metadata) : {};
        if (existingMeta.task_id) {
          const existingTask = getTask(existingMeta.task_id);
          if (existingTask) {
            return json(res, { error: `Message already has task: ${existingMeta.task_id}` }, 409);
          }
        }

        title = title || msg.content.slice(0, 100);
        channel = msg.channel_id;
      }

      if (!title) return json(res, { error: 'title is required (or provide source_msg)' }, 400);

      // Merge long-term task metadata
      if (body.task_type || body.checkin_interval || body.progress !== undefined || body.related_state) {
        let meta = {};
        try { meta = JSON.parse(body.metadata || '{}'); } catch {}
        if (body.task_type) meta.task_type = body.task_type;
        if (body.progress !== undefined) meta.progress = body.progress;
        if (body.checkin_interval) {
          meta.checkin_interval = body.checkin_interval;
          const next = new Date();
          if (body.checkin_interval === 'daily') next.setDate(next.getDate() + 1);
          else if (body.checkin_interval === 'weekly') next.setDate(next.getDate() + 7);
          else if (body.checkin_interval === 'biweekly') next.setDate(next.getDate() + 14);
          meta.next_checkin = next.toISOString();
        }
        if (body.related_state) meta.related_state = body.related_state;
        if (body.related_state_project) meta.related_state_project = body.related_state_project;
        if (body.target_value) meta.target_value = body.target_value;
        body.metadata = meta;  // Pass as object, createTask handles JSON.stringify
      }

      const task = createTask({
        title,
        status: body.status,
        priority: body.priority,
        creator: req.agent.name,
        assignee: body.assignee || null,
        source_msg,
        channel,
        parent_id: body.parent_id || null,
        result: body.result,
        due_date: body.due_date || null,
        labels: body.labels,
        metadata: body.metadata,
      });

      // Phase 3: SSE event + DM notification
      const taskEvent = { type: 'task_created', task: { id: task.id, title: task.title, status: task.status, priority: task.priority, creator: task.creator, assignee: task.assignee } };
      const taskCreateTargets = new Set();
      if (task.assignee && task.assignee !== req.agent.name) taskCreateTargets.add(task.assignee);
      pushToAgents([...taskCreateTargets], taskEvent);

      // DM notify assignee
      if (task.assignee && task.assignee !== req.agent.name) {
        const dmCh = getOrCreateDmChannel(req.agent.name, task.assignee);
        const dmContent = `📌 New task assigned to you: **${task.title}** [${task.priority}]\nTask ID: ${task.id}`;
        const dmMsg = saveMessage(dmCh.id, req.agent.name, dmContent, [task.assignee]);
        pushToAgent(task.assignee, { type: 'message', channel: dmCh.id, from: req.agent.name, content: dmContent, mentions: [task.assignee], id: dmMsg.id, timestamp: dmMsg.created_at });
        if (isOnline(task.assignee)) updateReadStatus(task.assignee, dmCh.id, dmMsg.id);
        updateReadStatus(req.agent.name, dmCh.id, dmMsg.id);
      }

      // M4: Wrap in { task: ... }
      return json(res, { task }, 201);
    }

    // ── GET /api/tasks (list tasks) ─────────────────────
    if (method === 'GET' && path === '/api/tasks') {
      const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
      const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 20 : rawLimit, 100));
      const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
      const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

      const result = getTasks({
        status: url.searchParams.get('status') || undefined,
        assignee: url.searchParams.get('assignee') || undefined,
        creator: url.searchParams.get('creator') || undefined,
        priority: url.searchParams.get('priority') || undefined,
        parent_id: url.searchParams.get('parent_id') || undefined,
        label: url.searchParams.get('label') || undefined,
        sort: url.searchParams.get('sort') || '-priority',
        limit,
        offset,
      });

      // Enrich tasks with progress info
      if (result.tasks) {
        for (const t of result.tasks) {
          let meta = {};
          try { meta = JSON.parse(t.metadata || '{}'); } catch {}
          if (meta.progress !== undefined) {
            t.progress = meta.progress;
          } else if (t.parent_id === null) {
            // Calculate auto_progress from children
            const children = getTasks({ parent_id: t.id, limit: 100 });
            if (children.tasks && children.tasks.length > 0) {
              const done = children.tasks.filter(c => c.status === 'done').length;
              t.progress = Math.round((done / children.tasks.length) * 100);
            }
          }
          if (meta.task_type) t.task_type = meta.task_type;
          if (meta.checkin_interval) t.checkin_interval = meta.checkin_interval;
        }
      }

      return json(res, result);
    }

    // ── GET /api/tasks/:id/history (task change history) ─
    if (method === 'GET' && path.match(/^\/api\/tasks\/[^/]+\/history$/)) {
      const taskId = path.split('/')[3];
      const task = getTask(taskId);
      if (!task) return json(res, { error: 'Task not found' }, 404);

      const history = getTaskHistory(taskId);
      return json(res, { history });
    }

    // ── GET /api/tasks/:id (task detail) ────────────────
    if (method === 'GET' && path.startsWith('/api/tasks/') && path.split('/').length === 4) {
      const taskId = path.split('/')[3];
      const task = getTaskWithChildren(taskId);
      if (!task) return json(res, { error: 'Task not found' }, 404);

      // Get sub-tasks
      const { tasks: sub_tasks } = getTasks({ parent_id: taskId, limit: 100 });

      // Get source message if exists
      let source_message = null;
      if (task.source_msg) {
        source_message = getMessage(task.source_msg) || null;
      }

      // Include progress from metadata
      let meta = {};
      try { meta = JSON.parse(task.metadata || '{}'); } catch {}
      const progress = meta.progress !== undefined ? meta.progress : task.auto_progress;

      return json(res, { task: { ...task, sub_tasks, source_message, progress } });
    }

    // ── PATCH /api/tasks/:id (update task) ──────────────
    if (method === 'PATCH' && path.startsWith('/api/tasks/') && path.split('/').length === 4) {
      const taskId = path.split('/')[3];
      const task = getTask(taskId);
      if (!task) return json(res, { error: 'Task not found' }, 404);

      const body = await readBody(req);
      const agentName = req.agent.name;
      const isManager = MANAGERS.includes(agentName);
      const isCreator = task.creator === agentName;
      const isAssignee = task.assignee === agentName;

      // M1: Validate enums
      if (body.priority && !['urgent', 'high', 'medium', 'low'].includes(body.priority)) {
        return json(res, { error: 'Invalid priority: must be urgent, high, medium, or low' }, 400);
      }
      if (body.status && !['todo', 'doing', 'done'].includes(body.status)) {
        return json(res, { error: 'Invalid status: must be todo, doing, or done' }, 400);
      }

      // M2: Field-level permission check (PRD 4.5)
      // - MANAGERS can modify all fields
      // - creator can modify: title, status, priority, assignee, due_date, labels (NOT result)
      // - assignee can modify: status, result
      if (!isManager) {
        if (!isCreator && !isAssignee) {
          return json(res, { error: 'Permission denied: only creator, assignee, or managers can update' }, 403);
        }
        const creatorFields = ['title', 'status', 'priority', 'assignee', 'due_date', 'labels', 'result', 'progress'];
        const assigneeFields = ['status', 'result', 'progress'];
        const requestedFields = Object.keys(body).filter(k => k !== 'comment');

        for (const field of requestedFields) {
          const creatorCan = isCreator && creatorFields.includes(field);
          const assigneeCan = isAssignee && assigneeFields.includes(field);
          if (!creatorCan && !assigneeCan) {
            return json(res, { error: `Permission denied: you cannot modify '${field}'` }, 403);
          }
        }
      }

      // Merge progress into metadata
      if (body.progress !== undefined) {
        let meta = {};
        try { meta = JSON.parse(task.metadata || '{}'); } catch {}
        meta.progress = body.progress;
        body.metadata = JSON.stringify(meta);
        delete body.progress;
      }

      const oldStatus = task.status;
      const oldAssignee = task.assignee;
      const result = updateTask(taskId, body, agentName);
      if (!result) return json(res, { error: 'Task not found' }, 404);
      const { task: updated, changeLog } = result;

      // M1: SSE event with changes and actor
      const taskEvent = { type: 'task_updated', task_id: updated.id, title: updated.title, changes: changeLog, actor: agentName };
      const taskUpdateTargets = new Set();
      if (updated.assignee && updated.assignee !== agentName) taskUpdateTargets.add(updated.assignee);
      if (updated.creator && updated.creator !== agentName) taskUpdateTargets.add(updated.creator);
      pushToAgents([...taskUpdateTargets], taskEvent);

      // Phase 3: DM notifications based on changes
      const notifyTargets = new Map(); // target → dmContent

      const statusIcons = { todo: '📋', doing: '🔨', done: '✅' };

      // Status → doing: notify creator
      if (body.status === 'doing' && oldStatus !== 'doing' && updated.creator !== agentName) {
        notifyTargets.set(updated.creator, `🔨 Task started: **${updated.title}**\nTask ID: ${updated.id}`);
      }

      // Status → done: notify creator + assignee
      if (body.status === 'done' && oldStatus !== 'done') {
        const doneMsg = `✅ Task completed: **${updated.title}**${updated.result ? `\nResult: ${updated.result}` : ''}\nTask ID: ${updated.id}`;
        if (updated.creator !== agentName) notifyTargets.set(updated.creator, doneMsg);
        if (updated.assignee && updated.assignee !== agentName) notifyTargets.set(updated.assignee, doneMsg);
      }

      // M2: Status → todo (reopen from done): notify assignee
      if (body.status === 'todo' && oldStatus === 'done' && updated.assignee && updated.assignee !== agentName) {
        notifyTargets.set(updated.assignee, `📋 Task reopened: **${updated.title}**\nTask ID: ${updated.id}`);
      }

      // Assignee changed: notify new assignee
      if (body.assignee && body.assignee !== oldAssignee && body.assignee !== agentName) {
        notifyTargets.set(body.assignee, `📌 Task reassigned to you: **${updated.title}** [${updated.priority}]\nTask ID: ${updated.id}`);
      }

      for (const [target, dmContent] of notifyTargets) {
        const dmCh = getOrCreateDmChannel(agentName, target);
        const dmMsg = saveMessage(dmCh.id, agentName, dmContent, [target]);
        pushToAgent(target, { type: 'message', channel: dmCh.id, from: agentName, content: dmContent, mentions: [target], id: dmMsg.id, timestamp: dmMsg.created_at });
        if (isOnline(target)) updateReadStatus(target, dmCh.id, dmMsg.id);
        updateReadStatus(agentName, dmCh.id, dmMsg.id);
      }

      // Task-State light linking: auto-update linked state when task is done
      if (updated.status === 'done' && oldStatus !== 'done') {
        try {
          const taskMeta = JSON.parse(updated.metadata || '{}');
          if (taskMeta.related_state && taskMeta.target_value) {
            const stateProjectId = taskMeta.related_state_project || 'default';
            setState(stateProjectId, taskMeta.related_state, taskMeta.target_value, agentName, `Auto-updated by task ${updated.id} completion`, { isApproval: true });
          }
        } catch {}
      }

      return json(res, { task: updated });
    }

    // ── DELETE /api/tasks/:id (soft delete task) ────────
    if (method === 'DELETE' && path.startsWith('/api/tasks/') && path.split('/').length === 4) {
      const taskId = path.split('/')[3];
      const task = getTask(taskId);
      if (!task) return json(res, { error: 'Task not found' }, 404);

      // Permission check: creator or MANAGERS
      const agentName = req.agent.name;
      if (task.creator !== agentName && !MANAGERS.includes(agentName)) {
        return json(res, { error: 'Permission denied: only creator or managers can delete' }, 403);
      }

      const result = deleteTask(taskId, agentName);
      if (!result) return json(res, { error: 'Task not found' }, 404);

      // Phase 3: SSE event
      const taskEvent = { type: 'task_deleted', task: { id: task.id, title: task.title } };
      const taskDeleteTargets = new Set();
      if (task.assignee && task.assignee !== agentName) taskDeleteTargets.add(task.assignee);
      if (task.creator && task.creator !== agentName) taskDeleteTargets.add(task.creator);
      pushToAgents([...taskDeleteTargets], taskEvent);

      return json(res, result);
    }

    // ── Audit API (restricted to AUDIT_ROLES) ──────────

    // GET /api/audit/state - Full state snapshot for all projects
    if (method === 'GET' && path === '/api/audit/state') {
      if (!AUDIT_ROLES.includes(req.agent.name)) {
        return json(res, { error: 'Audit access only' }, 403);
      }
      const projectId = url.searchParams.get('project_id');
      const result = auditGetAllState(projectId || undefined);
      return json(res, result);
    }

    // GET /api/audit/changelog - Full change log with filters
    if (method === 'GET' && path === '/api/audit/changelog') {
      if (!AUDIT_ROLES.includes(req.agent.name)) {
        return json(res, { error: 'Audit access only' }, 403);
      }
      const filters = {
        project_id: url.searchParams.get('project_id') || undefined,
        field: url.searchParams.get('field') || undefined,
        changed_by: url.searchParams.get('changed_by') || undefined,
        source: url.searchParams.get('source') || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: parseInt(url.searchParams.get('limit') || '100', 10) || 100,
        offset: parseInt(url.searchParams.get('offset') || '0', 10) || 0,
      };
      const result = auditGetChangeLog(filters);
      return json(res, result);
    }

    // GET /api/audit/reports - Get audit reports
    if (method === 'GET' && path === '/api/audit/reports') {
      if (!AUDIT_ROLES.includes(req.agent.name)) {
        return json(res, { error: 'Audit access only' }, 403);
      }
      const projectId = url.searchParams.get('project_id') || undefined;
      const reportType = url.searchParams.get('report_type') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '20', 10) || 20;
      const result = getAuditReports(projectId, reportType, limit);
      return json(res, result);
    }

    // POST /api/audit/reports - Generate audit report
    if (method === 'POST' && path === '/api/audit/reports') {
      if (!AUDIT_ROLES.includes(req.agent.name)) {
        return json(res, { error: 'Audit access only' }, 403);
      }
      const body = await readBody(req);
      if (!body.project_id || !body.report_type) {
        return json(res, { error: 'project_id and report_type are required' }, 400);
      }
      const validTypes = ['compliance', 'efficiency', 'anomaly'];
      if (!validTypes.includes(body.report_type)) {
        return json(res, { error: `Invalid report_type. Must be one of: ${validTypes.join(', ')}` }, 400);
      }

      let report;
      switch (body.report_type) {
        case 'compliance':
          report = auditGenerateComplianceReport(body.project_id);
          break;
        case 'efficiency':
          report = auditGenerateEfficiencyReport(body.project_id);
          break;
        case 'anomaly':
          report = auditGenerateAnomalyReport(body.project_id);
          break;
      }

      // Save the report
      const saved = saveAuditReport({
        project_id: body.project_id,
        report_type: body.report_type,
        content: report,
        generated_by: req.agent.name,
        visibility: report.visibility,
      });

      return json(res, { ...report, id: saved.id, generated_at: saved.generated_at });
    }

    // ── GET /api/reports/public ──────────────────────────
    // Public audit reports (visibility='all' only, any authenticated agent)
    if (method === 'GET' && path === '/api/reports/public') {
      const projectId = url.searchParams.get('project_id') || undefined;
      const reportType = url.searchParams.get('report_type') || undefined;
      const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
      const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 20 : rawLimit, 100));
      const result = getPublicAuditReports(projectId, reportType, limit);
      return json(res, result);
    }

    // ── POST /api/state/route ────────────────────────────
    // Coordination routing decision
    if (method === 'POST' && path === '/api/state/route') {
      const body = await readBody(req);
      if (!body.project_id || !body.task) {
        return json(res, { error: 'project_id and task are required' }, 400);
      }
      // Normalize affected_fields: accept both string[] and {field: string}[]
      if (body.task.affected_fields && Array.isArray(body.task.affected_fields)) {
        body.task.affected_fields = body.task.affected_fields.map(f =>
          typeof f === 'string' ? f : (f && f.field ? f.field : String(f))
        );
      }
      const result = routeTask(req.agent.name, body.project_id, body.task);
      return json(res, { routes: result, agent_id: req.agent.name, project_id: body.project_id });
    }

    // ── POST /api/state/conclude ─────────────────────────
    // Conclude discussion - batch write state with transaction
    if (method === 'POST' && path === '/api/state/conclude') {
      const body = await readBody(req);
      if (!body.project_id || !body.conclusions || !Array.isArray(body.conclusions)) {
        return json(res, { error: 'project_id and conclusions (array) are required' }, 400);
      }
      const result = concludeDiscussion(body.project_id, body.conclusions, req.agent.name);
      if (result.error) {
        return json(res, result, 400);
      }

      // Notify via Event Bus
      publish('state_changed', {
        project_id: body.project_id,
        type: 'discussion_concluded',
        fields: body.conclusions.map(c => c.field),
        decided_by: req.agent.name,
        subscribers: [], // Will be handled per-field by setState internally
      });

      // Queue notification for Chairman (for WeChat delivery)
      if (updated.status !== oldStatus && ['doing', 'done'].includes(updated.status)) {
        const statusText = { doing: '⏳ 开始执行', done: '✅ 已完成' };
        const notifContent = `📋 任务进度\n标题：${updated.title}\n状态：${statusText[updated.status]}`;
        try {
          const { saveNotification } = await import('./db.mjs');
          saveNotification(`notif_${crypto.randomUUID().slice(0, 12)}`, 'Chairman', 'wechat', notifContent, updated.id);
        } catch (e) {
          console.error('[task notif] Failed to create notification:', e.message);
        }
      }

      return json(res, result);
    }

    // ── GET /api/state ──────────────────────────────────
    if (method === 'GET' && path === '/api/state') {
      const projectId = url.searchParams.get('project_id');
      if (!projectId) return json(res, { error: 'project_id is required' }, 400);
      const field = url.searchParams.get('field') || undefined;
      const rawLimit = parseInt(url.searchParams.get('limit') || '100', 10);
      const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = isNaN(rawLimit) ? 100 : rawLimit;
      const offset = isNaN(rawOffset) ? 0 : rawOffset;
      const result = getState(projectId, field, limit, offset);
      return json(res, result || (field ? null : { items: [], total: 0 }));
    }

    // ── POST /api/state ─────────────────────────────────
    if (method === 'POST' && path === '/api/state') {
      const body = await readBody(req);
      if (!body.project_id || !body.field) {
        return json(res, { error: 'project_id and field are required' }, 400);
      }
      if (body.value === undefined) {
        return json(res, { error: 'value is required' }, 400);
      }
      // SEC-004: Independent input validation (before knowledge check)
      if (typeof body.field !== 'string' || body.field.length > 256 || !/^[a-zA-Z0-9_\-.:]+$/.test(body.field)) {
        return json(res, { error: 'Invalid field name: max 256 chars, alphanumeric/underscore/hyphen/dot/colon only' }, 400);
      }
      if (typeof body.project_id !== 'string' || body.project_id.length > 256 || !/^[a-zA-Z0-9_\-.:]+$/.test(body.project_id)) {
        return json(res, { error: 'Invalid project_id: max 256 chars, alphanumeric/underscore/hyphen/dot/colon only' }, 400);
      }

      const result = setState(
        body.project_id,
        body.field,
        body.value,
        req.agent.name,
        body.reason || '',
        {
          owner: body.owner,
          approval_required: body.approval_required,
          approver: body.approver, // Upper-level approver for approval_required fields
          subscribers: body.subscribers,
          expected_version: body.expected_version,
          isHumanOverride: false, // Only true for dashboard admin access
        }
      );

      // SSE notifications are now handled by the Event Bus (eventbus.mjs)
      if (result && result.error === 'knowledge_check_required') {
        return json(res, result, 428); // 428 Precondition Required
      }
      // SEC-003: Return proper HTTP status codes for permission errors
      if (result && result.error === 'admin_required') {
        return json(res, result, 403);
      }
      if (result && result.error === 'version_conflict') {
        return json(res, result, 409); // 409 Conflict
      }
      return json(res, result);
    }

    // ── GET /api/state/history ──────────────────────────
    if (method === 'GET' && path === '/api/state/history') {
      const projectId = url.searchParams.get('project_id');
      if (!projectId) return json(res, { error: 'project_id is required' }, 400);
      const field = url.searchParams.get('field') || undefined;
      const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 50 : rawLimit, 200));
      const result = getStateHistory(projectId, field, limit);
      return json(res, result);
    }

    // ── POST /api/state/subscribe ───────────────────────
    if (method === 'POST' && path === '/api/state/subscribe') {
      const body = await readBody(req);
      if (!body.project_id || !body.fields || !Array.isArray(body.fields)) {
        return json(res, { error: 'project_id and fields (array) are required' }, 400);
      }
      subscribeToState(body.project_id, body.fields, req.agent.name);
      return json(res, { success: true, subscribed: body.fields });
    }

    // ── GET /api/state/approvals ────────────────────────
    if (method === 'GET' && path === '/api/state/approvals') {
      const result = getPendingApprovals(req.agent.name);
      return json(res, result);
    }

    // ── POST /api/state/approvals/:id/resolve ───────────
    if (method === 'POST' && path.match(/^\/api\/state\/approvals\/[^/]+\/resolve$/)) {
      const approvalId = path.split('/')[4];
      const body = await readBody(req);
      if (body.approved === undefined) {
        return json(res, { error: 'approved (boolean) is required' }, 400);
      }
      const result = resolveApproval(approvalId, body.approved, req.agent.name, body.comment || '');
      if (!result) return json(res, { error: 'Approval not found or already resolved' }, 404);
      if (result.error === 'only_owner_can_resolve') return json(res, { error: `Only owner (${result.owner}) can resolve this approval` }, 403);

      // SSE notifications are now handled by the Event Bus (eventbus.mjs)
      return json(res, result);
    }

    // ── GET /api/state/knowledge-gaps ─────────────────────
    if (method === 'GET' && path === '/api/state/knowledge-gaps') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const projectId = params.get('project_id');
      const requestedAgent = params.get('agent_id');
      // Only AUDIT_ROLES can check other agents' gaps; otherwise forced to self
      const agentId = (requestedAgent && requestedAgent !== req.agent.name && AUDIT_ROLES.includes(req.agent.name))
        ? requestedAgent
        : req.agent.name;
      if (!projectId) return json(res, { error: 'project_id is required' }, 400);

      const report = checkKnowledgeGaps(agentId, projectId);

      // Publish knowledge_gap_detected event if gaps found
      if (report.has_gaps) {
        publish('knowledge_gap_detected', {
          agent_id: agentId,
          project_id: projectId,
          gaps_count: report.gaps.length,
          critical_gaps: report.critical_gaps,
        });
      }

      // Record last check timestamp in profile for enforcement
      const now = new Date().toISOString();
      const existingProfile = getAgentProfile(agentId);
      if (existingProfile) {
        const lkv = JSON.parse(existingProfile.last_known_versions || '{}');
        lkv._last_check_timestamp = now;
        upsertAgentProfile(agentId, {
          relevant_fields: JSON.parse(existingProfile.relevant_fields),
          critical_fields: JSON.parse(existingProfile.critical_fields),
          participating_projects: JSON.parse(existingProfile.participating_projects),
          participating_channels: JSON.parse(existingProfile.participating_channels),
          last_known_versions: lkv,
        });
      }

      return json(res, report);
    }

    // ── POST /api/state/knowledge-gaps/acknowledge ────────
    if (method === 'POST' && path === '/api/state/knowledge-gaps/acknowledge') {
      const body = await readBody(req);
      const projectId = body.project_id;
      // Acknowledge is strictly self-only — no agent can confirm gaps for another
      const agentId = req.agent.name;
      const fields = body.fields; // Array of field names to acknowledge
      if (!projectId) return json(res, { error: 'project_id is required' }, 400);
      if (!fields || !Array.isArray(fields) || fields.length === 0) {
        return json(res, { error: 'fields (array of field names) is required' }, 400);
      }

      const result = updateLastKnownVersions(agentId, projectId, fields);
      if (!result) return json(res, { error: 'Agent profile not found' }, 404);

      return json(res, { acknowledged: true, agent_id: agentId, fields, profile: result });
    }

    // ── GET /api/state/agent-profile ──────────────────────
    if (method === 'GET' && path === '/api/state/agent-profile') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const requestedAgent = params.get('agent_id');
      // Only AUDIT_ROLES can view other agents' profiles
      const agentId = (requestedAgent && requestedAgent !== req.agent.name && AUDIT_ROLES.includes(req.agent.name))
        ? requestedAgent
        : req.agent.name;
      const profile = getAgentProfile(agentId);
      if (!profile) return json(res, { error: 'Agent profile not found' }, 404);
      return json(res, profile);
    }

    // ── POST /api/state/agent-profile ─────────────────────
    if (method === 'POST' && path === '/api/state/agent-profile') {
      const body = await readBody(req);
      // Only STATE_ADMINS can modify other agents' profiles
      const requestedAgent = body.agent_id;
      const agentId = (requestedAgent && requestedAgent !== req.agent.name && STATE_ADMINS.includes(req.agent.name))
        ? requestedAgent
        : req.agent.name;
      const result = upsertAgentProfile(agentId, {
        relevant_fields: body.relevant_fields,
        critical_fields: body.critical_fields,
        participating_projects: body.participating_projects,
        participating_channels: body.participating_channels,
        last_known_versions: body.last_known_versions,
      });
      return json(res, result);
    }

    // ── POST /api/messages/:id/reactions (add reaction) ──
    const ALLOWED_REACTIONS = ['👍', '👎', '❤️', '😄', '🎉', '👀', '🤔', '✅'];
    if (method === 'POST' && path.match(/^\/api\/messages\/[^/]+\/reactions$/)) {
      const msgId = path.split('/')[3];
      const msg = getMessage(msgId);
      if (!msg) return json(res, { error: 'Message not found' }, 404);

      const body = await readBody(req);
      if (!body.emoji) return json(res, { error: 'emoji is required' }, 400);
      if (!ALLOWED_REACTIONS.includes(body.emoji)) return json(res, { error: `Invalid emoji. Allowed: ${ALLOWED_REACTIONS.join(' ')}` }, 400);

      addReaction(msgId, req.agent.name, body.emoji);
      const channel = getChannel(msg.channel_id);

      // Push SSE event
      const event = { type: 'reaction_added', message_id: msgId, channel: msg.channel_id, emoji: body.emoji, agent: req.agent.name };
      if (channel.type === 'dm') {
        const parts = msg.channel_id.split(':');
        const other = parts[1] === req.agent.name ? parts[2] : parts[1];
        pushToAgent(other, event);
      } else if (channel.type === 'group') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      } else if (channel.type === 'topic') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      }

      return json(res, { message_id: msgId, emoji: body.emoji, agent: req.agent.name });
    }

    // ── DELETE /api/messages/:id/reactions/:emoji (remove reaction) ──
    if (method === 'DELETE' && path.match(/^\/api\/messages\/[^/]+\/reactions\/[^/]+$/)) {
      const parts = path.split('/');
      const msgId = parts[3];
      const emoji = decodeURIComponent(parts[5]);
      const msg = getMessage(msgId);
      if (!msg) return json(res, { error: 'Message not found' }, 404);

      removeReaction(msgId, req.agent.name, emoji);
      const channel = getChannel(msg.channel_id);

      // Push SSE event
      const event = { type: 'reaction_removed', message_id: msgId, channel: msg.channel_id, emoji, agent: req.agent.name };
      if (channel.type === 'dm') {
        const dparts = msg.channel_id.split(':');
        const other = dparts[1] === req.agent.name ? dparts[2] : dparts[1];
        pushToAgent(other, event);
      } else if (channel.type === 'group') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      } else if (channel.type === 'topic') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      }

      return json(res, { message_id: msgId, emoji, removed: true });
    }

    // ── POST /api/messages/:id/pin (pin a message) ──────
    if (method === 'POST' && path.match(/^\/api\/messages\/[^/]+\/pin$/)) {
      const msgId = path.split('/')[3];
      const msg = getMessage(msgId);
      if (!msg) return json(res, { error: 'Message not found' }, 404);
      if (msg.deleted) return json(res, { error: 'Cannot pin a deleted message' }, 400);

      pinMessage(msgId, msg.channel_id, req.agent.name);
      const channel = getChannel(msg.channel_id);

      // Push SSE event
      const event = { type: 'message_pinned', message_id: msgId, channel: msg.channel_id, pinned_by: req.agent.name, from_agent: msg.from_agent, content: msg.content };
      if (channel.type === 'dm') {
        const parts = msg.channel_id.split(':');
        const other = parts[1] === req.agent.name ? parts[2] : parts[1];
        pushToAgent(other, event);
      } else if (channel.type === 'group') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      } else if (channel.type === 'topic') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      }

      return json(res, { message_id: msgId, pinned: true });
    }

    // ── DELETE /api/messages/:id/pin (unpin a message) ───
    if (method === 'DELETE' && path.match(/^\/api\/messages\/[^/]+\/pin$/)) {
      const msgId = path.split('/')[3];
      const msg = getMessage(msgId);
      if (!msg) return json(res, { error: 'Message not found' }, 404);

      if (!isPinned(msgId)) return json(res, { error: 'Message is not pinned' }, 400);

      unpinMessage(msgId);
      const channel = getChannel(msg.channel_id);

      // Push SSE event
      const event = { type: 'message_unpinned', message_id: msgId, channel: msg.channel_id, unpinned_by: req.agent.name };
      if (channel.type === 'dm') {
        const parts = msg.channel_id.split(':');
        const other = parts[1] === req.agent.name ? parts[2] : parts[1];
        pushToAgent(other, event);
      } else if (channel.type === 'group') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      } else if (channel.type === 'topic') {
        const targets = ensureChairman(getChannelMembers(msg.channel_id).filter(m => m !== req.agent.name), req.agent.name);
        pushToAgents(targets, event);
      }

      return json(res, { message_id: msgId, unpinned: true });
    }

    // ── GET /api/channels/:id/pins (get pinned messages) ─
    if (method === 'GET' && path.match(/^\/api\/channels\/[^/]+\/pins$/)) {
      const channelId = path.split('/')[3];
      const ch = getChannel(channelId);
      if (!ch) return json(res, { error: 'Channel not found' }, 404);

      const pins = getPinnedMessages(channelId);
      return json(res, { pins });
    }

    // ── 404 ───────────────────────────────────────────
    json(res, { error: 'Not found' }, 404);

  } catch (err) {
    if (err.statusCode === 413) {
      return json(res, { error: 'Request body too large (max 1MB)' }, 413);
    }
    if (err.statusCode === 400 && err.message.includes('UTF-8')) {
      return json(res, { error: err.message }, 400);
    }
    if (err instanceof SyntaxError) {
      return json(res, { error: 'Invalid JSON in request body' }, 400);
    }
    console.error('[router error]', err);
    json(res, { error: 'Internal server error' }, 500);
  }
}
