<script setup>
import { ref, computed } from 'vue'
import { formatTime, formatDate } from '../../utils/format.js'

const props = defineProps({
  memory: { type: Object, required: true }
})

const emit = defineEmits(['update', 'delete', 'close'])

const showRaw = ref(false)

function levelColor(level) {
  switch (level) {
    case 'critical': return '#e5534b'
    case 'important': return '#d4843e'
    case 'lesson': return '#5b7ff5'
    case 'routine': return '#888'
    default: return '#888'
  }
}

const tags = computed(() => {
  try { return JSON.parse(props.memory.tags || '[]') } catch { return [] }
})

const relatedIds = computed(() => {
  try { return JSON.parse(props.memory.related_ids || '[]') } catch { return [] }
})

function togglePin() {
  emit('update', props.memory.id, { pinned: props.memory.pinned ? 0 : 1 })
}

function changeLevel(newLevel) {
  emit('update', props.memory.id, { level: newLevel })
}

const LEVEL_OPTIONS = ['critical', 'important', 'lesson', 'routine']
</script>

<template>
  <div class="memory-detail">
    <div class="detail-header">
      <h3>{{ memory.title }}</h3>
      <button class="btn-close" @click="emit('close')">\u2715</button>
    </div>

    <div class="detail-body">
      <!-- Level + Category badges -->
      <div class="detail-badges">
        <span class="level-badge" :style="{ background: levelColor(memory.level) }">
          {{ memory.level }}
        </span>
        <span class="category-badge">{{ memory.category }}</span>
        <span v-if="memory.pinned" class="pin-badge">Pinned</span>
      </div>

      <!-- Agent + time -->
      <div class="detail-meta">
        <span>{{ memory.agent }}</span>
        <span class="meta-sep">\u00B7</span>
        <span>{{ formatDate(memory.created_at) }} {{ formatTime(memory.created_at) }}</span>
        <span v-if="memory.source_type" class="meta-sep">\u00B7</span>
        <span v-if="memory.source_type" class="source-type">{{ memory.source_type }}</span>
      </div>

      <!-- Summary -->
      <div class="detail-section">
        <div class="section-title">Summary</div>
        <div class="section-content">{{ memory.summary }}</div>
      </div>

      <!-- Tags -->
      <div v-if="tags.length > 0" class="detail-section">
        <div class="section-title">Tags</div>
        <div class="tags-list">
          <span v-for="tag in tags" :key="tag" class="tag">{{ tag }}</span>
        </div>
      </div>

      <!-- Raw event (collapsible) -->
      <div v-if="memory.raw_event" class="detail-section">
        <div class="section-title collapsible" @click="showRaw = !showRaw">
          Raw Event {{ showRaw ? '\u25B2' : '\u25BC' }}
        </div>
        <pre v-if="showRaw" class="raw-event">{{ memory.raw_event }}</pre>
      </div>

      <!-- TTL + access info -->
      <div class="detail-section detail-info">
        <div>TTL: {{ memory.ttl_days }} days</div>
        <div>Access count: {{ memory.access_count }}</div>
        <div v-if="memory.expires_at">Expires: {{ formatDate(memory.expires_at) }}</div>
      </div>
    </div>

    <!-- Actions -->
    <div class="detail-actions">
      <button class="btn-sm" @click="togglePin">
        {{ memory.pinned ? 'Unpin' : 'Pin' }}
      </button>
      <select
        :value="memory.level"
        @change="changeLevel($event.target.value)"
        class="level-select"
      >
        <option v-for="l in LEVEL_OPTIONS" :key="l" :value="l">
          {{ l.charAt(0).toUpperCase() + l.slice(1) }}
        </option>
      </select>
      <button class="btn-sm btn-danger" @click="emit('delete', memory.id)">Delete</button>
    </div>
  </div>
</template>

<style scoped>
.memory-detail {
  width: 380px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.detail-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
}

.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.detail-badges {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}

.level-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  color: #fff;
  text-transform: uppercase;
  font-weight: 600;
}

.category-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-dim);
}

.pin-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(212, 132, 62, 0.2);
  color: #d4843e;
}

.detail-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 16px;
}

.meta-sep {
  margin: 0 4px;
}

.source-type {
  text-transform: uppercase;
  font-weight: 500;
}

.detail-section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 6px;
}

.section-title.collapsible {
  cursor: pointer;
}

.section-title.collapsible:hover {
  color: var(--accent);
}

.section-content {
  font-size: 13px;
  line-height: 1.5;
}

.tags-list {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(91, 127, 245, 0.15);
  color: var(--accent);
}

.raw-event {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px;
  font-size: 11px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  color: var(--text-dim);
}

.detail-info {
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-actions {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.btn-sm {
  padding: 6px 12px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
}

.btn-danger {
  background: #e5534b;
}

.level-select {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 4px 8px;
  font-size: 12px;
  outline: none;
}
</style>
