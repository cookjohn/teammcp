<script setup>
import { ref, inject, computed } from 'vue'

const emit = defineEmits(['complete', 'enter'])
const t = inject('t', (k) => k)

// ── State ──────────────────────────────────────────────
const step = ref(1)
const error = ref('')
const wizardData = ref({
  // Step 2: config
  agentsDir: './agents',
  port: '3100',
  secret: '',
  // Step 3: profile
  userName: '',
  userRole: '',
  // Step 4: agent
  agentName: '',
  agentRole: '',
  authMode: 'oauth',
  apiProvider: '',
  apiBaseUrl: '',
  apiAuthToken: '',
  apiModel: '',
  // Step 5: result
  apiKey: '',
})

const totalSteps = 6

// ── Navigation ─────────────────────────────────────────
function next() {
  error.value = ''
  if (step.value === 3) {
    registerProfile()
  } else if (step.value === 4) {
    registerAgent()
  } else if (step.value === 5) {
    // Store key and emit complete
    if (wizardData.value.apiKey) {
      localStorage.setItem('teammcp_key', wizardData.value.apiKey)
    }
    emit('complete', wizardData.value.apiKey)
    step.value++
  } else if (step.value < totalSteps) {
    step.value++
  }
}

function back() {
  error.value = ''
  if (step.value > 1) step.value--
}

function skip() {
  error.value = ''
  if (step.value < totalSteps) step.value++
}

function enterDashboard() {
  emit('enter')
}

// ── Step 3: Register Profile ───────────────────────────
async function registerProfile() {
  const name = (wizardData.value.userName || t('wizard.defaultUserName')).trim()
  const role = (wizardData.value.userRole || t('wizard.defaultUserRole')).trim()

  if (!name) {
    error.value = t('wizard.nameRequired')
    return
  }
  if (!/^[A-Za-z0-9_\-]+$/.test(name)) {
    error.value = t('wizard.nameInvalid')
    return
  }

  try {
    const body = { name, role: role || undefined }
    if (wizardData.value.secret) body.secret = wizardData.value.secret

    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    wizardData.value.apiKey = data.api_key || data.apiKey || ''
    step.value++
  } catch (e) {
    error.value = t('wizard.registerFailed') + e.message
  }
}

