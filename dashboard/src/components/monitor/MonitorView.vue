<script setup>
import { ref, inject, computed, onMounted, onUnmounted } from 'vue'
import { useMonitorStore } from '../../stores/monitor'
import { useAgentsStore } from '../../stores/agents'
import { formatTime, agentColor } from '../../utils/format'

const api = inject('api')
const monitorStore = useMonitorStore(api)
const agentsStore = useAgentsStore(api)

const windowOptions = [
  { value: '15m', label: '15 min' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
]
const selectedWindow = ref('1h')
const refreshTimer = ref(null)

// ── Actions ───────────────────────────────────────────────
async function loadAll() {
  await Promise.all([
    monitorStore.loadSummary(selectedWindow.value),
    monitorStore.loadTimeline(50),
    agentsStore.loadAgents().catch(() => {})
  ])
}

function onWindowChange() {
  monitorStore.loadSummary(selectedWindow.value)
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshTimer.value = setInterval(loadAll, 30000)
}

function stopAutoRefresh() {
  if (refreshTimer.value) {
    clearInterval(refreshTimer.value)
    refreshTimer.value = null
  }
}

// ── Helpers ───────────────────────────────────────────────
function getAgentStatus(name) {
  const agent = agentsStore.agents.value.find(a => a.name === name)
  return agent?.status || 'unknown'
}

function isRecent(isoTimestamp, thresholdMs) {
  if (!isoTimestamp) return false
  return Date.now() - new Date(isoTimestamp).getTime() < thresholdMs
}

function getStatusClass(agentData) {
  const live = getAgentStatus(agentData.agent)
  if (live === 'online') return 'online'
  if (agentData.last_seen && isRecent(agentData.last_seen, 300000)) return 'idle'
  return 'dead'
}

function truncateResult(item) {
  let result = ''
  if (item.tool_response) {
    result = typeof item.tool_response === 'string' ? item.tool_response : JSON.stringify(item.tool_response)
  } else if (item.error) {
    result = 'ERR: ' + String(item.error)
  } else if (item.reason) {
    result = String(item.reason)
  }
  return result.slice(0, 80)
}

// ── SSE ───────────────────────────────────────────────────
const sse = inject('sse')
onMounted(() => {
  loadAll()
  startAutoRefresh()
  sse?.on('agent-output', (data) => {
    monitorStore.pushEvent({
      agent: data.agent,
      event: data.event,
      tool_name: data.tool_name,
      tool_response: data.tool_result || data.tool_response,
      error: data.error,
      reason: data.reason,
      timestamp: data.timestamp || new Date().toISOString()
    })
  })
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<template>
  <div class="monitor-view">
    <div class="monitor-header">
      <h2>{{ $t('nav.monitor') || 'Runtime Monitor' }}</h2>
      <select v-model="selectedWindow" @change="onWindowChange" class="window-select">
        <option v-for="opt in windowOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <button class="refresh-btn" @click="loadAll" :disabled="monitorStore.loading.value">&#128260;</button>
    </div>

    <div class="monitor-body">
      <!-- Agent Status Grid -->
      <div class="monitor-section">
        <div class="section-title">Agent Status</div>
        <div v-if="monitorStore.loading.value && monitorStore.summary.value.byAgent.length === 0" class="monitor-empty">{{ $t('state.loading') }}</div>
        <div v-else-if="monitorStore.summary.value.byAgent.length === 0" class="monitor-empty">No agent activity in this window</div>
        <div v-else class="agent-status-grid">
          <div v-for="a in monitorStore.summary.value.byAgent" :key="a.agent" class="monitor-agent-card">
            <div class="monitor-agent-header">
              <span class="agent-status-dot" :class="getStatusClass(a)"></span>
              <span class="monitor-agent-name" :style="{ color: agentColor(a.agent) }">{{ a.agent }}</span>
            </div>
            <div class="monitor-agent-stats">
              <div class="stat-row"><span>Tool Calls</span><span class="stat-val">{{ a.tool_calls || 0 }}</span></div>
              <div class="stat-row"><span>Failures</span><span class="stat-val">{{ a.failures || 0 }}</span></div>
              <div class="stat-row"><span>Total Events</span><span class="stat-val">{{ a.total_events || 0 }}</span></div>
              <div class="stat-row"><span>Last Seen</span><span class="stat-val">{{ a.last_seen ? formatTime(a.last_seen) : '-' }}</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tool Usage Timeline -->
      <div class="monitor-section">
        <div class="section-title">Tool Usage Timeline</div>
        <div v-if="monitorStore.toolTimeline.value.length === 0" class="monitor-empty">No tool usage events yet</div>
        <div v-else class="tool-timeline">
          <div class="timeline-header">
            <span>Time</span>
            <span>Agent</span>
            <span>Tool</span>
            <span>Response</span>
          </div>
          <div v-for="(item, i) in monitorStore.toolTimeline.value" :key="i" class="timeline-row">
            <span class="timeline-time">{{ formatTime(item.timestamp) }}</span>
            <span class="timeline-agent" :style="{ color: agentColor(item.agent || '') }">{{ item.agent || '-' }}</span>
            <span class="timeline-tool">{{ item.tool_name || item.event || '-' }}</span>
            <span class="timeline-result" :title="truncateResult(item)">{{ truncateResult(item) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitor-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.monitor-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.monitor-header h2 { font-size: 16px; font-weight: 700; }
.window-select {
  margin-left: auto;
  padding: 4px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
}
.refresh-btn {
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}
.refresh-btn:hover { background: var(--bg-msg-hover); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.monitor-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.monitor-section { }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.monitor-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-dim);
  font-size: 13px;
}

/* Agent Status Grid */
.agent-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.monitor-agent-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s;
}
.monitor-agent-card:hover { border-color: var(--accent); }
.monitor-agent-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.agent-status-dot.online { background: var(--green); box-shadow: 0 0 6px var(--green); }
.agent-status-dot.idle { background: var(--yellow); }
.agent-status-dot.dead { background: var(--red); }
.agent-status-dot.unknown { background: var(--text-muted); }
.monitor-agent-name { font-size: 14px; font-weight: 600; }
.monitor-agent-stats {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.stat-row {
  display: flex;
  justify-content: space-between;
}
.stat-val { color: var(--text); font-weight: 500; }

/* Tool Timeline */
.tool-timeline {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.timeline-header {
  display: grid;
  grid-template-columns: 80px 90px 120px 1fr;
  gap: 12px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border);
}
.timeline-row {
  display: grid;
  grid-template-columns: 80px 90px 120px 1fr;
  gap: 12px;
  padding: 8px 12px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  align-items: center;
}
.timeline-row:hover { background: var(--bg-msg-hover); }
.timeline-time { color: var(--text-dim); font-family: monospace; }
.timeline-agent {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.timeline-tool {
  color: var(--accent);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.timeline-result {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
