<script setup>
import { ref, inject, onMounted } from 'vue'
import TaskList from './TaskList.vue'
import TaskDetail from './TaskDetail.vue'
import CreateTaskForm from './CreateTaskForm.vue'

const t = inject('t')
const tasksStore = inject('tasksStore')

const showCreate = ref(false)

onMounted(() => {
  tasksStore.loadTasks()
})

function onTaskCreated() {
  showCreate.value = false
  tasksStore.loadTasks()
}

function onTaskSelected(taskId) {
  tasksStore.loadTaskDetail(taskId)
}

function onTaskUpdated() {
  tasksStore.loadTasks()
}

function onTaskDeleted() {
  tasksStore.loadTasks()
}
</script>

<template>
  <div class="tasks-view">
    <!-- Header -->
    <div class="view-header">
      <h2>{{ t('tasks.title') }}</h2>
      <button class="btn-primary" @click="showCreate = true">
        {{ t('tasks.newTask') }}
      </button>
    </div>

    <!-- Create Task Modal -->
    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <CreateTaskForm @created="onTaskCreated" @cancel="showCreate = false" />
    </div>

    <!-- Content: list + detail -->
    <div class="tasks-content">
      <TaskList
        :store="tasksStore"
        @select="onTaskSelected"
      />
      <TaskDetail
        v-if="tasksStore.currentDetail"
        :task="tasksStore.currentDetail"
        @updated="onTaskUpdated"
        @deleted="onTaskDeleted"
      />
      <div v-else class="task-detail-empty">
        <div class="empty-state">
          <div class="icon">&#128203;</div>
          <div>{{ t('channel.select') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tasks-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.view-header {
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
}

.view-header h2 {
  font-size: 15px;
  font-weight: 700;
  flex: 1;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:hover {
  opacity: 0.85;
}

.tasks-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.task-detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--text-muted);
  font-size: 14px;
  gap: 8px;
}

.empty-state .icon {
  font-size: 40px;
  opacity: 0.5;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
</style>