// ── Step 4: Register Agent ─────────────────────────────
async function registerAgent() {
  const name = (wizardData.value.agentName || t('wizard.defaultAgentName')).trim()
  const role = (wizardData.value.agentRole || t('wizard.defaultAgentRole')).trim()

  if (!name) {
    error.value = t('wizard.nameRequired')
    return
  }
  if (!/^[A-Za-z0-9_\-]+$/.test(name)) {
    error.value = t('wizard.nameInvalid')
    return
  }

  try {
    const body = { name, role: role || undefined }
    if (wizardData.value.secret) body.secret = wizardData.value.secret

    const authHeader = wizardData.value.apiKey
      ? { 'Authorization': 'Bearer ' + wizardData.value.apiKey }
      : {}

    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }

    // If auth mode is api_key, PATCH agent config
    if (wizardData.value.authMode === 'api_key') {
      const patchBody = {
        auth_mode: 'api_key',
        api_provider: wizardData.value.apiProvider || undefined,
        api_base_url: wizardData.value.apiBaseUrl || undefined,
        api_auth_token: wizardData.value.apiAuthToken || undefined,
        model: wizardData.value.apiModel || undefined,
      }
      await fetch(`/api/agents/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(patchBody)
      })
    }

    step.value++
  } catch (e) {
    error.value = t('wizard.registerFailed') + e.message
  }
}

// ── Copy API key ───────────────────────────────────────
const copied = ref(false)
function copyKey() {
  if (wizardData.value.apiKey) {
    navigator.clipboard.writeText(wizardData.value.apiKey).then(() => {
      copied.value = true
      setTimeout(() => copied.value = false, 2000)
    })
  }
}
</script>

<template>
  <div class="wizard-overlay">
    <div class="wizard-card">
      <!-- Step indicators -->
      <div class="wizard-steps">
        <div
          v-for="s in totalSteps"
          :key="s"
          class="wizard-step-dot"
          :class="{ active: s === step, done: s < step }"
        >
          {{ s }}
        </div>
      </div>

      <!-- Error display -->
      <div v-if="error" class="wizard-error">{{ error }}</div>

      <!-- Step 1: Welcome -->
      <div v-if="step === 1" class="wizard-content">
        <div class="wizard-icon">&#x1F680;</div>
        <h2 class="wizard-title">{{ t('wizard.welcomeTitle') }}</h2>
        <p class="wizard-desc">{{ t('wizard.welcomeDesc') }}</p>
      </div>

      <!-- Step 2: Config -->
      <div v-if="step === 2" class="wizard-content">
        <h2 class="wizard-title">{{ t('wizard.configTitle') }}</h2>
        <p class="wizard-desc">{{ t('wizard.configDesc') }}</p>
        <div class="wizard-form">
          <label class="wizard-label">{{ t('wizard.agentsDir') }}</label>
          <input v-model="wizardData.agentsDir" class="wizard-input" />
          <label class="wizard-label">{{ t('wizard.port') }}</label>
          <input v-model="wizardData.port" class="wizard-input" />
          <label class="wizard-label">{{ t('wizard.secret') }}</label>
          <input v-model="wizardData.secret" class="wizard-input" :placeholder="t('wizard.secretPlaceholder')" />
        </div>
      </div>

      <!-- Step 3: Profile -->
      <div v-if="step === 3" class="wizard-content">
        <h2 class="wizard-title">{{ t('wizard.profileTitle') }}</h2>
        <p class="wizard-desc">{{ t('wizard.profileDesc') }}</p>
        <div class="wizard-form">
          <label class="wizard-label">{{ t('wizard.userName') }}</label>
          <input
            v-model="wizardData.userName"
            class="wizard-input"
            :placeholder="t('wizard.userNamePlaceholder')"
          />
          <label class="wizard-label">{{ t('wizard.userRole') }}</label>
          <input
            v-model="wizardData.userRole"
            class="wizard-input"
            :placeholder="t('wizard.userRolePlaceholder')"
          />
        </div>
      </div>

      <!-- Step 4: Configure Agent -->
      <div v-if="step === 4" class="wizard-content">
        <h2 class="wizard-title">{{ t('wizard.configAgentTitle') }}</h2>
        <p class="wizard-desc">{{ t('wizard.configAgentDesc') }}</p>
        <div class="wizard-form">
          <label class="wizard-label">{{ t('wizard.agentName') }}</label>
          <input
            v-model="wizardData.agentName"
            class="wizard-input"
            :placeholder="t('wizard.agentNamePlaceholder')"
          />
          <label class="wizard-label">{{ t('wizard.agentRole') }}</label>
          <input
            v-model="wizardData.agentRole"
            class="wizard-input"
            :placeholder="t('wizard.agentRolePlaceholder')"
          />
          <label class="wizard-label">{{ t('wizard.agentAuthMode') }}</label>
          <select v-model="wizardData.authMode" class="wizard-input">
            <option value="oauth">{{ t('wizard.authModeOauth') }}</option>
            <option value="api_key">{{ t('wizard.authModeApiKey') }}</option>
          </select>
          <template v-if="wizardData.authMode === 'api_key'">
            <label class="wizard-label">{{ t('wizard.apiProvider') }}</label>
            <input v-model="wizardData.apiProvider" class="wizard-input" />
            <label class="wizard-label">{{ t('wizard.apiBaseUrl') }}</label>
            <input v-model="wizardData.apiBaseUrl" class="wizard-input" />
            <label class="wizard-label">{{ t('wizard.apiAuthToken') }}</label>
            <input v-model="wizardData.apiAuthToken" class="wizard-input" type="password" />
            <label class="wizard-label">{{ t('wizard.apiModel') }}</label>
            <input v-model="wizardData.apiModel" class="wizard-input" />
          </template>
        </div>
      </div>

      <!-- Step 5: Complete -->
      <div v-if="step === 5" class="wizard-content">
        <h2 class="wizard-title">{{ t('wizard.completeTitle') }}</h2>
        <p class="wizard-desc">{{ t('wizard.completeDesc') }}</p>
        <div v-if="wizardData.apiKey" class="wizard-key-box" @click="copyKey">
          <div class="wizard-key-label">{{ t('wizard.apiKey') }}</div>
          <code class="wizard-key-value">{{ wizardData.apiKey }}</code>
          <div v-if="copied" class="wizard-copied">Copied!</div>
        </div>
        <p class="wizard-warn">{{ t('wizard.saveApiKey') }}</p>
        <div class="wizard-next-steps">
          <div class="wizard-next-label">{{ t('wizard.nextSteps') }}</div>
          <ul>
            <li>{{ t('wizard.stepInstall') }}</li>
            <li>{{ t('wizard.stepVisit').replace('{port}', wizardData.port || '3100') }}</li>
            <li>{{ t('wizard.stepShare') }}</li>
          </ul>
        </div>
      </div>

      <!-- Step 6: Tour -->
      <div v-if="step === 6" class="wizard-content">
        <h2 class="wizard-title">{{ t('wizard.tourTitle') }}</h2>
        <p class="wizard-desc">{{ t('wizard.tourDesc') }}</p>
        <div class="wizard-tour-grid">
          <div class="wizard-tour-card">
            <div class="wizard-tour-icon">#</div>
            <div class="wizard-tour-name">{{ t('wizard.tourChannels') }}</div>
            <div class="wizard-tour-text">{{ t('wizard.tourChannelsDesc') }}</div>
          </div>
          <div class="wizard-tour-card">
            <div class="wizard-tour-icon">&#x2611;</div>
            <div class="wizard-tour-name">{{ t('wizard.tourTasks') }}</div>
            <div class="wizard-tour-text">{{ t('wizard.tourTasksDesc') }}</div>
          </div>
          <div class="wizard-tour-card">
            <div class="wizard-tour-icon">&#x1F916;</div>
            <div class="wizard-tour-name">{{ t('wizard.tourAgents') }}</div>
            <div class="wizard-tour-text">{{ t('wizard.tourAgentsDesc') }}</div>
          </div>
          <div class="wizard-tour-card">
            <div class="wizard-tour-icon">&#x2699;</div>
            <div class="wizard-tour-name">{{ t('wizard.tourState') }}</div>
            <div class="wizard-tour-text">{{ t('wizard.tourStateDesc') }}</div>
          </div>
        </div>
      </div>

      <!-- Navigation buttons -->
      <div class="wizard-buttons">
        <button v-if="step > 1 && step < 6" class="wizard-btn wizard-btn-back" @click="back">
          {{ t('wizard.back') }}
        </button>
        <div class="wizard-btn-spacer"></div>
        <button v-if="step === 2 || step === 4" class="wizard-btn wizard-btn-skip" @click="skip">
          {{ t('wizard.skip') }}
        </button>
        <button v-if="step < 6" class="wizard-btn wizard-btn-next" @click="next">
          {{ t('wizard.next') }}
        </button>
        <button v-if="step === 6" class="wizard-btn wizard-btn-next" @click="enterDashboard">
          {{ t('wizard.enter') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.wizard-card {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px 36px;
  width: 500px;
  max-width: 95vw;
  max-height: 90vh;
  overflow-y: auto;
}

.wizard-steps {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-bottom: 24px;
}

.wizard-step-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  transition: all 0.2s;
}

.wizard-step-dot.active {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}

.wizard-step-dot.done {
  border-color: var(--green);
  background: var(--green);
  color: #fff;
}

.wizard-content {
  text-align: center;
  min-height: 200px;
}

.wizard-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.wizard-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 8px;
}

.wizard-desc {
  font-size: 14px;
  color: var(--text-dim);
  margin-bottom: 24px;
}

.wizard-form {
  text-align: left;
}

.wizard-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 4px;
  margin-top: 12px;
}

.wizard-label:first-child {
  margin-top: 0;
}

.wizard-input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 10px 14px;
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}

.wizard-input:focus {
  border-color: var(--accent);
}

.wizard-input::placeholder {
  color: var(--text-muted);
}

select.wizard-input {
  cursor: pointer;
  appearance: auto;
}

.wizard-error {
  background: rgba(229, 83, 75, 0.15);
  border: 1px solid var(--red);
  color: var(--red);
  border-radius: var(--radius);
  padding: 8px 14px;
  font-size: 13px;
  margin-bottom: 16px;
}

.wizard-key-box {
  background: rgba(61, 214, 140, 0.1);
  border: 1px solid var(--green);
  border-radius: var(--radius);
  padding: 16px;
  margin: 16px 0;
  cursor: pointer;
  position: relative;
  transition: background 0.15s;
}

.wizard-key-box:hover {
  background: rgba(61, 214, 140, 0.15);
}

.wizard-key-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--green);
  margin-bottom: 6px;
}

.wizard-key-value {
  font-size: 14px;
  color: var(--text);
  word-break: break-all;
  display: block;
}

.wizard-copied {
  position: absolute;
  top: 8px;
  right: 12px;
  font-size: 11px;
  color: var(--green);
  font-weight: 600;
}

.wizard-warn {
  font-size: 13px;
  color: var(--orange);
  margin-bottom: 16px;
}

.wizard-next-steps {
  text-align: left;
  margin-top: 16px;
}

.wizard-next-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.wizard-next-steps ul {
  list-style: disc;
  padding-left: 20px;
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.8;
}

.wizard-tour-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 8px;
  text-align: left;
}

.wizard-tour-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  transition: background 0.15s;
}

.wizard-tour-card:hover {
  background: var(--bg-msg-hover);
}

.wizard-tour-icon {
  font-size: 22px;
  margin-bottom: 6px;
}

.wizard-tour-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.wizard-tour-text {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
}

.wizard-buttons {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.wizard-btn-spacer {
  flex: 1;
}

.wizard-btn {
  padding: 8px 20px;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s;
}

.wizard-btn-back {
  background: transparent;
  color: var(--text-dim);
}

.wizard-btn-back:hover {
  background: var(--bg-msg);
  color: var(--text);
}

.wizard-btn-skip {
  background: transparent;
  color: var(--text-muted);
}

.wizard-btn-skip:hover {
  color: var(--text-dim);
}

.wizard-btn-next {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.wizard-btn-next:hover {
  background: var(--accent-dim);
}
</style>
