/**
 * credentials store — reactive state for credential management
 * Uses credApi (with x-dashboard-token) for all calls.
 */
import { ref } from 'vue'

export function useCredentialsStore(credApi) {
  // ── State ──────────────────────────────────────────────
  const overview = ref(null)
  const agents = ref([])         // agents with auth_strategy from /api/agents
  const leases = ref([])
  const leasesPage = ref(1)
  const leasesTotal = ref(0)
  const loading = ref(false)

  // ── Actions ─────────────────────────────────────────────
  async function loadOverview() {
    overview.value = await credApi('/api/dashboard/credentials/overview')
    return overview.value
  }

  async function loadAgents() {
    // Uses regular /api/agents (not credentials API)
    const res = await fetch('/api/agents', {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('teammcp_key') }
    })
    agents.value = await res.json()
    return agents.value
  }

  async function loadLeases(page = 1) {
    loading.value = true
    try {
      const data = await credApi(`/api/dashboard/credentials/leases?page=${page}`)
      leases.value = data.leases || []
      leasesTotal.value = data.total || 0
      leasesPage.value = page
      return data
    } finally {
      loading.value = false
    }
  }

  async function revokeLease(leaseId) {
    await credApi(`/api/dashboard/credentials/leases/${encodeURIComponent(leaseId)}/revoke`, {
      method: 'POST'
    })
    // Remove from local list
    leases.value = leases.value.filter(l => l.id !== leaseId)
  }

  async function switchAuthStrategy(agentName, strategy) {
    await credApi(`/api/dashboard/credentials/agents/${encodeURIComponent(agentName)}/auth-strategy`, {
      method: 'PATCH',
      body: JSON.stringify({ auth_strategy: strategy })
    })
    // Update local agent
    const agent = agents.value.find(a => a.name === agentName)
    if (agent) agent.auth_strategy = strategy
  }

  async function refresh() {
    await Promise.all([
      loadOverview().catch(() => {}),
      loadAgents().catch(() => {}),
      loadLeases(leasesPage.value).catch(() => {})
    ])
  }

  return {
    // State
    overview,
    agents,
    leases,
    leasesPage,
    leasesTotal,
    loading,
    // Actions
    loadOverview,
    loadAgents,
    loadLeases,
    revokeLease,
    switchAuthStrategy,
    refresh
  }
}
