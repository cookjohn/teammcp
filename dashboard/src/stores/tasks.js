/**
 * tasks store — reactive state for task management
 */
import { ref, computed } from 'vue'

export function useTasksStore(api) {
  // ── State ──────────────────────────────────────────────
  const tasks = ref([])
  const total = ref(0)
  const currentDetail = ref(null)
  const filterStatus = ref('')
  const filterAssignee = ref('')
  const loading = ref(false)

  // ── Computed ───────────────────────────────────────────
  const filteredTasks = computed(() => {
    return tasks.value.filter(t => {
      if (filterStatus.value && t.status !== filterStatus.value) return false
      if (filterAssignee.value && t.assignee !== filterAssignee.value) return false
      return true
    })
  })

  const assignees = computed(() => {
    const set = new Set(tasks.value.map(t => t.assignee).filter(Boolean))
    return Array.from(set).sort()
  })

  // ── Actions ─────────────────────────────────────────────
  async function loadTasks() {
    loading.value = true
    try {
      const params = new URLSearchParams()
      if (filterStatus.value) params.set('status', filterStatus.value)
      if (filterAssignee.value) params.set('assignee', filterAssignee.value)
      const query = params.toString() ? '?' + params.toString() : ''
      const data = await api('/api/tasks' + query)
      tasks.value = data.tasks || []
      total.value = data.total || 0
    } finally {
      loading.value = false
    }
  }

  async function loadTaskDetail(taskId) {
    const data = await api(`/api/tasks/${encodeURIComponent(taskId)}`)
    currentDetail.value = data
    return data
  }

  async function createTask(fields) {
    const data = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(fields)
    })
    await loadTasks()
    return data
  }

  async function updateTask(taskId, updates) {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    })
    // Update local cache
    const idx = tasks.value.findIndex(t => t.id === taskId)
    if (idx !== -1) {
      tasks.value[idx] = { ...tasks.value[idx], ...updates }
    }
    if (currentDetail.value && currentDetail.value.id === taskId) {
      currentDetail.value = { ...currentDetail.value, ...updates }
    }
  }

  async function deleteTask(taskId) {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
    tasks.value = tasks.value.filter(t => t.id !== taskId)
    if (currentDetail.value && currentDetail.value.id === taskId) {
      currentDetail.value = null
    }
  }

  function setFilter(status, assignee) {
    if (status !== undefined) filterStatus.value = status
    if (assignee !== undefined) filterAssignee.value = assignee
  }

  return {
    // State
    tasks,
    total,
    currentDetail,
    filterStatus,
    filterAssignee,
    loading,
    // Computed
    filteredTasks,
    assignees,
    // Actions
    loadTasks,
    loadTaskDetail,
    createTask,
    updateTask,
    deleteTask,
    setFilter
  }
}
