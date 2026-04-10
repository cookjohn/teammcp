<script setup>
import { ref, onMounted, watch } from 'vue'
import { formatTime, formatDate, agentColor } from '../../utils/format'

const props = defineProps({
  projectId: { type: String, required: true },
  api: { type: Function, required: true }
})

const entries = ref([])
const loading = ref(true)

async function loadChangeLog() {
  loading.value = true
  try {
    // Load changelog for up to 10 fields
    const fieldsData = await props.api(`/api/state?project_id=${encodeURIComponent(props.projectId)}`)
    const fields = Array.isArray(fieldsData) ? fieldsData : (fieldsData.items || [])
    let allEntries = []
    for (const field of fields.slice(0, 10)) {
      try {
        const hist = await props.api(`/api/state/history?project_id=${encodeURIComponent(props.projectId)}&field=${encodeURIComponent(field.field)}&limit=5`)
        if (Array.isArray(hist)) {
          allEntries = allEntries.concat(hist)
        }
      } catch {}
    }
    allEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    entries.value = allEntries.slice(0, 20)
  } catch {
    entries.value = []
  }
  loading.value = false
}

function truncateValue(value, maxLen = 40) {
  if (!value) return '(empty)'
  let display = value
  try { display = JSON.stringify(JSON.parse(value), null, 2) } catch {}
  return display.length > maxLen ? display.slice(0, maxLen) + '...' : display
}

onMounted(loadChangeLog)
watch(() => props.projectId, loadChangeLog)
</script>

<template>
  <div class="changelog-section">
    <div class="section-title">{{ $t('state.recentChanges') }}</div>
    <div v-if="loading" class="changelog-loading">{{ $t('state.loading') }}</div>
    <div v-else-if="entries.length === 0" class="changelog-empty">{{ $t('state.noChanges') }}</div>
    <div v-else class="changelog-timeline">
      <div v-for="(entry, i) in entries" :key="i" class="timeline-entry">
        <div>
          <span class="timeline-field">{{ entry.field }}</span>
          <span class="timeline-action"> {{ entry.old_value ? $t('state.changed') : $t('state.created') }} {{ $t('state.changedBy') }} </span>
          <span class="timeline-by" :style="{ color: agentColor(entry.changed_by || 'unknown') }">{{ entry.changed_by || 'unknown' }}</span>
          <span class="timeline-version">v{{ entry.version || '?' }}</span>
        </div>
        <div v-if="entry.old_value" class="timeline-values">
          <span class="timeline-old">{{ truncateValue(entry.old_value) }}</span>
          <span class="timeline-arrow">&rarr;</span>
          <span class="timeline-new">{{ truncateValue(entry.new_value) }}</span>
        </div>
        <div v-else class="timeline-values">
          <span class="timeline-new">{{ truncateValue(entry.new_value, 60) }}</span>
        </div>
        <div v-if="entry.reason" class="timeline-reason">{{ entry.reason }}</div>
        <div class="timeline-time">{{ formatDate(entry.timestamp) }} {{ formatTime(entry.timestamp) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.changelog-section { }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.changelog-loading, .changelog-empty {
  color: var(--text-muted);
  font-size: 13px;
  padding: 12px 0;
}
.changelog-timeline { }
.timeline-entry {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.timeline-entry:last-child { border-bottom: none; }
.timeline-field { font-weight: 600; color: var(--text); }
.timeline-action { color: var(--text-dim); }
.timeline-by { font-weight: 500; }
.timeline-version {
  font-size: 10px;
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text-dim);
  margin-left: 4px;
}
.timeline-values {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
}
.timeline-old { color: var(--red); text-decoration: line-through; }
.timeline-arrow { color: var(--text-muted); }
.timeline-new { color: var(--green); }
.timeline-reason {
  color: var(--text-dim);
  font-style: italic;
  margin-top: 2px;
  font-size: 11px;
}
.timeline-time {
  color: var(--text-muted);
  font-size: 11px;
  margin-top: 2px;
}
</style>
