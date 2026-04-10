/**
 * useAuth composable
 * Manages API key authentication, agent identity resolution,
 * and dashboard token lifecycle.
 */
import { ref, computed } from 'vue'

const STORAGE_KEY = 'teammcp_key'
const DASHBOARD_TOKEN_KEY = 'dashboardToken'

export function useAuth() {
  const apiKey = ref(localStorage.getItem(STORAGE_KEY) || '')
  const agentName = ref('')
  const isAuthenticated = ref(false)
  const authError = ref('')
  const dashboardToken = ref(sessionStorage.getItem(DASHBOARD_TOKEN_KEY) || null)
  const isLoading = ref(false)

  /**
   * Login with API key. Verifies by calling /api/agents and resolves agent identity.
   */
  async function login(key) {
    const trimmed = key.trim()
    if (!trimmed) {
      authError.value = 'Please enter an API key'
      return false
    }

    isLoading.value = true
    authError.value = ''

    try {
      // Verify key by fetching agents list
      const res = await fetch('/api/agents', {
        headers: { 'Authorization': 'Bearer ' + trimmed }
      })
      if (!res.ok) {
        throw new Error(`Auth failed: ${res.status}`)
      }
      const agents = await res.json()

      // Resolve our identity: call /api/me
      let name = 'Dashboard'
      try {
        const meRes = await fetch('/api/me', {
          headers: { 'Authorization': 'Bearer ' + trimmed }
        })
        if (meRes.ok) {
          const me = await meRes.json()
          name = me.name || name
        }
      } catch {}

      apiKey.value = trimmed
      agentName.value = name
      isAuthenticated.value = true
      localStorage.setItem(STORAGE_KEY, trimmed)
      return true
    } catch (e) {
      authError.value = 'Authentication failed: ' + e.message
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Logout and clear all auth state
   */
  function logout() {
    apiKey.value = ''
    agentName.value = ''
    isAuthenticated.value = false
    authError.value = ''
    dashboardToken.value = null
    sessionStorage.removeItem(DASHBOARD_TOKEN_KEY)
    localStorage.removeItem(STORAGE_KEY)
  }

  /**
   * Restore session from stored API key (call on app mount)
   */
  async function restoreSession() {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      return await login(saved)
    }
    return false
  }

  /**
   * Get (or fetch) dashboard token for credentials APIs
   */
  async function ensureDashboardToken() {
    if (dashboardToken.value) return dashboardToken.value

    const res = await fetch('/api/dashboard/token', {
      headers: { 'Authorization': 'Bearer ' + apiKey.value }
    })
    if (!res.ok) throw new Error('Failed to fetch dashboard token')
    const data = await res.json()
    dashboardToken.value = data.token || data.dashboardToken || data.access_token
    if (dashboardToken.value) {
      sessionStorage.setItem(DASHBOARD_TOKEN_KEY, dashboardToken.value)
    }
    return dashboardToken.value
  }

  const hasApiKey = computed(() => !!apiKey.value)

  return {
    apiKey,
    agentName,
    isAuthenticated,
    authError,
    dashboardToken,
    isLoading,
    hasApiKey,
    login,
    logout,
    restoreSession,
    ensureDashboardToken
  }
}
