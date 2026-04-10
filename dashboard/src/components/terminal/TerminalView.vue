<script setup>
import { ref, onMounted, onUnmounted, watch, inject } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const props = defineProps({
  agent: { type: String, required: true }
})

const t = inject('t')
const termRef = ref(null)
const connected = ref(false)
let term = null
let fitAddon = null
let ws = null
let resizeObserver = null

function connect() {
  if (ws) ws.close()

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${proto}//${location.host}/ws/terminal?agent=${encodeURIComponent(props.agent)}`
  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    connected.value = true
    if (term) term.write('\r\n[connected]\r\n')
  }

  ws.onmessage = (e) => {
    if (term) term.write(e.data)
  }

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

onMounted(() => {
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
  term.open(termRef.value)
  fitAddon.fit()

  term.onData((data) => {
    if (ws && ws.readyState === 1) ws.send(data)
  })

  // Auto-resize
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon && term) {
      fitAddon.fit()
      sendResize()
    }
  })
  resizeObserver.observe(termRef.value)

  connect()
})

onUnmounted(() => {
  if (ws) ws.close()
  if (term) term.dispose()
  if (resizeObserver) resizeObserver.disconnect()
})

watch(() => props.agent, () => {
  if (term) term.clear()
  connect()
})
</script>

<template>
  <div class="terminal-view">
    <div class="terminal-header">
      <span class="terminal-label">Terminal: {{ agent }}</span>
      <span class="terminal-status" :class="{ online: connected }">{{ connected ? 'Connected' : 'Disconnected' }}</span>
      <button v-if="!connected" class="terminal-reconnect" @click="connect">Reconnect</button>
    </div>
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
  padding: 8px 14px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.terminal-label {
  font-size: 13px;
  font-weight: 600;
}
.terminal-status {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
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
