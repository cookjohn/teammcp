<script setup>
import { formatTime, formatDate, agentColor, escapeHtml } from '../../utils/format'

const props = defineProps({
  field: String,
  data: Object,
  history: Array
})

const emit = defineEmits(['close'])

function truncateValue(value, maxLen = 40) {
  if (!value) return '(empty)'
  let display = value
  try { display = JSON.stringify(JSON.parse(value), null, 2) } catch {}
  return display.length > maxLen ? display.slice(0, maxLen) + '...' : display
}
</script>

<template>
  <div class="field-detail-panel">
    <div class="field-detail-header">
      <h3>{{ $t('state.fieldDetail') }}</h3>
      <button class="field-detail-close" @click="emit('close')">&times;</button>
    </div>
    <div class="field-detail-body" v-if="data">
      <!-- Field name -->
      <div class="detail-field">
        <div class="detail-label">{{ $t('state.field') }}</div>
        <div class="detail-value accent">{{ data.field }}</div>
      </div>
      <!-- Value -->
      <div class="detail-field">
        <div class="detail-label">{{ $t('state.value') }}</div>
        <div class="detail-full-value">{{ data.value || $t('state.empty') }}</div>
      </div>
      <!-- Owner -->
      <div class="detail-field">
        <div class="detail-label">{{ $t('state.owner') }}</div>
        <div class="detail-value">{{ data.owner || $t('state.none') }}</div>
      </div>
      <!-- Version -->
      <div class="detail-field">
        <div class="detail-label">{{ $t('state.version') }}</div>
        <div class="detail-value"><span class="version-badge">v{{ data.version || 1 }}</span></div>
      </div>
      <!-- Approval -->
      <div v-if="data.approval_required" class="detail-field">
        <div class="detail-label">{{ $t('state.approval') }}</div>
        <div class="detail-value"><span class="approval-badge">{{ $t('state.approvalRequired') }}</span></div>
      </div>
      <!-- Subscribers -->
      <div v-if="data.subscribers && data.subscribers.length > 0" class="detail-field">
        <div class="detail-label">{{ $t('state.subscribers') }}</div>
        <div class="detail-value">{{ (Array.isArray(data.subscribers) ? data.subscribers : []).join(', ') }}</div>
      </div>
      <!-- Last updated -->
      <div class="detail-field">
        <div class="detail-label">{{ $t('state.lastUpdated') }}</div>
        <div class="detail-value dim">
          {{ data.updated_by || '' }} &middot; {{ data.updated_at || '' }}
        </div>
      </div>
      <!-- Change History -->
      <div v-if="history && history.length > 0" class="detail-field">
        <div class="detail-label">{{ $t('state.changeHistory') }}</div>
        <div class="detail-history">
          <div v-for="entry in history" :key="entry.timestamp + entry.field" class="history-entry">
            <div>
              <span class="history-field">{{ entry.field }}</span>
              <span class="history-action">{{ entry.old_value ? $t('state.changed') : $t('state.created') }} {{ $t('state.changedBy') }} </span>
              <span class="history-by" :style="{ color: agentColor(entry.changed_by || 'unknown') }">{{ entry.changed_by || 'unknown' }}</span>
              <span class="version-badge">v{{ entry.version || '?' }}</span>
            </div>
            <div v-if="entry.old_value" class="history-values">
              <span class="history-old">{{ truncateValue(entry.old_value) }}</span>
              <span class="history-arrow">&rarr;</span>
              <span class="history-new">{{ truncateValue(entry.new_value) }}</span>
            </div>
            <div v-else class="history-values">
              <span class="history-new">{{ truncateValue(entry.new_value, 60) }}</span>
            </div>
            <div v-if="entry.reason" class="history-reason">{{ entry.reason }}</div>
            <div class="history-time">{{ formatDate(entry.timestamp) }} {{ formatTime(entry.timestamp) }}</div>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="field-detail-body">
      <div class="detail-empty">{{ $t('state.failedDetail') }}</div>
    </div>
  </div>
</template>

<style scoped>
.field-detail-panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 400px;
  height: 100vh;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  z-index: 100;
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.3);
}
.field-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.field-detail-header h3 {
  font-size: 15px;
  font-weight: 700;
}
.field-detail-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.field-detail-close:hover { background: var(--bg-msg); color: var(--text); }

.field-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.detail-field {
  margin-bottom: 16px;
}
.detail-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.detail-value {
  font-size: 13px;
}
.detail-value.accent { color: var(--accent); font-weight: 700; }
.detail-value.dim { font-size: 12px; color: var(--text-dim); }
.detail-full-value {
  font-family: monospace;
  font-size: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}
.version-badge {
  font-size: 10px;
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text-dim);
}
.approval-badge {
  font-size: 11px;
  background: rgba(212, 132, 62, 0.15);
  color: var(--orange);
  padding: 2px 8px;
  border-radius: 3px;
}
.detail-history { }
.history-entry {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.history-entry:last-child { border-bottom: none; }
.history-field { font-weight: 600; color: var(--text); }
.history-action { color: var(--text-dim); }
.history-by { font-weight: 500; }
.history-values {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
}
.history-old { color: var(--red); text-decoration: line-through; }
.history-arrow { color: var(--text-muted); }
.history-new { color: var(--green); }
.history-reason { color: var(--text-dim); font-style: italic; margin-top: 2px; font-size: 11px; }
.history-time { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
.detail-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-dim);
}
</style>
