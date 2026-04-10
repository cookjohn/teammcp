<script setup>
import { ref, computed, watch } from 'vue'
import { agentColor } from '../../utils/format.js'

const props = defineProps({
  agents: { type: Array, default: () => [] },
  query: { type: String, default: '' },
  visible: { type: Boolean, default: false }
})

const emit = defineEmits(['select', 'close'])

const selectedIndex = ref(0)

const filtered = computed(() => {
  if (!props.query) return props.agents
  const q = props.query.toLowerCase()
  return props.agents.filter(a =>
    a.name.toLowerCase().includes(q) ||
    (a.role && a.role.toLowerCase().includes(q))
  )
})

watch(() => props.query, () => {
  selectedIndex.value = 0
})

function onKeydown(e) {
  if (!props.visible) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, filtered.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
  } else if (e.key === 'Tab' || e.key === 'Enter') {
    e.preventDefault()
    if (filtered.value[selectedIndex.value]) {
      emit('select', filtered.value[selectedIndex.value])
    }
  } else if (e.key === 'Escape') {
    emit('close')
  }
}

defineExpose({ onKeydown })
</script>

<template>
  <div v-if="visible && filtered.length > 0" class="mention-dropdown">
    <div
      v-for="(agent, i) in filtered"
      :key="agent.name"
      class="mention-item"
      :class="{ selected: i === selectedIndex }"
      @mousedown.prevent="$emit('select', agent)"
      @mouseenter="selectedIndex = i"
    >
      <span class="status-dot" :class="agent.status === 'online' ? 'online' : 'offline'"></span>
      <span class="mention-name" :style="{ color: agentColor(agent.name) }">{{ agent.name }}</span>
      <span v-if="agent.role" class="mention-role">{{ agent.role }}</span>
    </div>
  </div>
</template>

<style scoped>
.mention-dropdown {
  position: absolute;
  bottom: 100%;
  left: 12px;
  width: 260px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-header);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 0;
  z-index: 20;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.1s;
}

.mention-item:hover,
.mention-item.selected {
  background: var(--bg-msg-hover);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.online {
  background: var(--green);
}

.status-dot.offline {
  background: var(--text-muted);
}

.mention-name {
  font-weight: 600;
}

.mention-role {
  color: var(--text-muted);
  font-size: 11px;
  margin-left: auto;
}
</style>
