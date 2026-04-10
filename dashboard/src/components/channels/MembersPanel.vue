<script setup>
import { ref, computed } from 'vue'
import { agentColor, agentInitial } from '../../utils/format.js'

const props = defineProps({
  members: { type: Array, default: () => [] },
  agents: { type: Array, default: () => [] }
})

const emit = defineEmits(['close', 'addMember', 'removeMember'])

const showAddForm = ref(false)
const selectedAgent = ref('')

const availableAgents = computed(() => {
  const memberNames = new Set(props.members.map(m => m.name || m))
  return props.agents.filter(a => !memberNames.has(a.name))
})

function addMember() {
  if (!selectedAgent.value) return
  emit('addMember', selectedAgent.value)
  selectedAgent.value = ''
  showAddForm.value = false
}

function getMemberStatus(member) {
  const name = member.name || member
  const agent = props.agents.find(a => a.name === name)
  return agent?.status === 'online' ? 'online' : 'offline'
}

function getMemberName(member) {
  return member.name || member
}
</script>

<template>
  <div class="members-panel">
    <div class="members-header">
      <h3>Members ({{ members.length }})</h3>
      <button class="close-btn" @click="$emit('close')">✕</button>
    </div>

    <div class="members-list">
      <div v-for="member in members" :key="getMemberName(member)" class="member-item">
        <div class="member-avatar" :style="{ background: agentColor(getMemberName(member)) }">
          {{ agentInitial(getMemberName(member)) }}
        </div>
        <span class="member-name">{{ getMemberName(member) }}</span>
        <span class="status-dot" :class="getMemberStatus(member)"></span>
        <button
          class="remove-btn"
          @click="$emit('removeMember', getMemberName(member))"
          title="Remove member"
        >✕</button>
      </div>

      <div v-if="members.length === 0" class="empty-state">No members</div>
    </div>

    <!-- Add member -->
    <div class="add-section">
      <button v-if="!showAddForm" class="add-btn" @click="showAddForm = true">+ Add Member</button>
      <div v-else class="add-form">
        <select v-model="selectedAgent" class="agent-select">
          <option value="">Select agent...</option>
          <option v-for="agent in availableAgents" :key="agent.name" :value="agent.name">
            {{ agent.name }}
          </option>
        </select>
        <button class="action-btn confirm" @click="addMember" :disabled="!selectedAgent">Add</button>
        <button class="action-btn" @click="showAddForm = false">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.members-panel {
  width: 280px;
  border-left: 1px solid var(--border);
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.members-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.members-header h3 {
  font-size: 14px;
  font-weight: 700;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
}

.close-btn:hover {
  color: var(--text);
}

.members-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background 0.1s;
}

.member-item:hover {
  background: var(--bg-msg);
}

.member-item:hover .remove-btn {
  opacity: 1;
}

.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.member-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.remove-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s;
  padding: 2px 4px;
}

.remove-btn:hover {
  color: var(--red);
}

.empty-state {
  text-align: center;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}

.add-section {
  padding: 12px;
  border-top: 1px solid var(--border);
}

.add-btn {
  background: none;
  border: 1px dashed var(--border);
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 8px;
  font-size: 13px;
  cursor: pointer;
  width: 100%;
}

.add-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.add-form {
  display: flex;
  gap: 6px;
}

.agent-select {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 6px 8px;
  font-size: 12px;
  outline: none;
}

.agent-select:focus {
  border-color: var(--accent);
}

.action-btn {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.action-btn:hover {
  background: var(--bg-msg-hover);
  color: var(--text);
}

.action-btn.confirm {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.action-btn.confirm:hover {
  background: var(--accent-dim);
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
