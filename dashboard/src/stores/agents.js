/**
 * agents store — reactive state for agent list and management
 */
import { ref, computed } from 'vue'

export function useAgentsStore(api) {
  // ── State ──────────────────────────────────────────────
  const agents = ref([])
  const offlineCollapsed = ref(true)
  const agentOutputData = ref({})    // name → output logs
  const agentActivity = ref({})       // name → { lastSeen, events }

  // ── Computed ───────────────────────────────────────────
  const onlineAgents = computed(() =>
    agents.value.filter(a => a.status === 'online').sort((a, b) => a.name.localeCompare(b.name))
  )
  const offlineAgents = computed(() =>
    agents.value.filter(a => a.status !== 'online').sort((a, b) => a.name.localeCompare(b.name))
  )

  // ── Actions ─────────────────────────────────────────────
  async function loadAgents() {
    const data = await api('/api/agents')
    agents.value = data
    return data
  }

  async function refreshAgents() {
    await loadAgents()
  }

  async function startAgent(name) {
    await api(`/api/agents/${encodeURIComponent(name)}/start`, { method: 'POST' })
    // Immediate refresh — picks up status="starting" / pid.
    await loadAgents()
    // codex-pty agents take 5-15s before their MCP plugin connects via SSE
    // and flips status to "online". The SSE broadcast handles the live
    // update, but if the Dashboard tab lost the SSE event for any reason
    // this fallback poll catches up. Cheap and idempotent.
    setTimeout(() => { loadAgents().catch(() => {}) }, 8000)
  }

  async function stopAgent(name) {
    await api(`/api/agents/${encodeURIComponent(name)}/stop`, { method: 'POST' })
    await loadAgents()
    // Stop is mostly instant, but the SSE plugin's disconnect (which flips
    // status→offline server-side) trails the kill by ~500ms on Windows.
    setTimeout(() => { loadAgents().catch(() => {}) }, 1500)
  }

  async function toggleResume(name, enable) {
    await api(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ use_resume: enable })
    })
    await loadAgents()
  }

  async function deleteAgent(name) {
    await api(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await loadAgents()
  }

  async function updateAgent(name, updates) {
    await api(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    })
    await loadAgents()
  }

  async function loadAgentOutput(name) {
    try {
      const data = await api(`/api/agents/${encodeURIComponent(name)}/output`)
      agentOutputData.value[name] = data
      return data
    } catch {
      agentOutputData.value[name] = null
      return null
    }
  }

  function getAgent(name) {
    return agents.value.find(a => a.name === name)
  }

  // ── SSE handlers ───────────────────────────────────────
  function handleStatus(data) {
    const agent = agents.value.find(a => a.name === data.agent)
    if (agent) {
      agent.status = data.status
    } else {
      // Unknown agent, refresh list
      loadAgents()
    }
  }

  return {
    // State
    agents,
    offlineCollapsed,
    agentOutputData,
    agentActivity,
    // Computed
    onlineAgents,
    offlineAgents,
    // Actions
    loadAgents,
    refreshAgents,
    startAgent,
    stopAgent,
    toggleResume,
    deleteAgent,
    updateAgent,
    loadAgentOutput,
    getAgent,
    // SSE handlers
    handleStatus
  }
}
