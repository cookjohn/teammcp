/**
 * channels store — reactive state for channels and messages
 * Uses Vue 3 Composition API reactive refs (no Pinia needed per spec).
 */
import { ref, computed } from 'vue'

export function useChannelsStore(api, agentName) {
  // ── State ──────────────────────────────────────────────
  const channels = ref([])
  const currentChannelId = ref(null)
  const messages = ref([])
  const channelMembers = ref([])
  const pinnedMessages = ref([])
  const pinnedPanelOpen = ref(false)
  const hasMore = ref(false)
  const loading = ref(false)

  // File browsing
  const channelFiles = ref([])
  const currentFolderId = ref(null)
  const currentFolderPath = ref([]) // [{id, name}, ...]
  const channelFolders = ref([])

  // ── Computed ───────────────────────────────────────────
  const currentChannel = computed(() =>
    channels.value.find(c => c.id === currentChannelId.value) || null
  )

  const unreadCounts = computed(() => {
    const counts = {}
    for (const ch of channels.value) {
      counts[ch.id] = ch.unread || 0
    }
    return counts
  })

  // ── Actions ─────────────────────────────────────────────
  async function loadChannels() {
    const data = await api('/api/channels')
    channels.value = data
    return data
  }

  async function selectChannel(channelId) {
    currentChannelId.value = channelId
    messages.value = []
    hasMore.value = false
    loading.value = true
    try {
      const data = await api(`/api/history?channel=${encodeURIComponent(channelId)}&limit=50`)
      messages.value = data.messages || []
      hasMore.value = data.has_more || false
    } finally {
      loading.value = false
    }
    // Load pins in parallel
    loadPins(channelId)
    // Bump unread to 0 for selected channel
    const ch = channels.value.find(c => c.id === channelId)
    if (ch) ch.unread = 0
  }

  async function loadMoreMessages() {
    if (!hasMore.value || loading.value) return
    loading.value = true
    try {
      const oldest = messages.value[0]
      if (!oldest) return
      const data = await api(
        `/api/history?channel=${encodeURIComponent(currentChannelId.value)}&before=${oldest.id}&limit=50`
      )
      messages.value = [...(data.messages || []), ...messages.value]
      hasMore.value = data.has_more || false
    } finally {
      loading.value = false
    }
  }

  async function sendMessage(content, replyTo = null, mentions = []) {
    const body = { channel: currentChannelId.value, content }
    if (replyTo) body.replyTo = replyTo
    if (mentions.length) body.mentions = mentions

    const data = await api('/api/send', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    // Server SSE doesn't push message back to sender, so add it locally
    if (data && data.id) {
      handleMessage({
        id: data.id,
        channel: currentChannelId.value,
        from: agentName.value,
        content,
        timestamp: data.timestamp || new Date().toISOString(),
        replyTo: replyTo || null,
        mentions: mentions || [],
        metadata: data.metadata || null
      })
    }
    return data
  }

  async function loadPins(channelId) {
    try {
      const data = await api(`/api/channels/${encodeURIComponent(channelId)}/pins`)
      pinnedMessages.value = data.pins || data || []
    } catch {
      pinnedMessages.value = []
    }
  }

  async function pinMessage(messageId) {
    await api(`/api/messages/${encodeURIComponent(messageId)}/pin`, {
      method: 'POST'
    })
  }

  async function unpinMessage(messageId) {
    await api(`/api/messages/${encodeURIComponent(messageId)}/pin`, {
      method: 'DELETE'
    })
  }

  async function loadMembers(channelId) {
    const data = await api(`/api/channels/${encodeURIComponent(channelId)}/members`)
    channelMembers.value = data?.members || []
    return data
  }

  async function addMember(agentName) {
    await api(`/api/channels/${encodeURIComponent(currentChannelId.value)}/members`, {
      method: 'POST',
      body: JSON.stringify({ agent_name: agentName })
    })
  }

  async function removeMember(agentName) {
    await api(`/api/channels/${encodeURIComponent(currentChannelId.value)}/members/${encodeURIComponent(agentName)}`, {
      method: 'DELETE'
    })
  }

  async function markChannelRead(channelId) {
    try {
      await api(`/api/channels/${encodeURIComponent(channelId)}/read`, { method: 'POST' })
    } catch {}
  }

  // ── SSE event handlers ──────────────────────────────────
  function handleMessage(data) {
    if (data.channel === currentChannelId.value) {
      if (!messages.value.some(m => m.id === data.id)) {
        messages.value.push({
          id: data.id,
          channel_id: data.channel,
          from_agent: data.from,
          content: data.content,
          created_at: data.timestamp,
          reply_to: data.replyTo,
          mentions: data.mentions,
          metadata: data.metadata
        })
      }
    }
    // Bump unread for other channels
    const ch = channels.value.find(c => c.id === data.channel)
    if (ch && data.channel !== currentChannelId.value) {
      ch.unread = (ch.unread || 0) + 1
    }
  }

  function handleMessageEdited(data) {
    if (data.channel === currentChannelId.value) {
      const msg = messages.value.find(m => m.id === data.id)
      if (msg) {
        msg.content = data.content
        msg.edited_at = data.edited_at
      }
    }
  }

  function handleMessageDeleted(data) {
    if (data.channel === currentChannelId.value) {
      messages.value = messages.value.filter(m => m.id !== data.id)
    }
  }

  return {
    // State
    channels,
    currentChannelId,
    currentChannel,
    messages,
    channelMembers,
    pinnedMessages,
    pinnedPanelOpen,
    hasMore,
    loading,
    channelFiles,
    currentFolderId,
    currentFolderPath,
    channelFolders,
    unreadCounts,
    // Actions
    loadChannels,
    selectChannel,
    loadMoreMessages,
    sendMessage,
    loadPins,
    pinMessage,
    unpinMessage,
    loadMembers,
    addMember,
    removeMember,
    markChannelRead,
    // SSE handlers
    handleMessage,
    handleMessageEdited,
    handleMessageDeleted
  }
}
