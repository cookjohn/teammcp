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
const termRef = ref(null)

let term = null
let fitAddon = null
let ws = null
let resizeObserver = null

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

function disconnect() {
  if (ws) { ws.close(); ws = null }
  connected.value = false
}

function connect() {
  disconnect()
  if (!selectedAgent.value || !term) return

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${proto}//${location.host}/ws/terminal?agent=${encodeURIComponent(selectedAgent.value)}`
  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    connected.value = true
    term.write('\r\n[connected]\r\n')
  }
  ws.onmessage = (e) => { if (term) term.write(e.data) }
  ws.onclose = () => {
    connected.value = false
    if (term) term.write('\r\n[disconnected]\r\n')
  }
  ws.onerror = () => {
    connected.value = false
    if (term) term.write('\r\n[connection error]\r\n')
  }
}

function sendResize() {
  if (!ws || ws.readyState !== 1 || !term) return
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
}

async function selectAgent(name) {
  if (selectedAgent.value === name && connected.value) return
  selectedAgent.value = name
  if (term) term.clear()
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

  await fetchSessions()

  // Open terminal DOM element after sessions load
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
  }

  // Refresh sessions every 10s
  const pollTimer = setInterval(fetchSessions, 10000)
  // Store for cleanup
  term._pollTimer = pollTimer
})

onUnmounted(() => {
  if (ws) ws.close()
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
        <span v-if="loading && sessions.length === 0" class="terminal-label">Loading...</span>
        <span v-if="!loading && sessions.length === 0" class="terminal-label">No terminal sessions</span>
      </div>
      <span class="terminal-status" :class="{ online: connected }">
        {{ connected ? 'Connected' : 'Disconnected' }}
      </span>
      <button v-if="selectedAgent && !connected" class="terminal-reconnect" @click="connect">Reconnect</button>
    </div>
    <!-- Terminal area -->
    <div ref="termRef" class="terminal-xterm"></div>
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
}
</style>
