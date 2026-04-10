<script setup>
import { inject } from 'vue'
import { formatDate } from '../../utils/format.js'

const t = inject('t')
const props = defineProps({
  store: { type: Object, required: true }
})
const emit = defineEmits(['select'])

const STATUS_OPTIONS = ['', 'todo', 'doing', 'done']

function statusLabel(status) {
  if (!status) return t('tasks.allStatus')
  return t('tasks.' + status)
}

function priorityLabel(priority) {
  return t('priority.' + (priority || 'medium'))
}

function priorityClass(priority) {
  return 'priority-' + (priority || 'medium')
}
</script>

<template>
  <div class="task-list">
    <!-- Filters -->
    <div class="filters">
      <select
        :value="store.filterStatus"
        @change="store.setFilter($event.target.value, undefined)"
        class="filter-select"
      >
        <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">
          {{ statusLabel(s) }}
        </option>
      </select>

      <select
        :value="store.filterAssignee"
        @change="store.setFilter(undefined, $event.target.value)"
        class="filter-select"
      >
        <option value="">{{ t('tasks.allAssignees') }}</option>
        <option v-for="a in store.assignees" :key="a" :value="a">
          {{ a || t('tasks.unassigned') }}
        </option>
      </select>

      <span class="task-count">{{ store.total }}</span>
    </div>

    <!-- Loading -->
    <div v-if="store.loading" class="loading">{{ t('tasks.loading') }}</div>

    <!-- Empty -->
    <div v-else-if="store.filteredTasks.length === 0" class="empty-state">
      <div class="icon">&#9744;</div>
      <div>{{ t('tasks.empty') }}</div>
    </div>

    <!-- List -->
    <ul v-else class="items">
      <li
        v-for="task in store.filteredTasks"
        :key="task.id"
        class="task-item"
        :class="{ selected: store.currentDetail?.id === task.id }"
        @click="emit('select', task.id)"
      >
        <div class="task-item-left">
          <span class="task-status-dot" :class="'status-' + (task.status || 'todo')"></span>
          <span class="task-title">{{ task.title }}</span>
        </div>
        <div class="task-item-right">
          <span class="task-priority" :class="priorityClass(task.priority)">
            {{ priorityLabel(task.priority) }}
          </span>
          <span v-if="task.due_date" class="task-due">
            {{ formatDate(task.due_date, t) }}
          </span>
          <span v-if="task.assignee" class="task-assignee">{{ task.assignee }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.task-list {
  width: 360px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.filters {
  padding: 12px 16px;
  display: flex;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--border);
}

.filter-select {
  flex: 1;
  background: var(--bg-msg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}

.task-count {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.loading {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.items {
  flex: 1;
  overflow-y: auto;
  list-style: none;
  padding: 0;
  margin: 0;
}

.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  gap: 8px;
  transition: background 0.1s;
}

.task-item:hover {
  background: var(--bg-msg);
}

.task-item.selected {
  background: var(--bg-msg);
  border-left: 3px solid var(--accent);
}

.task-item-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.task-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-todo { background: var(--text-muted); }
.status-doing { background: var(--accent); }
.status-done { background: var(--green); }

.task-title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-item-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.task-priority {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 600;
}

.priority-urgent { background: #e5534b33; color: #e5534b; }
.priority-high { background: #d4843e33; color: #d4843e; }
.priority-medium { background: #5b7ff533; color: #5b7ff5; }
.priority-low { background: #57ab5a33; color: #57ab5a; }

.task-due {
  font-size: 11px;
  color: var(--text-muted);
}

.task-assignee {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-msg);
  padding: 2px 6px;
  border-radius: 10px;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  gap: 8px;
  padding: 40px 16px;
  text-align: center;
}

.empty-state .icon {
  font-size: 36px;
  opacity: 0.5;
}
</style>
