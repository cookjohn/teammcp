<script setup>
import { ref, onMounted, onUnmounted, computed, inject } from 'vue'

const props = defineProps({
  apiKey: { type: String, required: true }
})

const t = inject('t')

const status = ref(null)
const loading = ref(false)
const expanded = ref(false)
const resetInFlight = ref(false)
let pollTimer = null

function headers() {
  return { Authorization: 'Bearer ' + props.apiKey, 'Content-Type': 'application/json' }
}

async function refresh() {
  loading.value = true
  try {
    const res = await fetch('/api/watchdog/status', { headers: headers() })
    if (res.ok) status.value = await res.json()
  } catch (e) {
    status.value = { verdict: 'critical', error: e.message }
  } finally {
    loading.value = false
  }
}

async function resetEscalation() {
  if (!confirm(t('watchdog.confirmReset'))) return
  resetInFlight.value = true
  try {
    const res = await fetch('/api/watchdog/reset-escalation', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ reason: 'manual_reset_from_dashboard' }),
    })
    const result = await res.json()
    if (!res.ok) alert('Reset failed: ' + (result.error || res.statusText))
    await refresh()
  } catch (e) {
    alert('Reset error: ' + e.message)
  } finally {
    resetInFlight.value = false
  }
}

// Verdict drives a single dot color. Detail rows show below when expanded.
const verdictColor = computed(() => {
  const v = status.value?.verdict || 'unknown'
  if (v === 'ok') return 'green'
  if (v === 'warning') return 'orange'
  if (v === 'critical') return 'red'
  return 'grey'
})

const showResetButton = computed(() => {
  const s = status.value
  if (!s) return false
  return !!s.pty_watchdog?.escalated || s.fallback_fsm?.state === 'failed'
})

onMounted(() => {
  refresh()
  pollTimer = setInterval(refresh, 5000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="watchdog-panel">
    <div class="watchdog-header" @click="expanded = !expanded">
      <span class="watchdog-dot" :class="verdictColor"></span>
      <span class="watchdog-label">{{ t('watchdog.label') }}</span>
      <span class="watchdog-verdict">{{ status?.verdict || '...' }}</span>
      <span class="watchdog-arrow">{{ expanded ? '▴' : '▾' }}</span>
    </div>

    <div v-if="expanded && status" class="watchdog-body">
      <!-- PTY watchdog -->
      <div v-if="status.pty_watchdog" class="watchdog-row">
        <span class="watchdog-key">{{ t('watchdog.pty') }}</span>
        <span class="watchdog-val">
          <span v-if="status.pty_watchdog.escalated" class="bad">{{ t('watchdog.escalated') }} ({{ status.pty_watchdog.escalation_reason }})</span>
          <span v-else>{{ status.pty_watchdog.respawns_in_window }}/{{ status.pty_watchdog.respawn_budget }} {{ t('watchdog.respawns') }}</span>
        </span>
      </div>

      <!-- Fallback FSM -->
      <div v-if="status.fallback_fsm" class="watchdog-row">
        <span class="watchdog-key">{{ t('watchdog.fallback') }}</span>
        <span class="watchdog-val" :class="{ bad: status.fallback_fsm.state === 'failed', warn: ['degraded','reconnecting'].includes(status.fallback_fsm.state) }">
          {{ status.fallback_fsm.state }}
          <template v-if="status.fallback_fsm.reconnect_attempts > 0">
            ({{ t('watchdog.attempt') }} {{ status.fallback_fsm.reconnect_attempts }}/{{ status.fallback_fsm.reconnect_max }})
          </template>
        </span>
      </div>

      <!-- Daemon health -->
      <div v-if="status.daemon_health" class="watchdog-row">
        <span class="watchdog-key">{{ t('watchdog.daemon') }}</span>
        <span class="watchdog-val" :class="{ bad: !status.daemon_health.connected, warn: status.daemon_health.consecutive_failures > 0 }">
          {{ status.daemon_health.connected ? t('watchdog.connected') : t('watchdog.down') }}
          <template v-if="status.daemon_health.consecutive_failures > 0">
            ({{ status.daemon_health.consecutive_failures }} {{ t('watchdog.fails') }})
          </template>
        </span>
      </div>

      <!-- Daemon watchdog (per-handle credit/paused) -->
      <div v-if="status.daemon_watchdog?.handles" class="watchdog-row">
        <span class="watchdog-key">{{ t('watchdog.ptyHandles') }}</span>
        <span class="watchdog-val" :class="{ warn: status.daemon_watchdog.pausedCount > 0 }">
          {{ status.daemon_watchdog.handleCount }} {{ t('watchdog.agents') }},
          {{ status.daemon_watchdog.pausedCount }} {{ t('watchdog.paused') }}
        </span>
      </div>

      <!-- Retention -->
      <div v-if="status.retention_watchdog" class="watchdog-row">
        <span class="watchdog-key">{{ t('watchdog.retention') }}</span>
        <span class="watchdog-val" :class="{ bad: status.retention_watchdog.rollback_fired, ok: status.retention_watchdog.running }">
          <template v-if="status.retention_watchdog.rollback_fired">{{ t('watchdog.rollback') }}</template>
          <template v-else-if="status.retention_watchdog.running">{{ t('watchdog.monitoring') }}</template>
          <template v-else>{{ t('watchdog.off') }}</template>
        </span>
      </div>

      <button v-if="showResetButton"
        class="watchdog-reset-btn"
        :disabled="resetInFlight"
        @click="resetEscalation">
        {{ resetInFlight ? t('watchdog.resetting') : t('watchdog.reset') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.watchdog-panel { padding: 8px 12px; }
.watchdog-header {
  display: flex; align-items: center; gap: 8px;
  cursor: pointer; font-size: 13px;
}
.watchdog-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-muted);
}
.watchdog-dot.green  { background: var(--green); }
.watchdog-dot.orange { background: var(--orange); animation: pulse 1.5s ease-in-out infinite; }
.watchdog-dot.red    { background: var(--red); }
.watchdog-dot.grey   { background: var(--text-muted); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.watchdog-label { color: var(--text-dim); }
.watchdog-verdict { color: var(--text-muted); font-size: 11px; margin-left: auto; }
.watchdog-arrow { color: var(--text-muted); font-size: 10px; }

.watchdog-body {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  font-size: 11px;
}

.watchdog-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  gap: 8px;
}
.watchdog-key { color: var(--text-muted); }
.watchdog-val { color: var(--text-dim); text-align: right; }
.watchdog-val.bad  { color: var(--red); font-weight: 600; }
.watchdog-val.warn { color: var(--orange); }
.watchdog-val.ok   { color: var(--green); }

.watchdog-reset-btn {
  width: 100%; margin-top: 10px;
  padding: 5px 8px;
  background: transparent; color: var(--orange);
  border: 1px solid var(--orange); border-radius: var(--radius-sm);
  font-size: 11px; cursor: pointer;
}
.watchdog-reset-btn:hover:not(:disabled) { background: rgba(247, 144, 9, 0.1); }
.watchdog-reset-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
