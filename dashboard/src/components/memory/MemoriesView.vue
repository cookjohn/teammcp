<script setup>
import { ref, inject, onMounted, computed } from 'vue'
import MemoryTimeline from './MemoryTimeline.vue'
import MemoryDetail from './MemoryDetail.vue'
import MemoryStats from './MemoryStats.vue'
import LlmConfigPanel from './LlmConfigPanel.vue'
import CostMonitor from './CostMonitor.vue'
import DaemonHealth from './DaemonHealth.vue'

const t = inject('t')
const apiKey = inject('apiKey')

const { api } = (() => {
  // Inline useApi for simplicity
  async function apiCall(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + apiKey.value,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `API ${res.status}`)
    }
    return res.json()
  }
  return { api: apiCall }
})()

// ── Sub-tab state ────────────────────────────────────────
const subTab = ref('memories') // memories | llm-config | cost | daemon

// ── Memories state ───────────────────────────────────────
const memories = ref([])
const total = ref(0)
const loading = ref(false)
const selectedMemory = ref(null)
const searchQuery = ref('')
const filters = ref({ agent: '', level: '', category: '' })
const offset = ref(0)
const limit = 20

async function loadMemories() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    params.set('limit', limit)
    params.set('offset', offset.value)
    if (filters.value.agent) params.set('agent', filters.value.agent)
    if (filters.value.level) params.set('level', filters.value.level)
    if (filters.value.category) params.set('category', filters.value.category)
    if (searchQuery.value) params.set('search', searchQuery.value)

    const data = await api('/api/memories?' + params.toString())
    memories.value = data.memories || []
    total.value = data.total || 0
  } catch (err) {
    console.error('Failed to load memories:', err)
  } finally {
    loading.value = false
  }
}

async function searchMemories() {
  if (!searchQuery.value.trim()) {
    offset.value = 0
    loadMemories()
    return
  }
  loading.value = true
  try {
    const params = new URLSearchParams()
    params.set('q', searchQuery.value)
    params.set('limit', limit)
    const data = await api('/api/memories/search?' + params.toString())
    memories.value = data.results || data.memories || []
    total.value = memories.value.length
  } catch (err) {
    console.error('Search failed:', err)
  } finally {
    loading.value = false
  }
}

async function selectMemory(id) {
  try {
    const data = await api('/api/memories/' + id)
    selectedMemory.value = data.memory || data
  } catch (err) {
    console.error('Failed to load memory detail:', err)
  }
}

async function updateMemory(id, changes) {
  try {
    await api('/api/memories/' + id, {
      method: 'PATCH',
      body: JSON.stringify(changes)
    })
    loadMemories()
    if (selectedMemory.value?.id === id) {
      selectMemory(id)
    }
  } catch (err) {
    console.error('Failed to update memory:', err)
  }
}

async function deleteMemory(id) {
  if (!confirm('Delete this memory?')) return
  try {
    await api('/api/memories/' + id, { method: 'DELETE' })
    if (selectedMemory.value?.id === id) selectedMemory.value = null
    loadMemories()
  } catch (err) {
    console.error('Failed to delete memory:', err)
  }
}

function nextPage() {
  offset.value += limit
  loadMemories()
}
function prevPage() {
  offset.value = Math.max(0, offset.value - limit)
  loadMemories()
}

function onFilterChange(newFilters) {
  filters.value = { ...filters.value, ...newFilters }
  offset.value = 0
  loadMemories()
}

function onSearch(q) {
  searchQuery.value = q
  offset.value = 0
  searchMemories()
}

onMounted(() => loadMemories())
</script>

<template>
  <div class="memories-view">
    <!-- Sub-tabs -->
    <div class="sub-tabs">
      <button
        v-for="tab in [
          { id: 'memories', label: 'Memories' },
          { id: 'llm-config', label: 'LLM Config' },
          { id: 'cost', label: 'Cost Monitor' },
          { id: 'daemon', label: 'Daemon' }
        ]"
        :key="tab.id"
        :class="['sub-tab', { active: subTab === tab.id }]"
        @click="subTab = tab.id"
      >{{ tab.label }}</button>
    </div>

    <!-- Memories Tab -->
    <div v-if="subTab === 'memories'" class="memories-content">
      <MemoryStats :api="api" />

      <div class="memories-main">
        <MemoryTimeline
          :memories="memories"
          :total="total"
          :loading="loading"
          :offset="offset"
          :limit="limit"
          :filters="filters"
          @select="selectMemory"
          @filter="onFilterChange"
          @search="onSearch"
          @next="nextPage"
          @prev="prevPage"
        />
        <MemoryDetail
          v-if="selectedMemory"
          :memory="selectedMemory"
          @update="updateMemory"
          @delete="deleteMemory"
          @close="selectedMemory = null"
        />
      </div>
    </div>

    <!-- LLM Config Tab -->
    <LlmConfigPanel v-else-if="subTab === 'llm-config'" :api="api" />

    <!-- Cost Monitor Tab -->
    <CostMonitor v-else-if="subTab === 'cost'" :api="api" />

    <!-- Daemon Health Tab -->
    <DaemonHealth v-else-if="subTab === 'daemon'" :api="api" />
  </div>
</template>

<style scoped>
.memories-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.sub-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 24px;
  background: var(--bg-sidebar);
}

.sub-tab {
  padding: 10px 20px;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}

.sub-tab:hover {
  color: var(--text);
}

.sub-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.memories-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.memories-main {
  display: flex;
  flex: 1;
  overflow: hidden;
}
</style>
