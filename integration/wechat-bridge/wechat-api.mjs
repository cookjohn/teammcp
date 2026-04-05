import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';

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

export function extractText(msg) {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    if (item.type === 3 && item.voice_item?.text) return `[语音] ${item.voice_item.text}`;
    if (item.type === 2) return '[图片]';
    if (item.type === 4) return `[文件] ${item.file_item?.file_name ?? ''}`;
    if (item.type === 5) return '[视频]';
  }
  return '[空消息]';
}

export class WeChatAPI {
  constructor(tokenPath = '.weixin-token.json') {
    this.tokenPath = tokenPath;
    this.token = null;
    this.baseUrl = DEFAULT_BASE_URL;
    this.getUpdatesBuf = ''; // Cursor for long-polling
    this.loadToken();
  }

  loadToken() {
    if (existsSync(this.tokenPath)) {
      try {
        const data = JSON.parse(readFileSync(this.tokenPath, 'utf-8'));
        this.token = data.token;
        if (data.baseUrl) this.baseUrl = data.baseUrl;
        if (data.getUpdatesBuf) this.getUpdatesBuf = data.getUpdatesBuf;
      } catch {}
    }
  }

  saveToken(token, baseUrl) {
    this.token = token;
    if (baseUrl) this.baseUrl = baseUrl;
    writeFileSync(this.tokenPath, JSON.stringify({
      token,
      baseUrl: baseUrl || this.baseUrl,
      saved_at: new Date().toISOString()
    }), { mode: 0o600 });
  }

  saveCursor() {
    // Persist cursor so we don't re-receive old messages on restart
    if (existsSync(this.tokenPath)) {
      try {
        const data = JSON.parse(readFileSync(this.tokenPath, 'utf-8'));
        data.getUpdatesBuf = this.getUpdatesBuf;
        writeFileSync(this.tokenPath, JSON.stringify(data), { mode: 0o600 });
      } catch {}
    }
  }

  async getLoginQRCode() {
    const res = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
    return res.json();
  }

  async checkQRCodeStatus(qrcode) {
    const res = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
    return res.json();
  }

  async getUpdates() {
    const body = {
      get_updates_buf: this.getUpdatesBuf,
      base_info: { channel_version: CHANNEL_VERSION }
    };
    try {
      const res = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: buildHeaders(this.token, body),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(42000), // 38s server timeout + 4s buffer
      });
      if (res.status === 401) throw new Error('TOKEN_EXPIRED');
      const data = await res.json();
      // Update cursor
      if (data?.get_updates_buf) {
        this.getUpdatesBuf = data.get_updates_buf;
        this.saveCursor();
      }
      const msgs = data?.msgs ?? [];
      if (msgs.length > 0) console.log(`[wechat-api] ${msgs.length} message(s) received`);
      return { msgs, raw: data };
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        return { msgs: [], raw: null }; // Normal timeout, no messages
      }
      throw e;
    }
  }

  async sendMessage(toUserId, text, contextToken) {
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `bridge-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken || '',
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const res = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: buildHeaders(this.token, body),
      body: JSON.stringify(body),
    });
    return res.json();
  }
}
