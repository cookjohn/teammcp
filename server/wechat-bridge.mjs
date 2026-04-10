/**
 * WeChat iLink Bot Bridge — integrated into TeamMCP server
 * Receives WeChat messages → saves to TeamMCP as Chairman
 * TeamMCP messages to Chairman → forwards to WeChat
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const CHANNEL_VERSION = '1.0.2';

// State
let session = null; // { token, baseUrl, accountId, userId }
let getUpdatesBuf = '';
let polling = false;
let loginInProgress = false;
let loginQRData = null; // { qrcode, qrcode_img_content }

// Callbacks (set by init)
let onMessageReceived = null; // (text, fromUser, contextToken) => void
const contextTokens = new Map();
let lastFromUserId = ''; // Most recent WeChat sender

// --- HTTP helpers ---

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token, body) {
  const headers = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(JSON.stringify(body), 'utf-8'));
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function apiGet(baseUrl, path) {
  const url = `${baseUrl.replace(/\/$/, '')}/${path}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function apiPost(baseUrl, endpoint, body, token, timeoutMs = 15000) {
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
  const payload = { ...body, base_info: { channel_version: CHANNEL_VERSION } };
  const bodyStr = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(token, payload),
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return null;
    throw err;
  }
}

export async function extractText(msg) {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    if (item.type === 3 && item.voice_item?.text) return `[语音] ${item.voice_item.text}`;
    if (item.type === 2) {
      const img = item.image_item || {};
      const cdnUrl = img.media?.full_url || img.cdn_url || '';
      const aesKeyHex = img.aeskey || '';
      const aesKeyB64 = img.media?.aes_key || img.aes_key || '';
      // Prefer hex key, fallback to base64
      const aesKey = aesKeyHex ? { hex: aesKeyHex } : (aesKeyB64 ? { b64: aesKeyB64 } : null);
      if (cdnUrl && aesKey) {
        const media = await downloadWechatMedia(cdnUrl, aesKey, 'image.jpg');
        if (media) return `[图片 file_id:${media.fileId}]`;
      }
      return '[图片]';
    }
    if (item.type === 4) {
      const fileName = item.file_item?.file_name ?? '';
      const fi = item.file_item || {};
      console.log('[wechat-bridge] file_item raw:', JSON.stringify(fi));
      const cdnUrl = fi.media?.full_url || fi.cdn_url || '';
      const aesKeyHex = fi.aeskey || '';
      const aesKeyB64 = fi.media?.aes_key || fi.aes_key || '';
      const aesKey = aesKeyHex ? { hex: aesKeyHex } : (aesKeyB64 ? { b64: aesKeyB64 } : null);
      if (cdnUrl && aesKey) {
        const media = await downloadWechatMedia(cdnUrl, aesKey, fileName);
        if (media) return `[文件 ${fileName} file_id:${media.fileId}]`;
      }
      return `[文件] ${fileName}`;
    }
    if (item.type === 5) {
      const vi = item.video_item || {};
      console.log('[wechat-bridge] video_item raw:', JSON.stringify(vi));
      const cdnUrl = vi.media?.full_url || vi.cdn_url || '';
      const aesKeyHex = vi.aeskey || '';
      const aesKeyB64 = vi.media?.aes_key || vi.aes_key || '';
      const aesKey = aesKeyHex ? { hex: aesKeyHex } : (aesKeyB64 ? { b64: aesKeyB64 } : null);
      if (cdnUrl && aesKey) {
        const media = await downloadWechatMedia(cdnUrl, aesKey, 'video.mp4');
        if (media) return `[视频 file_id:${media.fileId}]`;
      }
      return '[视频]';
    }
  }
  return null;
}

async function downloadWechatMedia(cdnUrl, aesKey, fileName) {
  try {
    // Download encrypted data from CDN
    const res = await fetch(cdnUrl);
    if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
    const encrypted = Buffer.from(await res.arrayBuffer());

    // Decrypt with AES-128-ECB (aesKey can be { hex: '...' } or { b64: '...' })
    // Some keys are base64-encoded hex strings (b64 → hex string → binary)
    let key;
    if (aesKey.hex) {
      key = Buffer.from(aesKey.hex, 'hex');
    } else {
      const raw = Buffer.from(aesKey.b64 || aesKey, 'base64');
      // Check if decoded result is a hex string (all chars 0-9a-f and length is even)
      const rawStr = raw.toString('utf8');
      if (raw.length > 16 && /^[0-9a-f]+$/i.test(rawStr) && rawStr.length % 2 === 0) {
        key = Buffer.from(rawStr, 'hex'); // hex string → binary
      } else {
        key = raw;
      }
    }
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    // Save to uploads directory
    const { join } = await import('node:path');
    const { mkdirSync, writeFileSync: writeFile } = await import('node:fs');
    const uploadsDir = join(import.meta.dirname || '.', 'uploads');
    try { mkdirSync(uploadsDir, { recursive: true }); } catch {}

    const fileId = `file_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const ext = fileName ? fileName.split('.').pop() : 'bin';
    const filePath = join(uploadsDir, fileId);
    writeFile(filePath, decrypted);

    const sha256 = crypto.createHash('sha256').update(decrypted).digest('hex');
    // Determine MIME type from extension
    const MIME_MAP = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', mp4:'video/mp4', bin:'application/octet-stream' };
    const mimeType = MIME_MAP[ext] || 'application/octet-stream';
    // Register in DB
    try {
      const { saveFile } = await import('./db.mjs');
      saveFile(fileId, fileName || `${fileId}.${ext}`, mimeType, decrypted.length, sha256, 'wechat', null);
    } catch (e) { console.error('[wechat] DB saveFile failed:', e.message); }
    console.log(`[wechat] Downloaded media: ${fileId} (${decrypted.length} bytes)`);

    return { fileId, size: decrypted.length, sha256, path: filePath };
  } catch (e) {
    console.error(`[wechat] Media download failed: ${e.message}`);
    return null;
  }
}

/**
 * Upload file to WeChat CDN and send via sendmessage.
 * Supports image (media_type 1), video (2), and file (3).
 */
