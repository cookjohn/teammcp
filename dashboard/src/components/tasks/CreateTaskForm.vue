<script setup>
import { ref, inject } from 'vue'

const t = inject('t')
const tasksStore = inject('tasksStore')

const emit = defineEmits(['created', 'cancel'])

const title = ref('')
const status = ref('todo')
const priority = ref('medium')
const assignee = ref('')
const dueDate = ref('')
const loading = ref(false)
const error = ref('')

const PRIORITY_OPTIONS = ['urgent', 'high', 'medium', 'low']

async function create() {
  if (!title.value.trim()) {
    error.value = t('createTask.nameRequired')
    return
  }
  loading.value = true
  error.value = ''
  try {
    const fields = { title: title.value.trim(), status: status.value, priority: priority.value }
    if (assignee.value) fields.assignee = assignee.value
    if (dueDate.value) fields.due_date = dueDate.value
    await tasksStore.createTask(fields)
    emit('created')
  } catch (e) {
    error.value = t('createTask.failed')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="create-form">
    <div class="form-header">
      <h3>{{ t('createTask.title') }}</h3>
      <button class="btn-close" @click="emit('cancel')">&#10005;</button>
    </div>

    <div class="form-body">
      <!-- Title -->
      <div class="field">
        <label class="field-label">{{ t('createTask.titleLabel') }}</label>
        <input
          v-model="title"
          class="field-input"
          type="text"
          :placeholder="t('createTask.titlePlaceholder')"
          @keydown.enter="create"
        />
      </div>

      <!-- Priority -->
      <div class="field">
        <label class="field-label">{{ t('createTask.priority') }}</label>
        <select v-model="priority" class="field-select">
          <option v-for="p in PRIORITY_OPTIONS" :key="p" :value="p">{{ t('priority.' + p) }}</option>
        </select>
      </div>

      <!-- Assignee -->
      <div class="field">
        <label class="field-label">{{ t('createTask.assignee') }}</label>
        <input
          v-model="assignee"
          class="field-input"
          type="text"
          :placeholder="t('tasks.unassigned')"
        />
      </div>

      <!-- Due Date -->
      <div class="field">
        <label class="field-label">{{ t('createTask.dueDate') }}</label>
        <input v-model="dueDate" class="field-input" type="date" />
      </div>

      <!-- Error -->
      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>

    <div class="form-footer">
      <button class="btn-secondary" @click="emit('cancel')">{{ t('createTask.cancel') }}</button>
      <button class="btn-primary" :disabled="loading" @click="create">
        {{ loading ? '...' : t('createTask.create') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.create-form {
  background: var(--bg-sidebar);
  border-radius: var(--radius-lg);
  width: 420px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0,0,0,0.4);
}

.form-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-header h3 {
  font-size: 15px;
  font-weight: 700;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 4px;
  line-height: 1;
}

.btn-close:hover {
  color: var(--text);
}

.form-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.field-input,
.field-select {
  background: var(--bg-msg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
}

.field-input:focus,
.field-select:focus {
  outline: none;
  border-color: var(--accent);
}

.error-msg {
  color: var(--red);
  font-size: 12px;
}

.form-footer {
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn-secondary {
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary:hover {
  color: var(--text);
  background: var(--bg-msg);
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
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
