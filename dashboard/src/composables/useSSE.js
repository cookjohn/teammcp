/**
 * useSSE composable
 * Manages a fetch-based SSE connection (native EventSource doesn't support custom headers).
 * Dispatches incoming events to registered handlers reactively.
 */
import { ref, onUnmounted } from 'vue'

export function useSSE(apiKeyOrGetter, eventHandlers = {}) {
  const connected = ref(false)
  const reconnecting = ref(false)
  let abortController = null
  let reconnectTimer = null

  const handlers = { ...eventHandlers }

  /**
   * Register event handler for a specific SSE event type
   */
  function on(eventType, handler) {
    handlers[eventType] = handler
  }

  /**
   * Unregister handler
   */
  function off(eventType) {
    delete handlers[eventType]
  }

  /**
   * Connect to SSE stream
   */
  function connect() {
    if (abortController) {
      abortController.abort()
      abortController = null
    }

    abortController = new AbortController()

    const url = '/api/events'
    connected.value = false
    reconnecting.value = false

    fetchSSE(url, {
      signal: abortController.signal,
      onOpen() {
        connected.value = true
        reconnecting.value = false
        handlers['open']?.()
      },
      onMessage(data) {
        const handler = handlers[data.type]
        if (handler) {
          handler(data)
        }
      },
      onError() {
        connected.value = false
        reconnecting.value = true
        handlers['error']?.()
        // Auto-reconnect after 3s
        reconnectTimer = setTimeout(() => {
          connect()
        }, 3000)
      }
    }).catch(e => {
      if (e.name === 'AbortError') return
      connected.value = false
      reconnecting.value = true
      handlers['error']?.()
      reconnectTimer = setTimeout(() => connect(), 3000)
    })
  }

  /**
   * Disconnect SSE
   */
  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    connected.value = false
    reconnecting.value = false
  }

  /**
   * Core SSE reader using fetch + ReadableStream
   */
  async function fetchSSE(url, { signal, onOpen, onMessage, onError }) {
    const key = typeof apiKeyOrGetter === 'function' ? apiKeyOrGetter() : apiKeyOrGetter
    const response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + key },
      signal
    })

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status}`)
    }

    onOpen()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            onMessage(data)
          } catch {}
        }
      }
    }

    onError()
  }

  // Auto-cleanup on component unmount
  onUnmounted(() => {
    disconnect()
  })

  return { connected, reconnecting, connect, disconnect, on, off }
}
