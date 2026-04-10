/**
 * state store — reactive state for project state / observability
 */
import { ref, computed } from 'vue'

export function useStateStore(api) {
  // ── State ──────────────────────────────────────────────
  const currentProjectId = ref('agent-os-mvp')
  const fields = ref([])
  const approvals = ref([])
  const changeLog = ref([])
  const auditReports = ref([])
  const auditFilterType = ref('all')
  const autoRefreshTimer = ref(null)
  const loading = ref(false)
  const lastUpdated = ref(null)

  // ── Computed ───────────────────────────────────────────
  const needApprovalCount = computed(() =>
    fields.value.filter(f => f.approval_required).length
  )
  const activeOwnerCount = computed(() =>
    new Set(fields.value.map(f => f.owner).filter(Boolean)).size
  )

  // ── Actions ─────────────────────────────────────────────
  async function loadFields(projectId) {
    loading.value = true
    try {
      const result = await api(`/api/state?project_id=${encodeURIComponent(projectId)}`)
      fields.value = Array.isArray(result) ? result : (result.items || [])
      lastUpdated.value = new Date()
    } finally {
      loading.value = false
    }
  }

  async function loadApprovals(projectId) {
    approvals.value = await api('/api/state/approvals')
    return approvals.value
  }

  async function loadChangeLog(projectId) {
    changeLog.value = await api(`/api/audit/changelog?project_id=${encodeURIComponent(projectId)}`)
    return changeLog.value
  }

  async function loadAuditReports(projectId, reportType = 'all') {
    const query = reportType !== 'all' ? `&report_type=${reportType}` : ''
    auditReports.value = await api(`/api/audit/reports?project_id=${encodeURIComponent(projectId)}${query}`)
    return auditReports.value
  }

  async function setField(projectId, field, value, approvalRequired = false) {
    const data = await api('/api/state', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, field, value, approval_required: approvalRequired })
    })
    await loadFields(projectId)
    return data
  }

  async function resolveApproval(projectId, approvalId, approved) {
    await api(`/api/state/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ approved })
    })
    await loadApprovals(projectId)
  }

  async function refresh(projectId) {
    if (!projectId) projectId = currentProjectId.value
    await Promise.all([
      loadFields(projectId),
      loadApprovals(projectId)
    ])
  }

  function startAutoRefresh(intervalMs = 15000) {
    stopAutoRefresh()
    autoRefreshTimer.value = setInterval(() => {
      refresh(currentProjectId.value)
    }, intervalMs)
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer.value) {
      clearInterval(autoRefreshTimer.value)
      autoRefreshTimer.value = null
    }
  }

  // ── SSE handlers ───────────────────────────────────────
  function handleStateChanged(data) {
    if (data.project_id === currentProjectId.value) {
      loadFields(data.project_id)
    }
  }

  return {
    // State
    currentProjectId,
    fields,
    approvals,
    changeLog,
    auditReports,
    auditFilterType,
    loading,
    lastUpdated,
    // Computed
    needApprovalCount,
    activeOwnerCount,
    // Actions
    loadFields,
    loadApprovals,
    loadChangeLog,
    loadAuditReports,
    setField,
    resolveApproval,
    refresh,
    startAutoRefresh,
    stopAutoRefresh,
    // SSE handlers
    handleStateChanged
  }
}
