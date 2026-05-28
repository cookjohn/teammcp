<script setup>
import { ref, onMounted, onUnmounted, inject } from 'vue'

const props = defineProps({
  apiKey: { type: String, required: true }
})

const t = inject('t', (k) => k)

const status = ref('unknown')
const qrData = ref('')
const accountId = ref('')
const lastError = ref(null)
let pollTimer = null

function headers() {
  return {
    'Authorization': 'Bearer ' + props.apiKey,
    'Content-Type': 'application/json'
  }
}

function applyStatus(data) {
  status.value = data.status || 'disconnected'
  accountId.value = data.accountId || ''
  lastError.value = data.lastError || null
  // While scanning, the status poll also carries the QR (PNG data URL).
  // Keep qrData in sync so re-opening the panel mid-scan still shows it.
  if (data.status === 'scanning') {
    const qr = data.qr || data.qrcode || ''
    if (qr) qrData.value = qr
  } else if (data.status === 'connected' || data.status === 'disconnected') {
    qrData.value = ''
  }
}

async function init() {
  try {
    const res = await fetch('/api/wechat/status', { headers: headers() })
    if (res.ok) {
      applyStatus(await res.json())
    } else {
      status.value = 'disconnected'
    }
  } catch {
    status.value = 'unknown'
  }
}

async function startLogin() {
  try {
    status.value = 'scanning'
    const res = await fetch('/api/wechat/login', {
      method: 'POST',
      headers: headers()
    })
    if (res.ok) {
      const data = await res.json()
      qrData.value = data.qr || data.qrcode || data.qr_code || ''
      startPoll()
    } else {
      status.value = 'disconnected'
      qrData.value = ''
    }
  } catch {
    status.value = 'disconnected'
    qrData.value = ''
  }
}

function cancelLogin() {
  stopPoll()
  qrData.value = ''
  status.value = 'disconnected'
}

async function disconnect() {
  if (!confirm(t('wechat.confirmDisconnect'))) return
  try {
    await fetch('/api/wechat/disconnect', {
      method: 'POST',
      headers: headers()
    })
    status.value = 'disconnected'
  } catch {
    // ignore
  }
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/wechat/status', { headers: headers() })
      if (res.ok) {
        const data = await res.json()
        applyStatus(data)
        if (data.status === 'connected') {
          stopPoll()
          qrData.value = ''
        }
      }
    } catch {
      // keep polling
    }
  }, 3000)
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onMounted(() => {
  init()
})

onUnmounted(() => {
  stopPoll()
})
</script>

<template>
  <div class="wechat-panel">
    <div class="wechat-header">
      <span class="wechat-status-dot" :class="status"></span>
      <span class="wechat-status-text">
        {{ status === 'connected' ? t('wechat.connected')
         : status === 'scanning' ? t('wechat.scanning')
         : t('wechat.disconnected') }}
      </span>
      <span v-if="status === 'connected' && accountId" class="wechat-account">{{ accountId }}</span>
    </div>

    <!-- Last error (session timeout / poll error) -->
    <div v-if="lastError && status !== 'connected'" class="wechat-error">
      {{ lastError.message }}
    </div>

    <!-- QR code when scanning -->
    <div v-if="status === 'scanning' && qrData" class="wechat-qr">
      <img :src="qrData" alt="WeChat QR" class="wechat-qr-img" />
      <div class="wechat-qr-hint">{{ t('wechat.scanHint') }}</div>
    </div>

    <!-- Action buttons -->
    <div class="wechat-actions">
      <button
        v-if="status === 'disconnected' || status === 'unknown'"
        class="wechat-btn wechat-btn-bind"
        @click="startLogin"
      >
        {{ t('wechat.bind') }}
      </button>
      <button
        v-if="status === 'connected'"
        class="wechat-btn wechat-btn-disconnect"
        @click="disconnect"
      >
        {{ t('wechat.disconnect') }}
      </button>
      <button
        v-if="status === 'scanning'"
        class="wechat-btn wechat-btn-cancel"
        @click="cancelLogin"
      >
        {{ t('wechat.cancel') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.wechat-panel {
  padding: 12px;
}

.wechat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.wechat-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}

.wechat-status-dot.connected {
  background: var(--green);
}

.wechat-status-dot.scanning {
  background: var(--orange);
  animation: pulse 1.5s ease-in-out infinite;
}

.wechat-status-dot.disconnected,
.wechat-status-dot.unknown {
  background: var(--red);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.wechat-status-text {
  font-size: 13px;
  color: var(--text-dim);
}

.wechat-account {
  font-size: 11px;
  color: var(--text-muted);
  font-family: monospace;
  margin-left: auto;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wechat-error {
  font-size: 11px;
  color: var(--red);
  background: rgba(229, 83, 75, 0.08);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  margin-bottom: 10px;
  line-height: 1.4;
}

.wechat-qr {
  text-align: center;
  margin-bottom: 10px;
}

.wechat-qr-img {
  max-width: 180px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.wechat-qr-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
}

.wechat-actions {
  display: flex;
  gap: 8px;
}

.wechat-btn {
  flex: 1;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid var(--border);
}

.wechat-btn-bind {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.wechat-btn-bind:hover {
  background: var(--accent-dim);
}

.wechat-btn-disconnect {
  background: transparent;
  color: var(--red);
  border-color: var(--red);
}

.wechat-btn-disconnect:hover {
  background: rgba(229, 83, 75, 0.1);
}

.wechat-btn-cancel {
  background: transparent;
  color: var(--text-dim);
}

.wechat-btn-cancel:hover {
  background: var(--bg-msg);
}
</style>
