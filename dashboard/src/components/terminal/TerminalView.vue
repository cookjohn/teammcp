<script setup>
import { ref, onMounted, onUnmounted, watch, inject, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const api = inject('api')
const apiKey = inject('apiKey')
const t = inject('t')

const sessions = ref([])
const selectedAgent = ref(null)
const connected = ref(false)
const loading = ref(true)
const focused = ref(false)  // xterm input focus state — drives visual cue
const termRef = ref(null)

let term = null
let fitAddon = null
let ws = null
let resizeObserver = null
let reconnectTimer = null
let reconnectAttempts = 0
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000
let userClosed = false

// ── Dashboard token helpers ──────────────────────────────

async function getDashboardToken() {
  let token = sessionStorage.getItem('dashboardToken')
  if (token) return token
  const res = await api('/api/dashboard/token')
  token = res.token || res.dashboardToken || res.access_token || ''
  if (token) sessionStorage.setItem('dashboardToken', token)
  return token
}

async function dashboardFetch(path) {
  const token = await getDashboardToken()
  const headers = { 'Authorization': 'Bearer ' + apiKey.value, 'x-dashboard-token': token }
  const res = await fetch(path, { headers })
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`)
  return res.json()
}

// ── PTY session fetching ────────────────────────────────

async function fetchSessions() {
  loading.value = true
  try {
    const data = await dashboardFetch('/api/pty-sessions')
    sessions.value = data.sessions || []
    // Auto-select first session if none selected
    if (sessions.value.length > 0 && !selectedAgent.value) {
      selectAgent(sessions.value[0])
    }
    // Clear selection if agent no longer available
    if (selectedAgent.value && !sessions.value.includes(selectedAgent.value)) {
      disconnect()
      selectedAgent.value = null
      if (sessions.value.length > 0) selectAgent(sessions.value[0])
    }
  } catch (e) {
    console.error('[TerminalView] Failed to fetch sessions:', e)
    sessions.value = []
  } finally {
    loading.value = false
  }
}

// ── Terminal / WebSocket ─────────────────────────────────

// Detach all handlers from a WS and close it. Without detaching first, the
// dying socket's `onclose` would still fire scheduleReconnect() and race
// against the new connect() — looks like "reconnects every second".
function teardownWs(sock) {
  if (!sock) return
  try {
    sock.onopen = null
    sock.onmessage = null
    sock.onerror = null
    sock.onclose = null
  } catch {}
  try { sock.close() } catch {}
}

function disconnect() {
  userClosed = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  teardownWs(ws); ws = null
  connected.value = false
}

function scheduleReconnect() {
  if (userClosed || !selectedAgent.value) return
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS)
  reconnectAttempts++
  if (term) term.write(`\r\n[reconnecting in ${Math.round(delay/1000)}s...]\r\n`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function connect() {
  // Cancel pending reconnect + tear down any existing socket WITHOUT
  // triggering its onclose (which would re-arm scheduleReconnect and race
  // the new socket we're about to create).
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  teardownWs(ws); ws = null
  userClosed = false
  if (!selectedAgent.value || !term) return

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${proto}//${location.host}/ws/terminal?agent=${encodeURIComponent(selectedAgent.value)}`
  ws = new WebSocket(wsUrl)
  // Server emits raw PTY bytes as binary frames; ask for ArrayBuffer so
  // xterm.write can consume Uint8Array directly. xterm's internal
  // streaming TextDecoder handles multi-byte UTF-8 split across frames,
  // which `e.data` as a String cannot.
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    connected.value = true
    reconnectAttempts = 0
    sendResize()
    term.write('\r\n[connected]\r\n')
    // Auto-focus so the user can type immediately on connect. Without
    // this they have to click the terminal area first — which is the
    // single biggest source of "I can't type into the terminal" reports.
    try { term.focus() } catch {}
  }
  ws.onmessage = (e) => {
    if (!term) return
    if (e.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(e.data))
    } else {
      // Fallback for stray text frames (shouldn't happen with the
      // updated server, but harmless).
      term.write(e.data)
    }
  }
  ws.onclose = () => {
    connected.value = false
    if (term) term.write('\r\n[disconnected]\r\n')
    scheduleReconnect()
  }
  ws.onerror = () => {
    connected.value = false
    if (term) term.write('\r\n[connection error]\r\n')
    // onclose fires after onerror — scheduleReconnect runs there.
  }
}

function sendResize() {
  if (!ws || ws.readyState !== 1 || !term) return
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
}

async function selectAgent(name) {
  if (selectedAgent.value === name && connected.value) return
  selectedAgent.value = name
  if (term) {
    term.clear()
    // Re-fit to ensure cols/rows are correct for the container
    if (fitAddon) {
      await nextTick()
      fitAddon.fit()
    }
  }
  await nextTick()
  connect()
}

// ── Lifecycle ────────────────────────────────────────────

