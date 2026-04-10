<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { formatDate } from '../../utils/format.js'
import MessageItem from './MessageItem.vue'
import ComposeBox from './ComposeBox.vue'
import FilesBrowser from './FilesBrowser.vue'
import MembersPanel from './MembersPanel.vue'

const props = defineProps({
  channel: { type: Object, default: null },
  messages: { type: Array, default: () => [] },
  hasMore: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  pinnedMessages: { type: Array, default: () => [] },
  channelMembers: { type: Array, default: () => [] },
  agents: { type: Array, default: () => [] },
  agentName: { type: String, default: '' },
  api: { type: Function, required: true }
})

const emit = defineEmits([
  'loadMore', 'sendMessage', 'addReaction', 'removeReaction',
  'loadMembers', 'addMember', 'removeMember', 'pin', 'unpin'
])

const messagesContainer = ref(null)
const replyTo = ref(null)
const showFiles = ref(false)
const showMembers = ref(false)
const isAtBottom = ref(true)
const hasNewMessage = ref(false)

const pinnedIdSet = computed(() => new Set(props.pinnedMessages.map(p => p.id || p.message_id)))

// Group messages by date
const groupedMessages = computed(() => {
  const groups = []
  let lastDate = null
  for (const msg of props.messages) {
    const date = msg.created_at ? new Date(msg.created_at).toDateString() : ''
    if (date !== lastDate) {
      groups.push({ type: 'date', date: msg.created_at, key: 'date-' + date })
      lastDate = date
    }
    groups.push({ type: 'message', data: msg, key: msg.id })
  }
  return groups
})

// Auto-scroll when new messages arrive and we're at bottom
watch(() => props.messages.length, (newLen, oldLen) => {
  if (newLen > oldLen) {
    if (isAtBottom.value) {
      nextTick(() => scrollToBottom())
    } else {
      hasNewMessage.value = true
    }
  }
})

// Scroll to bottom on channel change
watch(() => props.channel?.id, () => {
  replyTo.value = null
  showFiles.value = false
  showMembers.value = false
  nextTick(() => scrollToBottom())
})

function onScroll() {
  const el = messagesContainer.value
  if (!el) return
  const threshold = 60
  isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  if (isAtBottom.value) {
    hasNewMessage.value = false
  }
}

function scrollToBottom() {
  const el = messagesContainer.value
  if (el) {
    el.scrollTop = el.scrollHeight
    isAtBottom.value = true
    hasNewMessage.value = false
  }
}

function onLoadMore() {
  emit('loadMore')
}

function onSend(content, replyToId, mentions) {
  emit('sendMessage', content, replyToId, mentions)
  replyTo.value = null
  nextTick(() => scrollToBottom())
}

function onReply(message) {
  replyTo.value = message
}

function onAddReaction(messageId, emoji) {
  emit('addReaction', messageId, emoji)
}

function onRemoveReaction(messageId, emoji) {
  emit('removeReaction', messageId, emoji)
}

function onPin(messageId) {
  emit('pin', messageId)
}

function onUnpin(messageId) {
  emit('unpin', messageId)
}

function toggleFiles() {
  showFiles.value = !showFiles.value
  if (showFiles.value) showMembers.value = false
}

function toggleMembers() {
  showMembers.value = !showMembers.value
  if (showMembers.value) {
    showFiles.value = false
    emit('loadMembers')
  }
}

function onAddMember(name) {
  emit('addMember', name)
}

function onRemoveMember(name) {
  emit('removeMember', name)
}
</script>

<template>
  <div v-if="!channel" class="empty-state">
    <div class="empty-icon">💬</div>
    <div>Select a channel to view messages</div>
  </div>

  <div v-else class="channel-view">
    <!-- Main area (messages + compose) -->
    <div class="channel-main">
      <!-- Channel header -->
      <div class="channel-header">
        <div class="header-info">
          <span class="header-icon">#</span>
          <h2 class="header-name">{{ channel.name || channel.id }}</h2>
          <span v-if="channel.description" class="header-desc">{{ channel.description }}</span>
        </div>
        <div class="header-actions">
          <button class="header-btn" :class="{ active: showMembers }" @click="toggleMembers" title="Members">
            👥 <span class="btn-label">Members</span>
          </button>
          <button class="header-btn" :class="{ active: showFiles }" @click="toggleFiles" title="Files">
            📁 <span class="btn-label">Files</span>
          </button>
        </div>
      </div>

      <!-- Messages area -->
      <div class="messages-container" ref="messagesContainer" @scroll="onScroll">
        <!-- Load more -->
        <div v-if="hasMore" class="load-more">
          <button class="load-more-btn" :disabled="loading" @click="onLoadMore">
            {{ loading ? 'Loading...' : 'Load older messages' }}
          </button>
        </div>

        <template v-for="item in groupedMessages" :key="item.key">
          <!-- Date separator -->
          <div v-if="item.type === 'date'" class="date-separator">
            <span class="date-label">{{ formatDate(item.date) }}</span>
          </div>

          <!-- Message -->
          <MessageItem
            v-else
            :message="item.data"
            :messages="messages"
            :pinned-ids="pinnedIdSet"
            :agent-name="agentName"
            @reply="onReply"
            @add-reaction="onAddReaction"
            @remove-reaction="onRemoveReaction"
            @pin="onPin"
            @unpin="onUnpin"
          />
        </template>

        <!-- Empty state -->
        <div v-if="messages.length === 0 && !loading" class="no-messages">
          No messages yet. Be the first to say something!
        </div>
      </div>

      <!-- New message indicator -->
      <div v-if="hasNewMessage" class="new-message-bar" @click="scrollToBottom">
        ↓ New messages
      </div>

      <!-- Compose box -->
      <ComposeBox
        :agents="agents"
        :reply-to="replyTo"
        :disabled="!channel"
        @send="onSend"
        @cancel-reply="replyTo = null"
      />
    </div>

    <!-- Side panels -->
    <FilesBrowser
      v-if="showFiles"
      :channel-id="channel.id"
      :api="api"
      @close="showFiles = false"
    />

    <MembersPanel
      v-if="showMembers"
      :members="channelMembers"
      :agents="agents"
      @close="showMembers = false"
      @add-member="onAddMember"
      @remove-member="onRemoveMember"
    />
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 14px;
  gap: 8px;
}

.empty-icon {
  font-size: 40px;
  opacity: 0.5;
}

.channel-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.channel-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  position: relative;
}

/* ── Channel Header ───────────────────── */
.channel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.header-icon {
  font-size: 18px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.header-name {
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
}

.header-desc {
  font-size: 13px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.header-btn {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  padding: 5px 10px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}

.header-btn:hover {
  background: var(--bg-msg-hover);
  color: var(--text);
}

.header-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-label {
  font-size: 12px;
}

/* ── Messages Container ───────────────── */
.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.load-more {
  text-align: center;
  padding: 12px;
}

.load-more-btn {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--accent);
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--bg-msg-hover);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Date Separator ───────────────────── */
.date-separator {
  display: flex;
  align-items: center;
  padding: 16px 24px 8px;
  gap: 12px;
}

.date-separator::before,
.date-separator::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.date-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  white-space: nowrap;
}

/* ── Empty / new messages ─────────────── */
.no-messages {
  text-align: center;
  padding: 48px 24px;
  color: var(--text-muted);
  font-size: 14px;
}

.new-message-bar {
  position: absolute;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--accent);
  color: #fff;
  padding: 6px 16px;
  border-radius: 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  z-index: 5;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  transition: background 0.15s;
}

.new-message-bar:hover {
  background: var(--accent-dim);
}
</style>
