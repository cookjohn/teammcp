<script setup>
import { ref, computed } from 'vue'
import { formatTime, formatDate, escapeHtml } from '../../utils/format.js'

const props = defineProps({
  memories: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
  offset: { type: Number, default: 0 },
  limit: { type: Number, default: 20 },
  filters: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['select', 'filter', 'search', 'next', 'prev'])

const searchInput = ref('')
const showFilters = ref(false)

function levelColor(level) {
  switch (level) {
    case 'critical': return '#e5534b'
    case 'important': return '#d4843e'
    case 'lesson': return '#5b7ff5'
    case 'routine': return '#888'
    default: return '#888'
  }
}

function levelIcon(level) {
  switch (level) {
    case 'critical': return '\u26A0'
    case 'important': return '\u2605'
    case 'lesson': return '\u2714'
    case 'routine': return '\u25CB'
    default: return '\u25CB'
  }
}

function categoryLabel(cat) {
  const labels = {
    error: 'Error', decision: 'Decision', milestone: 'Milestone',
    debug: 'Debug', security: 'Security', pattern: 'Pattern', general: 'General'
  }
  return labels[cat] || cat
}

function doSearch() {
  emit('search', searchInput.value)
}

function clearSearch() {
  searchInput.value = ''
  emit('search', '')
}

const AGENT_OPTIONS = ['', 'CEO', 'PM', 'CTO', 'A', 'B', 'C', 'xiaomi']
const LEVEL_OPTIONS = ['', 'critical', 'important', 'lesson', 'routine']
const CATEGORY_OPTIONS = ['', 'error', 'decision', 'milestone', 'debug', 'security', 'pattern', 'general']

const canPrev = computed(() => props.offset > 0)
const canNext = computed(() => props.offset + props.limit < props.total)
const pageText = computed(() => {
  const start = props.total === 0 ? 0 : props.offset + 1
  const end = Math.min(props.offset + props.limit, props.total)
  return `${start}\u2013${end} of ${props.total}`
})
</script>

<template>
  <div class="memory-timeline">
    <!-- Search + Filter bar -->
    <div class="timeline-toolbar">
      <div class="search-bar">
        <input
          v-model="searchInput"
          class="search-input"
          placeholder="Search memories..."
          @keyup.enter="doSearch"
        />
        <button class="btn-sm" @click="doSearch">Search</button>
        <button v-if="searchInput" class="btn-sm btn-ghost" @click="clearSearch">Clear</button>
      </div>
      <button
        class="btn-sm btn-ghost"
        @click="showFilters = !showFilters"
      >{{ showFilters ? 'Hide Filters' : 'Filters' }}</button>
    </div>

    <!-- Filters panel -->
    <div v-if="showFilters" class="filters-panel">
      <select
        :value="filters.agent"
        @change="emit('filter', { agent: $event.target.value })"
        class="filter-select"
      >
        <option value="">All Agents</option>
        <option v-for="a in AGENT_OPTIONS.slice(1)" :key="a" :value="a">{{ a }}</option>
      </select>
      <select
        :value="filters.level"
        @change="emit('filter', { level: $event.target.value })"
        class="filter-select"
      >
        <option value="">All Levels</option>
        <option v-for="l in LEVEL_OPTIONS.slice(1)" :key="l" :value="l">
          {{ l.charAt(0).toUpperCase() + l.slice(1) }}
        </option>
      </select>
      <select
        :value="filters.category"
        @change="emit('filter', { category: $event.target.value })"
        class="filter-select"
      >
        <option value="">All Categories</option>
        <option v-for="c in CATEGORY_OPTIONS.slice(1)" :key="c" :value="c">
          {{ categoryLabel(c) }}
        </option>
      </select>
    </div>

    <!-- Timeline list -->
    <div class="timeline-list" :class="{ loading }">
      <div v-if="loading" class="loading-indicator">Loading...</div>
      <div v-else-if="memories.length === 0" class="empty-state">
        <div class="icon">\u{1F4AD}</div>
        <div>No memories found</div>
      </div>
      <div
        v-for="m in memories"
        :key="m.id"
        class="timeline-item"
        @click="emit('select', m.id)"
      >
        <div class="timeline-marker" :style="{ background: levelColor(m.level) }">
          {{ levelIcon(m.level) }}
        </div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span class="memory-title">{{ m.title }}</span>
            <span class="memory-time">{{ formatTime(m.created_at) }}</span>
          </div>
          <div class="timeline-meta">
            <span class="level-badge" :style="{ background: levelColor(m.level) }">{{ m.level }}</span>
            <span v-if="m.category !== 'general'" class="category-badge">{{ categoryLabel(m.category) }}</span>
            <span class="agent-badge">{{ m.agent }}</span>
          </div>
          <div class="memory-summary">{{ m.summary }}</div>
          <div v-if="m.tags && m.tags !== '[]'" class="memory-tags">
            <span v-for="tag in (JSON.parse(m.tags || '[]'))" :key="tag" class="tag">{{ tag }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="total > limit" class="pagination">
      <button class="btn-sm" :disabled="!canPrev" @click="emit('prev')">Prev</button>
      <span class="page-info">{{ pageText }}</span>
      <button class="btn-sm" :disabled="!canNext" @click="emit('next')">Next</button>
    </div>
  </div>
</template>

<style scoped>
.memory-timeline {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--border);
}

.timeline-toolbar {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  align-items: center;
}

.search-bar {
  display: flex;
  gap: 6px;
  flex: 1;
}

.search-input {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 6px 12px;
  font-size: 13px;
  outline: none;
}

.search-input:focus {
  border-color: var(--accent);
}

.btn-sm {
  padding: 6px 12px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}

.btn-sm:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-ghost {
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
}

.filters-panel {
  display: flex;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
}

.filter-select {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 4px 8px;
  font-size: 12px;
  outline: none;
}

.timeline-list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.timeline-list.loading {
  opacity: 0.5;
}

.loading-indicator,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--text-dim);
  font-size: 14px;
  gap: 8px;
}

.empty-state .icon {
  font-size: 32px;
}

.timeline-item {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.1s;
}

.timeline-item:hover {
  background: var(--bg-hover);
}

.timeline-marker {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  flex-shrink: 0;
  margin-top: 2px;
}

.timeline-content {
  flex: 1;
  min-width: 0;
}

.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.memory-title {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.memory-time {
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
  margin-left: 8px;
}

.timeline-meta {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.level-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  color: #fff;
  text-transform: uppercase;
  font-weight: 600;
}

.category-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-dim);
}

.agent-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--accent);
}

.memory-summary {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.memory-tags {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(91, 127, 245, 0.15);
  color: var(--accent);
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.page-info {
  font-size: 12px;
  color: var(--text-dim);
}
</style>