onMounted(async () => {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
    theme: {
      background: '#1a1a2e',
      foreground: '#e1e3eb',
      cursor: '#5b7ff5',
      selectionBackground: '#3d5bd9',
      black: '#1a1d2e',
      red: '#e5534b',
      green: '#3dd68c',
      yellow: '#c9b44a',
      blue: '#5b7ff5',
      magenta: '#b48ead',
      cyan: '#96b5b4',
      white: '#e1e3eb',
    }
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  term.onData((data) => {
    if (ws && ws.readyState === 1) ws.send(data)
  })

  // Open terminal DOM element BEFORE fetching sessions, so that
  // fitAddon.fit() runs before any connect/sendResize call.
  await nextTick()
  if (termRef.value) {
    term.open(termRef.value)
    fitAddon.fit()
    resizeObserver = new ResizeObserver(() => {
      if (fitAddon && term) {
        fitAddon.fit()
        sendResize()
      }
    })
    resizeObserver.observe(termRef.value)
    // xterm.js 6.0 does NOT expose term.onFocus / term.onBlur (calling
    // them throws TypeError and aborts onMounted, leaving loading=true
    // forever — the "Loading..." stuck bug). Hook the hidden textarea
    // xterm uses to capture keys, which fires standard DOM focus/blur.
    const textarea = termRef.value.querySelector('textarea.xterm-helper-textarea')
    if (textarea) {
      textarea.addEventListener('focus', () => { focused.value = true })
      textarea.addEventListener('blur',  () => { focused.value = false })
    }
  }

  await fetchSessions()

  // Refresh sessions every 10s
  const pollTimer = setInterval(fetchSessions, 10000)
  // Store for cleanup
  term._pollTimer = pollTimer
})

onUnmounted(() => {
  userClosed = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  teardownWs(ws); ws = null
  if (term) {
    if (term._pollTimer) clearInterval(term._pollTimer)
    term.dispose()
  }
  if (resizeObserver) resizeObserver.disconnect()
})
</script>

<template>
  <div class="terminal-view">
    <!-- Tab bar -->
    <div class="terminal-header">
      <div class="terminal-tabs">
        <button
          v-for="name in sessions"
          :key="name"
          class="terminal-tab"
          :class="{ active: selectedAgent === name }"
          @click="selectAgent(name)"
        >{{ name }}</button>
        <span v-if="loading && sessions.length === 0" class="terminal-label">{{ t('terminal.loading') }}</span>
        <span v-if="!loading && sessions.length === 0" class="terminal-label">{{ t('terminal.noSessions') }}</span>
      </div>
      <span class="terminal-status" :class="{ online: connected }">
        {{ connected ? t('terminal.connected') : t('terminal.disconnected') }}
      </span>
      <span v-if="connected" class="terminal-input-indicator" :class="{ focused }" :title="focused ? t('terminal.keyboardEnabled') : t('terminal.clickToType')">
        <span class="dot"></span>
        {{ focused ? t('terminal.typing') : t('terminal.clickHint') }}
      </span>
      <button v-if="selectedAgent && !connected" class="terminal-reconnect" @click="connect">{{ t('terminal.reconnect') }}</button>
    </div>
    <!-- Terminal area. Click-to-focus so users don't have to hit the
         cursor area exactly — clicking anywhere inside gives focus. -->
    <div
      ref="termRef"
      class="terminal-xterm"
      :class="{ focused, connected }"
      @click="() => term && term.focus()"
    ></div>
  </div>
</template>

<style scoped>
.terminal-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}
.terminal-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.terminal-tabs {
  display: flex;
  gap: 4px;
  flex: 1;
  overflow-x: auto;
}
.terminal-tab {
  padding: 3px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.terminal-tab:hover { background: var(--bg-msg-hover); }
.terminal-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.terminal-label {
  font-size: 12px;
  color: var(--text-muted);
}
.terminal-status {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}
.terminal-status.online { color: var(--green); }

.terminal-input-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  white-space: nowrap;
  cursor: default;
  transition: all 0.15s;
}
.terminal-input-indicator .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-muted);
  transition: all 0.15s;
}
.terminal-input-indicator.focused {
  color: var(--green);
  border-color: var(--green);
  background: rgba(61, 214, 140, 0.08);
}
.terminal-input-indicator.focused .dot {
  background: var(--green);
  box-shadow: 0 0 4px var(--green);
}

.terminal-reconnect {
  padding: 3px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
}
.terminal-reconnect:hover { background: var(--bg-msg-hover); }
.terminal-xterm {
  flex: 1;
  min-height: 0;
  padding: 4px;
  border: 2px solid transparent;
  transition: border-color 0.15s, box-shadow 0.15s;
  cursor: text;
}
.terminal-xterm.connected:not(.focused) {
  border-color: var(--border);
}
.terminal-xterm.focused {
  border-color: var(--green);
  box-shadow: inset 0 0 0 1px rgba(61, 214, 140, 0.25);
}
</style>
