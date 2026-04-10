/**
 * useApi composable
 * Encapsulates all HTTP calls to TeamMCP backend with auth headers.
 */
import { ref } from 'vue'

const API_BASE = '' // relative to Vite proxy, proxy maps /api → http://localhost:3100

/**
 * @param {Function|string} apiKeyOrGetter - Bearer token string or getter function that returns the current token
 * @returns {object} - { api, credApi }
 */
export function useApi(apiKeyOrGetter) {
  const lastError = ref(null)

  function getKey() {
    return typeof apiKeyOrGetter === 'function' ? apiKeyOrGetter() : apiKeyOrGetter
  }

  /**
   * Generic fetch wrapper for JSON APIs
   */
  async function api(path, options = {}) {
    const url = API_BASE + path
    const headers = {
      'Authorization': 'Bearer ' + getKey(),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }

    const res = await fetch(url, { ...options, headers })
    if (!res.ok) {
      let errMsg = `API ${res.status}: ${res.statusText}`
      try {
        const body = await res.json()
        if (body.error) errMsg = body.error
      } catch {}
      lastError.value = errMsg
      throw new Error(errMsg)
    }
    lastError.value = null
    return res.json()
  }

  /**
   * Dashboard-token authenticated calls (for credentials APIs)
   * Adds x-dashboard-token header after ensuring token is acquired.
   */
  async function credApi(path, dashboardToken, options = {}) {
    const url = API_BASE + path
    const headers = {
      'Authorization': 'Bearer ' + getKey(),
      'x-dashboard-token': dashboardToken,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }

    const res = await fetch(url, { ...options, headers })
    if (!res.ok) {
      let errMsg = `API ${res.status}: ${res.statusText}`
      try {
        const body = await res.json()
        if (body.error) errMsg = body.error
      } catch {}
      lastError.value = errMsg
      throw new Error(errMsg)
    }
    lastError.value = null
    return res.json()
  }

  /**
   * POST with JSON body
   */
  async function post(path, body, options = {}) {
    return api(path, { method: 'POST', body: JSON.stringify(body), ...options })
  }

  /**
   * PATCH with JSON body
   */
  async function patch(path, body, options = {}) {
    return api(path, { method: 'PATCH', body: JSON.stringify(body), ...options })
  }

  /**
   * DELETE
   */
  async function del(path, options = {}) {
    return api(path, { method: 'DELETE', ...options })
  }

  return { api, credApi, post, patch, del, lastError }
}
