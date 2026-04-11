<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({
  api: { type: Function, required: true }
})

const configs = ref([])
const loading = ref(true)
const saving = ref(false)
const testing = ref(null)
const testResult = ref(null)
const editing = ref(null) // purpose being edited
const editForm = ref({})

const PROVIDER_OPTIONS = ['anthropic', 'openai', 'openrouter', 'custom']

async function loadConfigs() {
  loading.value = true
  try {
    const data = await props.api('/api/config/llm')
    configs.value = data.configs || []
  } catch (err) {
    console.error('Failed to load LLM configs:', err)
  } finally {
    loading.value = false
  }
}

function startEdit(config) {
  editing.value = config.purpose
  editForm.value = {
    provider: config.provider,
    model: config.model,
    base_url: config.base_url || '',
    max_tokens: config.max_tokens || 1024,
    temperature: config.temperature ?? 0,
    timeout_ms: config.timeout_ms || 30000,
    max_daily_cost_usd: config.max_daily_cost_usd ?? 1.0,
    enabled: config.enabled !== 0,
    api_key: '' // blank = keep existing
  }
}

function cancelEdit() {
  editing.value = null
  editForm.value = {}
}

async function saveConfig() {
  saving.value = true
  try {
    const body = { purpose: editing.value, ...editForm.value }
    // Only send api_key if user entered one
    if (!body.api_key) delete body.api_key
    await props.api('/api/config/llm', {
      method: 'PUT',
      body: JSON.stringify(body)
    })
    await loadConfigs()
    editing.value = null
  } catch (err) {
    alert('Save failed: ' + err.message)
  } finally {
    saving.value = false
  }
}

async function testConnection(config) {
  testing.value = config.purpose
  testResult.value = null
  try {
    const body = {
      provider: editForm.value.provider || config.provider,
      model: editForm.value.model || config.model,
      api_key: editForm.value.api_key || undefined,
      base_url: editForm.value.base_url || config.base_url || undefined
    }
    const result = await props.api('/api/config/llm/test', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    testResult.value = { purpose: config.purpose, ...result }
  } catch (err) {
    testResult.value = { purpose: config.purpose, success: false, error: err.message }
  } finally {
    testing.value = null
  }
}

onMounted(() => loadConfigs())
</script>

<template>
  <div class="llm-config-panel">
    <div class="panel-header">
      <h3>LLM Configuration</h3>
      <p class="panel-desc">Configure LLM providers for memory classification, summarization, and queries.</p>
    </div>

    <div v-if="loading" class="loading">Loading configs...</div>

    <div v-else class="config-list">
      <div v-for="config in configs" :key="config.purpose" class="config-card">
        <div class="config-header">
          <div>
            <span class="purpose-label">{{ config.purpose }}</span>
            <span :class="['status-dot', config.enabled ? 'enabled' : 'disabled']"></span>
          </div>
          <button
            v-if="editing !== config.purpose"
            class="btn-sm"
            @click="startEdit(config)"
          >Edit</button>
        </div>

        <!-- Read-only view -->
        <div v-if="editing !== config.purpose" class="config-readonly">
          <div class="config-row">
            <span class="config-key">Provider</span>
            <span class="config-val">{{ config.provider }}</span>
          </div>
          <div class="config-row">
            <span class="config-key">Model</span>
            <span class="config-val">{{ config.model }}</span>
          </div>
          <div class="config-row">
            <span class="config-key">API Key</span>
            <span class="config-val">{{ config.api_key_masked || 'Not set' }}</span>
          </div>
          <div class="config-row">
            <span class="config-key">Max Cost/Day</span>
            <span class="config-val">${{ config.max_daily_cost_usd }}</span>
          </div>
        </div>

        <!-- Edit form -->
        <div v-else class="config-edit">
          <div class="form-group">
            <label>Provider</label>
            <select v-model="editForm.provider" class="form-input">
              <option v-for="p in PROVIDER_OPTIONS" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>Model</label>
            <input v-model="editForm.model" class="form-input" placeholder="claude-3-5-haiku-20241022" />
          </div>
          <div class="form-group">
            <label>API Key <span class="hint">(leave blank to keep existing)</span></label>
            <input v-model="editForm.api_key" type="password" class="form-input" placeholder="sk-..." />
          </div>
          <div v-if="editForm.provider !== 'anthropic'" class="form-group">
            <label>Base URL</label>
            <input v-model="editForm.base_url" class="form-input" placeholder="https://api.openai.com" />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Max Tokens</label>
              <input v-model.number="editForm.max_tokens" type="number" class="form-input" />
            </div>
            <div class="form-group">
              <label>Temperature</label>
              <input v-model.number="editForm.temperature" type="number" step="0.1" min="0" max="2" class="form-input" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Timeout (ms)</label>
              <input v-model.number="editForm.timeout_ms" type="number" class="form-input" />
            </div>
            <div class="form-group">
              <label>Max Cost/Day ($)</label>
              <input v-model.number="editForm.max_daily_cost_usd" type="number" step="0.1" class="form-input" />
            </div>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="editForm.enabled" />
              Enabled
            </label>
          </div>
          <div class="edit-actions">
            <button class="btn-sm" :disabled="saving" @click="saveConfig">
              {{ saving ? 'Saving...' : 'Save' }}
            </button>
            <button class="btn-sm btn-ghost" @click="testConnection(config)" :disabled="testing === config.purpose">
              {{ testing === config.purpose ? 'Testing...' : 'Test Connection' }}
            </button>
            <button class="btn-sm btn-ghost" @click="cancelEdit">Cancel</button>
          </div>
          <div v-if="testResult && testResult.purpose === config.purpose" :class="['test-result', testResult.success ? 'success' : 'error']">
            {{ testResult.success ? `OK (${testResult.latency_ms}ms)` : `Failed: ${testResult.error}` }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.llm-config-panel {
  padding: 20px 24px;
  overflow-y: auto;
  max-width: 720px;
}

.panel-header h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.panel-desc {
  color: var(--text-dim);
  font-size: 13px;
  margin: 0 0 20px;
}

.loading {
  color: var(--text-dim);
  padding: 20px;
}

.config-card {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 16px;
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.purpose-label {
  font-size: 14px;
  font-weight: 600;
  text-transform: capitalize;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 8px;
}

.status-dot.enabled { background: #3dd68c; }
.status-dot.disabled { background: #888; }

.config-readonly {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.config-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.config-key {
  color: var(--text-dim);
}

.config-val {
  font-weight: 500;
}

.config-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group label {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 500;
}

.hint {
  font-weight: 400;
  font-size: 11px;
}

.form-input {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 6px 10px;
  font-size: 13px;
  outline: none;
}

.form-input:focus {
  border-color: var(--accent);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row .form-group {
  flex: 1;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.edit-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.btn-sm {
  padding: 6px 14px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
}

.btn-sm:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-ghost {
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
}

.test-result {
  padding: 6px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  margin-top: 4px;
}

.test-result.success {
  background: rgba(61, 214, 140, 0.15);
  color: #3dd68c;
}

.test-result.error {
  background: rgba(229, 83, 75, 0.15);
  color: #e5534b;
}
</style>
