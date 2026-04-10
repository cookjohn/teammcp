<script setup>
import { ref, inject, watch } from 'vue'
import { formatDate } from '../../utils/format.js'

const t = inject('t')
const tasksStore = inject('tasksStore')

const props = defineProps({
  task: { type: Object, required: true }
})
const emit = defineEmits(['updated', 'deleted'])

const saving = ref(false)
const deleting = ref(false)
const error = ref('')
const editResult = ref(props.task.result || '')
const editStatus = ref(props.task.status || 'todo')
const editPriority = ref(props.task.priority || 'medium')

watch(() => props.task, (t) => {
  editResult.value = t.result || ''
  editStatus.value = t.status || 'todo'
  editPriority.value = t.priority || 'medium'
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    await tasksStore.updateTask(props.task.id, {
      status: editStatus.value,
      priority: editPriority.value,
      result: editResult.value
    })
    emit('updated')
  } catch (e) {
    error.value = t('taskDetail.failedUpdate')
  } finally {
    saving.value = false
  }
}

async function deleteTask() {
  if (!confirm(t('taskDetail.confirmDelete'))) return
  deleting.value = true
  error.value = ''
  try {
    await tasksStore.deleteTask(props.task.id)
    emit('deleted')
  } catch (e) {
    error.value = t('taskDetail.failedDelete')
  } finally {
    deleting.value = false
  }
}

const STATUS_OPTIONS = ['todo', 'doing', 'done']
const PRIORITY_OPTIONS = ['urgent', 'high', 'medium', 'low']
</script>

<template>
  <div class="task-detail">
    <div class="detail-header">
      <h3>{{ t('taskDetail.title') }}</h3>
    </div>

    <div class="detail-body">
      <!-- Title -->
      <div class="field">
        <label class="field-label">{{ t('taskDetail.titleLabel') }}</label>
        <div class="field-value title-value">{{ task.title }}</div>
      </div>

      <!-- Status -->
      <div class="field">
        <label class="field-label">{{ t('taskDetail.status') }}</label>
        <select v-model="editStatus" class="field-select">
          <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">{{ t('tasks.' + s) }}</option>
        </select>
      </div>

      <!-- Priority -->
      <div class="field">
        <label class="field-label">{{ t('taskDetail.priority') }}</label>
        <select v-model="editPriority" class="field-select">
          <option v-for="p in PRIORITY_OPTIONS" :key="p" :value="p">{{ t('priority.' + p) }}</option>
        </select>
      </div>

      <!-- Assignee -->
      <div class="field">
        <label class="field-label">{{ t('taskDetail.assignee') }}</label>
        <div class="field-value">{{ task.assignee || t('tasks.unassigned') }}</div>
      </div>

      <!-- Due Date -->
      <div v-if="task.due_date" class="field">
        <label class="field-label">{{ t('taskDetail.dueDate') }}</label>
        <div class="field-value">{{ formatDate(task.due_date, t) }}</div>
      </div>

      <!-- Labels -->
      <div v-if="task.labels?.length" class="field">
        <label class="field-label">{{ t('taskDetail.labels') }}</label>
        <div class="labels">
          <span v-for="l in task.labels" :key="l" class="label-tag">{{ l }}</span>
        </div>
      </div>

      <!-- Result -->
      <div class="field">
        <label class="field-label">{{ t('taskDetail.result') }}</label>
        <textarea
          v-model="editResult"
          class="field-textarea"
          :placeholder="t('taskDetail.resultPlaceholder')"
          rows="3"
        ></textarea>
      </div>

      <!-- Creator -->
      <div class="field">
        <label class="field-label">{{ t('taskDetail.creator') }}</label>
        <div class="field-value">{{ task.creator || '—' }}</div>
      </div>

      <!-- Created -->
      <div class="field">
        <label class="field-label">{{ t('taskDetail.created') }}</label>
        <div class="field-value">{{ formatDate(task.created_at, t) }}</div>
      </div>

      <!-- Error -->
      <div v-if="error" class="error-msg">{{ error }}</div>

      <!-- Actions -->
      <div class="detail-actions">
        <button class="btn-primary" :disabled="saving" @click="save">
          {{ saving ? t('agentDetail.saving') : t('agentDetail.save') }}
        </button>
        <button class="btn-danger" :disabled="deleting" @click="deleteTask">
          {{ t('taskDetail.delete') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-header {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}

.detail-header h3 {
  font-size: 14px;
  font-weight: 700;
}

.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.field-value {
  font-size: 13px;
  color: var(--text);
}

.title-value {
  font-size: 15px;
  font-weight: 600;
}

.field-select {
  background: var(--bg-msg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
}

.field-textarea {
  background: var(--bg-msg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  resize: vertical;
  min-height: 70px;
  font-family: inherit;
}

.labels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.label-tag {
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}

.error-msg {
  color: var(--red);
  font-size: 12px;
}

.detail-actions {
  display: flex;
  gap: 10px;
  padding-top: 4px;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-danger {
  background: transparent;
  color: var(--red);
  border: 1px solid var(--red);
  border-radius: var(--radius);
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-danger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-danger:hover:not(:disabled) {
  background: rgba(229, 83, 75, 0.1);
}
</style>
