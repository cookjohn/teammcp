#!/usr/bin/env node
import { WeChatAPI, extractText } from './wechat-api.mjs';
import qrcode from 'qrcode-terminal';

// Config from environment
const TEAMMCP_URL = process.env.TEAMMCP_URL || 'http://localhost:3100';
const TEAMMCP_KEY = process.env.TEAMMCP_KEY;
const WECHAT_TOKEN_PATH = process.env.WECHAT_TOKEN_PATH || '.weixin-token.json';

if (!TEAMMCP_KEY) {
  console.error('ERROR: TEAMMCP_KEY environment variable required (Chairman token)');
  process.exit(1);
}

const wechat = new WeChatAPI(WECHAT_TOKEN_PATH);

// --- Login flow ---
if (process.argv.includes('--login')) {
  console.log('Starting WeChat login...');
  try {
    const qr = await wechat.getLoginQRCode();
    if (!qr.qrcode) { console.error('Failed to get QR code:', qr); process.exit(1); }
    const qrImgUrl = qr.qrcode_img_content || qr.qrcode_url || qr.qrcode;
    console.log('\nScan this QR code with WeChat:\n');
    qrcode.generate(qrImgUrl, { small: true });
    console.log(`\nOr open in browser: ${qrImgUrl}\n`);

    // Poll for scan status
    let loginSuccess = false;
    let attempts = 0;
    while (attempts < 120) {
      await new Promise(r => setTimeout(r, 2000));
      const status = await wechat.checkQRCodeStatus(qr.qrcode);
      if (status.status === 'confirmed' || status.bot_token) {
        wechat.saveToken(status.bot_token, status.baseurl);
        console.log('\nLogin successful! Starting bridge...\n');
        loginSuccess = true;
        break;
      }
      if (status.status === 'expired') {
        console.error('QR code expired. Please retry.');
        process.exit(1);
      }
      attempts++;
      process.stdout.write('.');
    }
    if (!loginSuccess) {
      console.error('\nLogin timeout.');
      process.exit(1);
    }
  } catch (e) {
    console.error('Login failed:', e.message);
    process.exit(1);
  }
}

// --- Bridge mode ---
if (!wechat.token) {
  console.error('No WeChat token. Run with --login first.');
  process.exit(1);
}

console.log(`[bridge] Starting WeChat ↔ TeamMCP bridge`);
console.log(`[bridge] TeamMCP: ${TEAMMCP_URL}`);
console.log(`[bridge] WeChat API: ${wechat.baseUrl}`);
console.log(`[bridge] Token: ${wechat.token ? wechat.token.slice(0, 10) + '...' : 'NONE'}`);

// Store context tokens: fromUserId → latest contextToken
const contextTokens = new Map();

// WeChat → TeamMCP: long-polling loop
async function pollWeChat() {
  console.log('[bridge] WeChat polling started');
  while (true) {
    try {
      const result = await wechat.getUpdates();
      if (result.msgs && result.msgs.length > 0) {
        for (const msg of result.msgs) {
          const text = extractText(msg);
          const fromUser = msg.from_user_id || '';
          const contextToken = msg.context_token || '';

          if (!text || text === '[空消息]') continue;

          // Save context token for reply (by user + as last sender)
          if (fromUser && contextToken) {
            contextTokens.set(fromUser, contextToken);
            contextTokens.set('_last', contextToken);
          }

          console.log(`[wechat→teammcp] ${fromUser}: ${text.slice(0, 50)}...`);

          // Send to TeamMCP as Chairman
          try {
            await fetch(`${TEAMMCP_URL}/api/send`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${TEAMMCP_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                channel: 'general',
                content: text,
                metadata: {
                  source: 'wechat',
                  context_token: contextToken,
                  from_user_id: fromUser,
                },
              }),
            });
          } catch (e) {
            console.error('[bridge] TeamMCP send failed:', e.message);
          }
        }
      }
    } catch (e) {
      if (e.message === 'TOKEN_EXPIRED') {
        console.error('[bridge] WeChat token expired. Run with --login to re-authenticate.');
        process.exit(1);
      }
      console.error('[bridge] Poll error:', e.message);
      await new Promise(r => setTimeout(r, 3000)); // Retry after 3s
    }
  }
}

// TeamMCP → WeChat: SSE subscription
async function subscribeTeamMCP() {
  console.log('[bridge] TeamMCP SSE subscription started');
  while (true) {
    try {
      const res = await fetch(`${TEAMMCP_URL}/api/events`, {
        headers: { 'Authorization': `Bearer ${TEAMMCP_KEY}` },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));

            // Only forward: DMs to Chairman + @Chairman mentions
            if (event.type !== 'message') continue;
            const isDm = (event.channel || '').startsWith('dm:');
            const isMentioned = event.mentions && event.mentions.includes('Chairman');
            if (!isDm && !isMentioned) continue;

            // Don't echo back our own messages
            if (event.from === 'Chairman') continue;

            // Strip markdown formatting for WeChat
            let content = (event.content || '').replace(/\*\*/g, '').replace(/```[\s\S]*?```/g, '[code]').slice(0, 2000);
            const prefix = isDm ? `[DM] ${event.from}` : `[${event.channel}] ${event.from}`;
            const fullText = `${prefix}:\n${content}`;

            // Get context token: prefer metadata, fallback to stored token by from_user_id
            const metaFromUser = event.metadata?.from_user_id || '';
            const contextToken = event.metadata?.context_token
              || (metaFromUser && contextTokens.get(metaFromUser))
              || contextTokens.get('_last') // fallback to most recent sender
              || '';

            if (contextToken) {
              console.log(`[teammcp→wechat] ${prefix}: ${content.slice(0, 50)}...`);
              await wechat.sendMessage('', fullText, contextToken);
            } else {
              console.warn('[bridge] No context_token available, cannot send to WeChat');
            }
          } catch {}
        }
      }
    } catch (e) {
      console.error('[bridge] SSE error:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Run both loops concurrently
pollWeChat();
subscribeTeamMCP();
