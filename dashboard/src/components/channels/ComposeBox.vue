<script setup>
import { ref, computed, nextTick } from 'vue'
import MentionDropdown from './MentionDropdown.vue'

const props = defineProps({
  agents: { type: Array, default: () => [] },
  replyTo: { type: Object, default: null },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['send', 'cancelReply'])

const textareaRef = ref(null)
const mentionRef = ref(null)
const content = ref('')
const mentionQuery = ref('')
const mentionVisible = ref(false)
const mentions = ref([])

// Track cursor position for @mention detection
let mentionStart = -1

const canSend = computed(() => content.value.trim().length > 0 && !props.disabled)

function onInput() {
  autoResize()
  detectMention()
}

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}

function detectMention() {
  const el = textareaRef.value
  if (!el) return
  const pos = el.selectionStart
  const text = content.value.slice(0, pos)
  const atIdx = text.lastIndexOf('@')

  if (atIdx >= 0 && (atIdx === 0 || text[atIdx - 1] === ' ' || text[atIdx - 1] === '\n')) {
    const query = text.slice(atIdx + 1)
    if (!query.includes(' ') && !query.includes('\n')) {
      mentionStart = atIdx
      mentionQuery.value = query
      mentionVisible.value = true
      return
    }
  }
  mentionVisible.value = false
}

function onMentionSelect(agent) {
  const before = content.value.slice(0, mentionStart)
  const after = content.value.slice(textareaRef.value.selectionStart)
  content.value = before + '@' + agent.name + ' ' + after
  mentions.value.push(agent.name)
  mentionVisible.value = false
  nextTick(() => {
    const pos = mentionStart + agent.name.length + 2
    textareaRef.value.setSelectionRange(pos, pos)
    textareaRef.value.focus()
  })
}

function onKeydown(e) {
  if (mentionVisible.value) {
    if (['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(e.key) || (e.key === 'Enter' && mentionVisible.value)) {
      mentionRef.value?.onKeydown(e)
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function send() {
  if (!canSend.value) return
  const text = content.value.trim()

  // Extract @mentions from text
  const foundMentions = [...new Set([
    ...mentions.value,
    ...(text.match(/@(\w+)/g) || []).map(m => m.slice(1))
  ])]

  emit('send', text, props.replyTo?.id || null, foundMentions)
  content.value = ''
  mentions.value = []
  nextTick(() => autoResize())
}
</script>

<template>
  <div class="compose-box">
    <!-- Reply bar -->
    <div v-if="replyTo" class="reply-bar">
      <span class="reply-label">Replying to <strong>{{ replyTo.from_agent }}</strong></span>
      <button class="reply-cancel" @click="$emit('cancelReply')">✕</button>
    </div>

    <div class="compose-row">
      <div class="textarea-wrapper">
        <MentionDropdown
          ref="mentionRef"
          :agents="agents"
          :query="mentionQuery"
          :visible="mentionVisible"
          @select="onMentionSelect"
          @close="mentionVisible = false"
        />
        <textarea
          ref="textareaRef"
          v-model="content"
          class="compose-textarea"
          placeholder="Type a message..."
          rows="1"
          :disabled="disabled"
          @input="onInput"
          @keydown="onKeydown"
        ></textarea>
      </div>
      <button
        class="send-btn"
        :disabled="!canSend"
        @click="send"
      >
        Send
      </button>
    </div>
  </div>
</template>

<style scoped>
.compose-box {
  border-top: 1px solid var(--border);
  background: var(--bg);
  padding: 12px 24px;
}

.reply-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  margin-bottom: 8px;
  background: var(--bg-msg);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--accent);
  font-size: 12px;
  color: var(--text-dim);
}

.reply-cancel {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.reply-cancel:hover {
  color: var(--text);
}

.compose-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.textarea-wrapper {
  flex: 1;
  position: relative;
}

.compose-textarea {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 10px 14px;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  min-height: 40px;
  max-height: 160px;
  line-height: 1.4;
}

.compose-textarea:focus {
  border-color: var(--accent);
}

.compose-textarea::placeholder {
  color: var(--text-muted);
}

.send-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-dim);
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
