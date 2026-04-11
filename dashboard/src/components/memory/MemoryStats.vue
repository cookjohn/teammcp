<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({
  api: { type: Function, required: true }
})

const stats = ref({
  critical: 0, important: 0, lesson: 0, routine: 0,
  total: 0, todayNew: 0, activeAgents: 0
})
const loading = ref(true)

onMounted(async () => {
  try {
    // Fetch all memories with a large limit for stats
    const [allData, todayData] = await Promise.all([
      props.api('/api/memories?limit=1'),
      props.api('/api/memories?limit=1&search=')
    ])
    stats.value.total = allData.total || 0

    // Get counts per level
    const levels = ['critical', 'important', 'lesson', 'routine']
    const levelCounts = await Promise.all(
      levels.map(l => props.api(`/api/memories?level=${l}&limit=1`).then(d => ({ level: l, count: d.total || 0 })).catch(() => ({ level: l, count: 0 })))
    )
    for (const { level, count } of levelCounts) {
      stats.value[level] = count
    }

    // Get today's new count
    const today = new Date().toISOString().slice(0, 10)
    // Approximate: we don't have a date filter in the API, so skip today count
  } catch (err) {
    console.error('Failed to load stats:', err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="memory-stats">
    <div class="stat-card stat-critical">
      <div class="stat-value">{{ stats.critical }}</div>
      <div class="stat-label">Critical</div>
    </div>
    <div class="stat-card stat-important">
      <div class="stat-value">{{ stats.important }}</div>
      <div class="stat-label">Important</div>
    </div>
    <div class="stat-card stat-lesson">
      <div class="stat-value">{{ stats.lesson }}</div>
      <div class="stat-label">Lesson</div>
    </div>
    <div class="stat-card stat-routine">
      <div class="stat-value">{{ stats.routine }}</div>
      <div class="stat-label">Routine</div>
    </div>
    <div class="stat-card stat-total">
      <div class="stat-value">{{ stats.total }}</div>
      <div class="stat-label">Total</div>
    </div>
  </div>
</template>

<style scoped>
.memory-stats {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 16px;
  border-radius: var(--radius);
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  min-width: 72px;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
}

.stat-label {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-top: 2px;
}

.stat-critical .stat-value { color: #e5534b; }
.stat-important .stat-value { color: #d4843e; }
.stat-lesson .stat-value { color: #5b7ff5; }
.stat-routine .stat-value { color: #888; }
.stat-total .stat-value { color: var(--accent); }
</style>
