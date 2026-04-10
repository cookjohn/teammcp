/**
 * monitor store — reactive state for runtime monitoring
 */
import { ref } from 'vue'

const MAX_TIMELINE = 50

export function useMonitorStore(api) {
  // ── State ──────────────────────────────────────────────
  const summary = ref({ byAgent: [], byEvent: [] })
  const toolTimeline = ref([])
  const window = ref('1h')
  const loading = ref(false)

  // ── Actions ─────────────────────────────────────────────
  async function loadSummary(windowVal) {
    if (windowVal) window.value = windowVal
    loading.value = true
    try {
      summary.value = await api(`/api/cc-metrics/summary?window=${encodeURIComponent(window.value)}`)
    } catch {
      summary.value = { byAgent: [], byEvent: [] }
    } finally {
      loading.value = false
    }
  }

  async function loadTimeline(limit = 50) {
    try {
      const data = await api(`/api/cc-metrics?limit=${limit}`)
      toolTimeline.value = Array.isArray(data) ? data : (data.metrics || [])
    } catch {
      toolTimeline.value = []
    }
  }

  async function refresh() {
    await Promise.all([loadSummary(), loadTimeline()])
  }

  function pushEvent(event) {
    toolTimeline.value.unshift(event)
    if (toolTimeline.value.length > MAX_TIMELINE) {
      toolTimeline.value = toolTimeline.value.slice(0, MAX_TIMELINE)
    }
    // Update summary agent stats
    if (event.agent && summary.value.byAgent) {
      const found = summary.value.byAgent.find(a => a.agent === event.agent)
      if (found) {
        found.total_events = (found.total_events || 0) + 1
        if (event.event === 'PostToolUse') found.tool_calls = (found.tool_calls || 0) + 1
        if (event.event === 'StopFailure') found.failures = (found.failures || 0) + 1
        found.last_seen = event.timestamp || new Date().toISOString()
      } else {
        summary.value.byAgent.push({
          agent: event.agent,
          total_events: 1,
          tool_calls: event.event === 'PostToolUse' ? 1 : 0,
          failures: event.event === 'StopFailure' ? 1 : 0,
          last_seen: event.timestamp || new Date().toISOString()
        })
      }
    }
  }

  return {
    summary,
    toolTimeline,
    window,
    loading,
    loadSummary,
    loadTimeline,
    refresh,
    pushEvent
  }
}