export async function uploadAndSendFile(fileBuffer, fileName, toUserId, contextToken) {
  if (!session?.token) throw new Error('WeChat not connected');
  const targetUser = toUserId || lastFromUserId || '';
  // Resolve context token (may be { token, ts } object or plain string)
  const ctEntry = contextToken ? { token: contextToken, ts: Date.now() } : (contextTokens.get(targetUser) || contextTokens.get('_last'));
  if (!ctEntry) throw new Error('No context_token available');
  const ct = typeof ctEntry === 'string' ? ctEntry : ctEntry.token;
  if (!ct) throw new Error('No context_token available');

  // Determine media type from extension
  const ext = (fileName || '').split('.').pop().toLowerCase();
  const mediaType = /^(jpg|jpeg|png|gif|bmp|webp)$/.test(ext) ? 1
    : /^(mp4|avi|mov|wmv|mkv)$/.test(ext) ? 2 : 3;

  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');
  const aesKeyB64 = Buffer.from(aesKeyHex, 'utf-8').toString('base64');
  const filekey = crypto.randomBytes(16).toString('hex');
  const rawSize = fileBuffer.length;
  const rawFileMd5 = crypto.createHash('md5').update(fileBuffer).digest('hex');

  const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);

  // getUploadUrl
  const uploadResp = await apiPost(session.baseUrl, 'ilink/bot/getuploadurl', {
    filekey, media_type: mediaType, to_user_id: targetUser,
    rawsize: rawSize, rawfilemd5: rawFileMd5, filesize: encrypted.length,
    no_need_thumb: true, aeskey: aesKeyHex,
  }, session.token);
  console.log('[wechat→] getUploadUrl resp:', JSON.stringify(uploadResp)?.slice(0, 100));
  if (!uploadResp?.upload_param) throw new Error('getUploadUrl failed: ' + JSON.stringify(uploadResp));

  // POST to CDN
  const cdnBase = 'https://novac2c.cdn.weixin.qq.com/c2c';
  const cdnUrl = uploadResp.upload_full_url || `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  const cdnRes = await fetch(cdnUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted });
  const downloadParam = cdnRes.headers.get('x-encrypted-param') || '';
  console.log('[wechat→] CDN status:', cdnRes.status, 'downloadParam:', downloadParam?.slice(0, 40));
  if (cdnRes.status !== 200 || !downloadParam) throw new Error(`CDN upload failed: ${cdnRes.status}`);

  // Build item based on media type
  const cdnMedia = { encrypt_query_param: downloadParam, aes_key: aesKeyB64, encrypt_type: 1 };
  let item;
  if (mediaType === 1) {
    item = { type: 2, image_item: { media: cdnMedia, mid_size: encrypted.length } };
  } else if (mediaType === 2) {
    item = { type: 5, video_item: { media: cdnMedia, file_size: encrypted.length } };
  } else {
    item = { type: 4, file_item: { media: cdnMedia, file_name: fileName, len: String(rawSize) } };
  }

  const sendPayload = {
    msg: {
      from_user_id: '', to_user_id: targetUser,
      client_id: `teammcp-${crypto.randomUUID()}`,
      message_type: 2, message_state: 2, context_token: ct,
      item_list: [item],
    },
  };
  console.log('[wechat→] sendmessage full:', JSON.stringify({ to: sendPayload.msg.to_user_id, ct: sendPayload.msg.context_token?.slice(0, 30), item_type: item.type, token: session.token?.slice(0, 20) }));
  console.log('[wechat→] sendmessage item:', JSON.stringify(item));
  const sendResp = await apiPost(session.baseUrl, 'ilink/bot/sendmessage', sendPayload, session.token);
  console.log('[wechat→] sendmessage resp:', JSON.stringify(sendResp));
  console.log(`[wechat→] file sent: ${fileName} (type:${mediaType})`);
}

// --- Token management ---

const TOKEN_FILE = join(process.env.TEAMMCP_HOME || join((await import('node:os')).homedir(), '.teammcp'), 'wechat-token.json');

function loadSession() {
  if (existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
      session = data;
      getUpdatesBuf = data.getUpdatesBuf || '';
      lastFromUserId = data.lastFromUserId || '';
      if (data.contextTokens) {
        for (const [k, v] of Object.entries(data.contextTokens)) contextTokens.set(k, v);
      }
      console.log(`[wechat] Token loaded (Bot: ${session.accountId || 'unknown'}, contextTokens: ${contextTokens.size})`);
      return true;
    } catch {}
  }
  return false;
}

function saveSession() {
  const ctMap = Object.fromEntries(contextTokens);
  const data = { ...session, getUpdatesBuf, lastFromUserId, contextTokens: ctMap, savedAt: new Date().toISOString() };
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
  try { chmodSync(TOKEN_FILE, 0o600); } catch {}
}

// --- Login ---

export async function startLogin() {
  if (loginInProgress) return { status: 'already_in_progress' };
  loginInProgress = true;
  try {
    const qrResp = await apiGet(DEFAULT_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
    loginQRData = {
      qrcode: qrResp.qrcode,
      qrcode_img_content: qrResp.qrcode_img_content,
    };
    console.log('[wechat] QR code generated, waiting for scan...');

    // Start polling for scan status in background
    pollLoginStatus(qrResp.qrcode);

    return { status: 'qr_generated', qrcode_img_content: qrResp.qrcode_img_content };
  } catch (e) {
    loginInProgress = false;
    throw e;
  }
}

async function pollLoginStatus(qrcode) {
  const deadline = Date.now() + 5 * 60000;
  while (Date.now() < deadline && loginInProgress) {
    try {
      const statusResp = await apiGet(DEFAULT_BASE_URL, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
      if (statusResp.status === 'confirmed') {
        session = {
          token: statusResp.bot_token,
          baseUrl: statusResp.baseurl || DEFAULT_BASE_URL,
          accountId: statusResp.ilink_bot_id,
          userId: statusResp.ilink_user_id,
        };
        saveSession();
        loginInProgress = false;
        loginQRData = null;
        console.log(`[wechat] Login successful (Bot: ${session.accountId})`);
        startPolling(); // Auto-start message polling
        return;
      }
      if (statusResp.status === 'expired') {
        console.log('[wechat] QR code expired');
        loginInProgress = false;
        loginQRData = null;
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  loginInProgress = false;
  loginQRData = null;
}

// --- Message polling ---

export function startPolling() {
  if (polling || !session?.token) return;
  polling = true;
  console.log('[wechat] Message polling started');
  pollLoop();
}

async function pollLoop() {
  while (polling) {
    try {
      const resp = await apiPost(session.baseUrl, 'ilink/bot/getupdates', { get_updates_buf: getUpdatesBuf }, session.token, 42000);
      if (!resp) continue; // timeout
      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        saveSession();
      }
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== 1) continue; // Only user messages
        const text = await extractText(msg);
        if (!text) {
          console.log(`[wechat] Skipped message: no extractable text. Items: ${JSON.stringify((msg.item_list || []).map(i => ({ type: i.type })))}`);
          continue;
        }
        const fromUser = msg.from_user_id || '';
        const contextToken = msg.context_token || '';
        if (fromUser && contextToken) {
          const tokenEntry = { token: contextToken, ts: Date.now() };
          contextTokens.set(fromUser, tokenEntry);
          contextTokens.set('_last', tokenEntry);
          lastFromUserId = fromUser;
        }

        // Auto-reply "收到" to keep 24h window alive
        try {
          await apiPost(session.baseUrl, 'ilink/bot/sendmessage', {
            msg: {
              from_user_id: '', to_user_id: fromUser,
              client_id: `ack-${crypto.randomUUID()}`,
              message_type: 2, message_state: 2,
              context_token: contextToken,
              item_list: [{ type: 1, text_item: { text: '收到' } }],
            },
          }, session.token);
        } catch {}

        console.log(`[wechat←] ${text.slice(0, 60)}`);

        // Keyword: "进度" returns doing tasks summary
        if (text === '进度' || text === '任务进度') {
          try {
            const { getDoingTasks, getPendingNotifications } = await import('./db.mjs');
            const doingTasks = getDoingTasks();
            const pending = getPendingNotifications('Chairman', 'wechat');
            let reply = '';
            if (doingTasks.length > 0) {
              reply += `🔨 进行中的任务 (${doingTasks.length})：\n`;
              for (const t of doingTasks) {
                reply += `• ${t.title}${t.assignee ? ` [${t.assignee}]` : ''}\n`;
              }
            } else {
              reply += '当前没有进行中的任务。\n';
            }
            if (pending.length > 0) {
              reply += `\n📬 ${pending.length} 条离线通知待查看`;
            }
            await sendToWeChat(reply.trim(), fromUser, contextToken);
            continue; // Don't forward to TeamMCP
          } catch (e) {
            console.error('[wechat] keyword query failed:', e.message);
          }
        }

        // ── Approval reply parsing ──
        // Keywords: 批准/同意/yes/approve → allow; 拒绝/no/reject/deny → deny
        {
          const trimmed = text.trim();
          const approveWords = ['批准', '同意', 'yes', 'approve'];
          const denyWords = ['拒绝', 'no', 'reject', 'deny'];
          let approved = null;
          let shortCode = null;

          // Match patterns: "批准 a3f7", "Y a3f7", "拒绝 a3f7 原因", "批准" (no code)
          for (const w of approveWords) {
            const re = new RegExp(`^${w}\\s+([a-f0-9]{4})`, 'i');
            const m = trimmed.match(re);
            if (m) { approved = true; shortCode = m[1].toLowerCase(); break; }
            if (trimmed.toLowerCase() === w.toLowerCase()) { approved = true; break; }
          }
          if (approved === null) {
            for (const w of denyWords) {
              const re = new RegExp(`^${w}\\s+([a-f0-9]{4})`, 'i');
              const m = trimmed.match(re);
              if (m) { approved = false; shortCode = m[1].toLowerCase(); break; }
              if (trimmed.toLowerCase() === w.toLowerCase()) { approved = false; break; }
            }
          }

          if (approved !== null) {
            try {
              const { getPendingApprovals, resolveApproval } = await import('./db.mjs');
              const pending = getPendingApprovals('CEO'); // TODO: support per-approver
              let targetApproval = null;

              if (shortCode) {
                // Explicit short code — find matching approval
                targetApproval = pending.find(a => a.approval_id.endsWith(shortCode));
              } else if (pending.length === 1) {
                // No code but only one pending — auto-match
                targetApproval = pending[0];
              } else if (pending.length === 0) {
                await sendToWeChat('当前没有待审批的请求。', fromUser, contextToken);
                continue;
              } else {
                // Multiple pending, no code — list them
                let listMsg = `当前有 ${pending.length} 条待审批，请带短码回复：\n`;
                for (const a of pending) {
                  const sc = a.approval_id.slice(-4);
                  const pv = (() => { try { return JSON.parse(a.proposed_value || '{}'); } catch { return {}; } })();
                  listMsg += `• #${sc} ${pv.tool_name || a.field}\n`;
                }
                await sendToWeChat(listMsg.trim(), fromUser, contextToken);
                continue;
              }

              if (!targetApproval) {
                await sendToWeChat(`未找到短码 #${shortCode} 对应的待审批请求。`, fromUser, contextToken);
                continue;
              }

              // Extract reject comment if any
              const comment = approved ? '' : (trimmed.replace(/^\S+\s+[a-f0-9]{4}\s*/i, '') || '');

              const result = resolveApproval(targetApproval.approval_id, approved, 'Chairman', comment);
              if (result) {
                const statusText = approved ? '已批准' : '已拒绝';
                const pv = (() => { try { return JSON.parse(targetApproval.proposed_value || '{}'); } catch { return {}; } })();
                const toolName = pv.tool_name || targetApproval.field;
                await sendToWeChat(`${statusText}: ${toolName}`, fromUser, contextToken);
                console.log(`[wechat] Approval ${statusText}: ${targetApproval.approval_id}`);
              } else {
                await sendToWeChat('审批处理失败，可能已被处理。', fromUser, contextToken);
              }
              continue; // Don't forward to TeamMCP
            } catch (e) {
              console.error('[wechat] approval reply error:', e.message);
            }
          }
        }

        if (onMessageReceived) onMessageReceived(text, fromUser, contextToken);
      }
      // Deliver pending notifications to WeChat
      try {
        const { getPendingNotifications, markNotificationDelivered } = await import('./db.mjs');
        const pending = getPendingNotifications('Chairman', 'wechat');
        if (pending.length > 0) {
          // Merge notifications for same task
          const merged = new Map();
          for (const n of pending) {
            const key = n.task_id || n.id;
            merged.set(key, n); // Keep latest for each task
          }
          for (const [, notif] of merged) {
            try {
              await sendToWeChat(notif.content, '');
              markNotificationDelivered(notif.id);
            } catch (e) {
              console.error(`[wechat] notification delivery failed: ${e.message}`);
              break; // Stop on first failure (likely token issue)
            }
          }
          // Mark all delivered (including merged/skipped ones)
          for (const n of pending) {
            if (!merged.has(n.task_id || n.id) || merged.get(n.task_id || n.id).id !== n.id) {
              markNotificationDelivered(n.id);
            }
          }
          if (merged.size > 0) console.log(`[wechat] Delivered ${merged.size} pending notification(s)`);
        }
      } catch {}
    } catch (e) {
      if (e.message?.includes('session timeout') || e.message?.includes('-14')) {
        console.error('[wechat] Session expired. Please re-login via Dashboard.');
        polling = false;
        session = null;
        return;
      }
      console.error(`[wechat] Poll error: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// --- Send to WeChat ---

const CONTEXT_TOKEN_MAX_AGE_MS = 23 * 60 * 60_000; // 23h (buffer before 24h expiry)

export async function sendToWeChat(text, toUserId, contextToken) {
  if (!session?.token) throw new Error('WeChat not connected');
  const targetUser = toUserId || lastFromUserId || '';
  // Resolve context token (may be { token, ts } object or plain string)
  let ctEntry = contextToken ? { token: contextToken, ts: Date.now() } : (contextTokens.get(targetUser) || contextTokens.get('_last'));
  if (!ctEntry) throw new Error('No context_token available');
  const ct = typeof ctEntry === 'string' ? ctEntry : ctEntry.token;
  // Check 24h expiry
  if (ctEntry.ts && (Date.now() - ctEntry.ts) > CONTEXT_TOKEN_MAX_AGE_MS) {
    console.warn(`[wechat] context_token expired (${Math.round((Date.now() - ctEntry.ts) / 3600000)}h old). Need new WeChat message to refresh.`);
    throw new Error('context_token expired (24h window). Send a message from WeChat to refresh.');
  }
  if (!ct) throw new Error('No context_token available');
  const clientId = `teammcp-${crypto.randomUUID()}`;
  await apiPost(session.baseUrl, 'ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: targetUser,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: ct,
      item_list: [{ type: 1, text_item: { text } }],
    },
  }, session.token);
  console.log(`[wechat→] ${text.slice(0, 60)}`);
}

// --- Status ---

export function getStatus() {
  return {
    connected: !!session?.token && polling,
    polling,
    loginInProgress,
    qrcode: loginQRData?.qrcode_img_content || null,
    accountId: session?.accountId || null,
    baseUrl: session?.baseUrl || null,
  };
}

export function stopPolling() {
  polling = false;
}

// Alias for backward compatibility
export const uploadAndSendImage = uploadAndSendFile;

// --- Init ---

export function init(messageCallback) {
  onMessageReceived = messageCallback;
  if (loadSession()) {
    startPolling();
  }
}
