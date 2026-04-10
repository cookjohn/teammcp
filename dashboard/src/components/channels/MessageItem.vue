<script setup>
import { ref, computed } from 'vue'
import { renderMarkdown } from '../../utils/markdown.js'
import { formatTime, agentColor, agentInitial } from '../../utils/format.js'

const REACTION_EMOJIS = ['👍', '👎', '❤️', '😄', '🎉', '👀', '🤔', '✅']

const props = defineProps({
  message: { type: Object, required: true },
  messages: { type: Array, default: () => [] },
  pinnedIds: { type: Set, default: () => new Set() },
  agentName: { type: String, default: '' }
})

const emit = defineEmits(['reply', 'addReaction', 'removeReaction', 'pin', 'unpin'])

const collapsed = ref(true)
const showReactionPicker = ref(false)

const isLongMessage = computed(() => {
  if (!props.message.content) return false
  const lines = props.message.content.split('\n').length
  return lines > 15 || props.message.content.length > 800
})

const displayContent = computed(() => {
  let content = props.message.content || ''
  if (isLongMessage.value && collapsed.value) {
    const lines = content.split('\n')
    if (lines.length > 15) {
      content = lines.slice(0, 15).join('\n') + '\n...'
    } else if (content.length > 800) {
      content = content.slice(0, 800) + '...'
    }
  }
  return renderMarkdown(content)
})

const isPinned = computed(() => props.pinnedIds.has(props.message.id))

const replyToMessage = computed(() => {
  if (!props.message.reply_to) return null
  return props.messages.find(m => m.id === props.message.reply_to)
})

const senderColor = computed(() => agentColor(props.message.from_agent))
const senderInitial = computed(() => agentInitial(props.message.from_agent))

const sourceLabel = computed(() => {
  const src = props.message.metadata?.source
  if (src === 'dashboard') return 'Chairman'
  if (src === 'wechat') return 'WeChat'
  if (src === 'display_only') return 'Display'
  return null
})

const sourceBadgeClass = computed(() => {
  const src = props.message.metadata?.source
  if (src === 'dashboard') return 'badge-chairman'
  if (src === 'wechat') return 'badge-wechat'
  if (src === 'display_only') return 'badge-display'
  return ''
})

const reactions = computed(() => props.message.reactions || [])

function onDoubleClick() {
  emit('reply', props.message)
}

function toggleReactionPicker() {
  showReactionPicker.value = !showReactionPicker.value
}

function selectReaction(emoji) {
  // Check if we already reacted with this emoji
  const existing = reactions.value.find(r => r.emoji === emoji && r.agent === props.agentName)
  if (existing) {
    emit('removeReaction', props.message.id, emoji)
  } else {
    emit('addReaction', props.message.id, emoji)
  }
  showReactionPicker.value = false
}
</script>

