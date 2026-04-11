<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  api: { type: Function, required: true }
})

const health = ref(null)
const loading = ref(true)
let timer = null

async function loadHealth() {
  try {
    // The health endpoint doesn't require auth
    const res = await fetch('/api/pty-daemon/health')
    health.value = await res.json()
  } catch (err) {
    health.value = { status: 'error', error: err.message }
  } finally {
    loading.value = false
  }
}

function statusColor(status) {
  switch (status) {
    case 'healthy': return '#3dd68c'
    case 'degraded': return '#d4843e'
    case 'unhealthy': return '#e5534b'
    case 'disconnected': return '#888'
    default: return '#e5534b'
  }
}

function formatUptime(seconds) {
  if (!seconds) return 'N/A'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

onMounted(() => {
  loadHealth()
  timer = setInterval(loadHealth, 10000) // refresh every 10s
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="daemon-health">
    <div class="panel-header">
      <h3>PTY Daemon Health</h3>
      <div :class="['status-indicator', health?.status || 'unknown']" :style="{ background: statusColor(health?.status) }">
        {{ health?.status || 'Unknown' }}
      </div>
    </div>

    <div v-if="loading" class="loading">Checking daemon status...</div>

    <div v-else-if="health" class="health-content">
      <div class="health-grid">
        <div class="health-card">
          <div class="health-label">Status</div>
          <div class="health-value" :style="{ color: statusColor(health.status) }">
            {{ health.status }}
          </div>
        </div>
        <div v-if="health.uptime_s" class="health-card">
          <div class="health-label">Uptime</div>
          <div class="health-value">{{ formatUptime(health.uptime_s) }}</div>
        </div>
        <div v-if="health.agents_running !== undefined" class="health-card">
          <div class="health-label">Active Agents</div>
          <div class="health-value">{{ health.agents_running }}</div>
        </div>
        <div v-if="health.buffer_size !== undefined" class="health-card">
          <div class="health-label">Buffer Size</div>
          <div class="health-value">{{ health.buffer_size }}</div>
        </div>
        <div v-if="health.memory_mb" class="health-card">
          <div class="health-label">Memory</div>
          <div class="health-value">{{ health.memory_mb }} MB</div>
        </div>
        <div v-if="health.connected !== undefined" class="health-card">
          <div class="health-label">IPC Connected</div>
          <div class="health-value" :style="{ color: health.connected ? '#3dd68c' : '#e5534b' }">
            {{ health.connected ? 'Yes' : 'No' }}
          </div>
        </div>
      </div>

      <div v-if="health.error" class="health-error">
        Error: {{ health.error }}
      </div>
    </div>

    <div v-else class="empty-state">
      <div>Daemon health data unavailable</div>
    </div>
  </div>
</template>

<style scoped>
.daemon-health {
  padding: 20px 24px;
  overflow-y: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
}

.status-indicator {
  padding: 4px 12px;
  border-radius: 12px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  text-transform: capitalize;
}

.loading, .empty-state {
  color: var(--text-dim);
  padding: 20px;
}

.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.health-card {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}

.health-label {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.health-value {
  font-size: 18px;
  font-weight: 700;
}

.health-error {
  margin-top: 16px;
  padding: 10px;
  background: rgba(229, 83, 75, 0.15);
  color: #e5534b;
  border-radius: var(--radius);
  font-size: 13px;
}
</style>
