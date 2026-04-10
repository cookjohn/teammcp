<script setup>
import { escapeHtml } from '../../utils/format'

const props = defineProps({
  approvals: { type: Array, default: () => [] }
})

const emit = defineEmits(['resolve'])

function truncateValue(value, maxLen = 120) {
  if (!value) return ''
  let display = value
  try { display = JSON.stringify(JSON.parse(value), null, 2) } catch {}
  return display.length > maxLen ? display.slice(0, maxLen) + '...' : display
}
</script>

<template>
  <div v-if="approvals.length > 0" class="approvals-section">
    <div class="section-title">{{ $t('state.pendingApprovals') }}</div>
    <div v-for="a in approvals" :key="a.id" class="approval-card">
      <div class="approval-body">
        <div class="approval-field">{{ a.field || a.key || '' }}</div>
        <div class="approval-meta">
          {{ $t('state.requestedBy') }} <strong>{{ a.updated_by || a.requested_by || 'unknown' }}</strong>
          <em v-if="a.project_id"> {{ $t('state.in') }} {{ a.project_id }}</em>
        </div>
        <div v-if="a.new_value || a.value" class="approval-value">
          {{ truncateValue(a.new_value || a.value) }}
        </div>
        <div class="approval-actions">
          <button class="approve-btn" @click="emit('resolve', a.id, true)">
            &#10003; {{ $t('state.approve') }}
          </button>
          <button class="reject-btn" @click="emit('resolve', a.id, false)">
            &#10007; {{ $t('state.reject') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.approvals-section { }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.approval-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-left: 3px solid var(--orange);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 8px;
}
.approval-field {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}
.approval-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.approval-value {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  margin-bottom: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}
.approval-actions {
  display: flex;
  gap: 8px;
}
.approve-btn, .reject-btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  background: var(--bg-input);
  color: var(--text);
}
.approve-btn:hover {
  background: rgba(61, 214, 140, 0.15);
  border-color: var(--green);
  color: var(--green);
}
.reject-btn:hover {
  background: rgba(229, 83, 75, 0.15);
  border-color: var(--red);
  color: var(--red);
}
</style>