<template>
  <div class="message-item" @dblclick="onDoubleClick">
    <!-- Reply indicator -->
    <div v-if="replyToMessage" class="reply-indicator">
      <span class="reply-icon">↱</span>
      <span class="reply-text">Replying to <strong :style="{ color: agentColor(replyToMessage.from_agent) }">{{ replyToMessage.from_agent }}</strong></span>
    </div>

    <div class="message-row">
      <!-- Avatar -->
      <div class="avatar" :style="{ background: senderColor }">
        {{ senderInitial }}
      </div>

      <!-- Body -->
      <div class="message-body">
        <div class="message-header">
          <span class="sender-name" :style="{ color: senderColor }">{{ message.from_agent }}</span>
          <span v-if="sourceLabel" class="source-badge" :class="sourceBadgeClass">{{ sourceLabel }}</span>
          <span v-if="isPinned" class="pin-badge" title="Pinned">📌</span>
          <span v-if="message.edited_at" class="edited-badge">(edited)</span>
          <span class="msg-time">{{ formatTime(message.created_at) }}</span>
        </div>

        <div class="message-content" v-html="displayContent"></div>

        <button v-if="isLongMessage" class="toggle-btn" @click="collapsed = !collapsed">
          {{ collapsed ? 'Show more...' : 'Show less' }}
        </button>

        <!-- Reactions -->
        <div v-if="reactions.length > 0" class="reactions-row">
          <span
            v-for="r in reactions"
            :key="r.emoji + r.agent"
            class="reaction-chip"
            :class="{ own: r.agent === agentName }"
            @click="selectReaction(r.emoji)"
            :title="r.agent"
          >
            {{ r.emoji }}
          </span>
        </div>

        <!-- Action buttons -->
        <div class="message-actions">
          <button class="action-btn" @click="toggleReactionPicker" title="Add reaction">😊</button>
          <button class="action-btn" @click="$emit('reply', message)" title="Reply">↩</button>
          <button
            class="action-btn"
            :title="isPinned ? 'Unpin message' : 'Pin message'"
            @click="isPinned ? $emit('unpin', message.id) : $emit('pin', message.id)"
          >📌</button>
        </div>

        <!-- Reaction picker -->
        <div v-if="showReactionPicker" class="reaction-picker">
          <span
            v-for="emoji in REACTION_EMOJIS"
            :key="emoji"
            class="reaction-option"
            @click="selectReaction(emoji)"
          >{{ emoji }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-item {
  padding: 6px 24px;
  transition: background 0.1s;
  position: relative;
}

.message-item:hover {
  background: var(--bg-msg-hover);
}

.message-item:hover .message-actions {
  opacity: 1;
}

.reply-indicator {
  padding: 2px 0 4px 56px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

.reply-icon {
  font-size: 14px;
}

.message-row {
  display: flex;
  gap: 12px;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  margin-top: 2px;
}

.message-body {
  flex: 1;
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}

.sender-name {
  font-size: 14px;
  font-weight: 700;
}

.source-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.badge-chairman {
  background: rgba(229, 83, 75, 0.2);
  color: var(--red);
}

.badge-wechat {
  background: rgba(61, 214, 140, 0.2);
  color: var(--green);
}

.badge-display {
  background: rgba(139, 143, 163, 0.2);
  color: var(--text-dim);
}

.pin-badge {
  font-size: 12px;
}

.edited-badge {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

.msg-time {
  font-size: 11px;
  color: var(--text-muted);
}

.message-content {
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

/* Markdown styles inside message-content */
.message-content :deep(pre.md-code-block) {
  background: var(--code-bg);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  margin: 6px 0;
  font-size: 13px;
  line-height: 1.4;
}

.message-content :deep(code.md-inline-code) {
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 13px;
}

.message-content :deep(.md-link) {
  color: var(--accent);
  text-decoration: none;
}

.message-content :deep(.md-link:hover) {
  text-decoration: underline;
}

.message-content :deep(.md-blockquote) {
  border-left: 3px solid var(--accent);
  padding-left: 10px;
  color: var(--text-dim);
  margin: 4px 0;
}

.message-content :deep(.md-h1) { font-size: 18px; font-weight: 700; margin: 8px 0 4px; }
.message-content :deep(.md-h2) { font-size: 16px; font-weight: 700; margin: 6px 0 3px; }
.message-content :deep(.md-h3) { font-size: 15px; font-weight: 600; margin: 4px 0 2px; }

.message-content :deep(.md-ul),
.message-content :deep(.md-ol) {
  padding-left: 20px;
  margin: 4px 0;
}

.toggle-btn {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 0;
  margin-top: 4px;
}

.toggle-btn:hover {
  text-decoration: underline;
}

.reactions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.reaction-chip {
  font-size: 14px;
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1px 6px;
  cursor: pointer;
  transition: background 0.1s;
}

.reaction-chip:hover {
  background: var(--bg-msg-hover);
}

.reaction-chip.own {
  border-color: var(--accent);
  background: rgba(91, 127, 245, 0.15);
}

.message-actions {
  position: absolute;
  top: 4px;
  right: 24px;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.1s;
}

.action-btn {
  background: var(--bg-header);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  font-size: 14px;
  cursor: pointer;
  color: var(--text-dim);
  line-height: 1;
}

.action-btn:hover {
  background: var(--bg-msg-hover);
  color: var(--text);
}

.reaction-picker {
  display: flex;
  gap: 4px;
  background: var(--bg-header);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 8px;
  margin-top: 4px;
  position: absolute;
  z-index: 10;
}

.reaction-option {
  font-size: 18px;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  transition: background 0.1s;
}

.reaction-option:hover {
  background: var(--bg-msg-hover);
}
</style>
