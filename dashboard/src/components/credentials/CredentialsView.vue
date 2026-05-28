<script setup>
import { ref, inject, computed, onMounted } from 'vue'
import { useCredentialsStore } from '../../stores/credentials'
import { formatTime, formatDate, agentColor } from '../../utils/format'

const api = inject('api')
const apiKey = inject('apiKey')
const t = inject('t')

const dashboardToken = ref('')
const loading = ref(false)
const refreshing = ref(false)

// OAuth re-login inline form state. Replaces window.prompt() because:
//  - Chrome blocks prompt() after the page calls window.open() in some
//    configurations (treated as "abusive popup chain")
//  - Users who once clicked "block dialogs from this site" never see
//    prompts again, with no obvious way to undo it
//  - prompts in background tabs (the Dashboard tab loses focus when the
//    OAuth tab opens) are easy to miss
// Inline form is always visible while waiting for the user to paste the
// callback URL — no browser policy can hide it.
const oauthPending = ref(false)
const oauthExpectedState = ref('')
const oauthPasted = ref('')
const oauthSubmitting = ref(false)
const oauthError = ref('')

// Dashboard token management — always fetches fresh token on first call,
// retries once on 403 (token rotates on server restart)
async function fetchDashboardToken() {
  try {
    const data = await api('/api/dashboard/token')
    const token = data.token || data.dashboardToken || data.access_token || ''
    dashboardToken.value = token
    if (token) sessionStorage.setItem('dashboardToken', token)
    return token
  } catch {
    dashboardToken.value = ''
    sessionStorage.removeItem('dashboardToken')
    return null
  }
}

async function ensureDashboardToken() {
  if (dashboardToken.value) return dashboardToken.value
  // Try sessionStorage first
  const stored = sessionStorage.getItem('dashboardToken')
  if (stored) {
    dashboardToken.value = stored
    return stored
  }
  return await fetchDashboardToken()
}

// credApi wrapper with 403 retry (handles stale token after server restart)
async function storeCredApi(path, options = {}) {
  let token = await ensureDashboardToken()
  if (!token) throw new Error('Unauthorized: dashboard token required')

  const url = path
  const headers = {
    'Authorization': 'Bearer ' + (typeof apiKey === 'object' ? apiKey.value : apiKey),
    'x-dashboard-token': token,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }

  let res = await fetch(url, { ...options, headers })

  // If 403, token may be stale — refresh and retry once
  if (res.status === 403) {
    dashboardToken.value = ''
    sessionStorage.removeItem('dashboardToken')
    token = await fetchDashboardToken()
    if (!token) throw new Error('Unauthorized: could not refresh dashboard token')
    headers['x-dashboard-token'] = token
    res = await fetch(url, { ...options, headers })
  }

  if (!res.ok) {
    let errMsg = 'API ' + res.status
    try { const body = await res.json(); if (body.error) errMsg = body.error } catch {}
    throw new Error(errMsg)
  }
  return res.json()
}

// Replace store's credApi with our wrapper
const localStore = useCredentialsStore(storeCredApi)

const leasesPage = ref(1)
const totalPages = computed(() => Math.ceil(localStore.leasesTotal.value / 50))

// ── Actions ───────────────────────────────────────────────
async function loadAll() {
  loading.value = true
  try {
    await localStore.refresh()
  } catch (e) {
    console.error('Credentials load failed:', e)
  }
  loading.value = false
}

async function refreshAll() {
  refreshing.value = true
  try {
    await localStore.refresh()
  } catch {}
  refreshing.value = false
}

async function switchStrategy(agentName, newStrategy) {
  try {
    await localStore.switchAuthStrategy(agentName, newStrategy)
  } catch (e) {
    alert('Switch failed: ' + e.message)
  }
}

async function revokeLease(leaseId) {
  if (!confirm('Revoke lease ' + leaseId.substring(0, 8) + '?')) return
  try {
    await localStore.revokeLease(leaseId)
  } catch (e) {
    alert('Revoke failed: ' + e.message)
  }
}

async function loadPage(page) {
  leasesPage.value = page
  await localStore.loadLeases(page)
}

async function refreshOAuth() {
  refreshing.value = true
  try {
    const token = await ensureDashboardToken()
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey.value, 'x-dashboard-token': token }
    })
    if (!res.ok) throw new Error('Refresh failed')
    await localStore.loadOverview()
  } catch (e) {
    alert('Token refresh failed: ' + e.message)
  }
  refreshing.value = false
}

async function startOAuthLogin() {
  oauthError.value = ''
  try {
    const token = await ensureDashboardToken()
    const res = await fetch('/api/auth/login/start', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey.value, 'x-dashboard-token': token }
    })
    const data = await res.json()
    const oauthUrl = data.authorizeUrl || data.url
    const expectedState = data.state
    if (!oauthUrl) {
      oauthError.value = 'OAuth login start failed: no authorizeUrl returned'
      return
    }
    // Stash state + reveal the inline paste form FIRST, then open the
    // OAuth tab. If we open the tab first the user might paste before
    // the form is rendered (race), and if window.open is blocked the
    // form still appears so the user can manually navigate.
    oauthExpectedState.value = expectedState || ''
    oauthPasted.value = ''
    oauthPending.value = true
    window.open(oauthUrl, '_blank')
  } catch (e) {
    oauthError.value = 'OAuth login failed: ' + e.message
  }
}

function cancelOAuthLogin() {
  oauthPending.value = false
  oauthExpectedState.value = ''
  oauthPasted.value = ''
  oauthError.value = ''
  oauthSubmitting.value = false
}

async function submitOAuthCode() {
  oauthError.value = ''
  const pasted = (oauthPasted.value || '').trim()
  if (!pasted) {
    oauthError.value = 'Please paste the callback URL or code first.'
    return
  }
  // Accept three input shapes:
  //   1. Full URL like https://platform.claude.com/oauth/code/callback?code=X&state=Y
  //   2. "code#state" (Anthropic sometimes presents it this way)
  //   3. Bare code (then we use the state we got from /login/start)
  let code = null
  let state = null
  try {
    if (pasted.includes('?') || pasted.includes('://')) {
      const u = new URL(pasted.replace(/^[^?]*\?/, 'https://x.invalid/?'))
      code = u.searchParams.get('code')
      state = u.searchParams.get('state')
    } else if (pasted.includes('#')) {
      const [c, s] = pasted.split('#')
      code = c
      state = s
    } else {
      code = pasted
      state = oauthExpectedState.value
    }
  } catch (parseErr) {
    oauthError.value = 'Could not parse the pasted value: ' + parseErr.message
    return
  }
  if (!code) {
    oauthError.value = 'No code found in the pasted value.'
    return
  }
  if (oauthExpectedState.value && state && state !== oauthExpectedState.value) {
    oauthError.value = 'OAuth state mismatch — login session may have expired. Click Re-login to restart.'
    return
  }
  oauthSubmitting.value = true
  try {
    const token = await ensureDashboardToken()
    const completeRes = await fetch('/api/auth/login/complete', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey.value,
        'x-dashboard-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code, state: state || oauthExpectedState.value }),
    })
    const completeData = await completeRes.json()
    if (!completeRes.ok || completeData.success === false) {
      oauthError.value = 'Login completion failed: ' + (completeData.error || ('HTTP ' + completeRes.status))
      return
    }
    // Success — clear the form and refresh the credential overview.
    cancelOAuthLogin()
    await localStore.loadOverview()
  } catch (e) {
    oauthError.value = 'Login completion failed: ' + e.message
  } finally {
    oauthSubmitting.value = false
  }
}

// ── Credential profiles ───────────────────────────────────
const PROVIDER_PRESETS = {
  anthropic:  'https://api.anthropic.com',
  openai:     'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  xiaomi:     'https://token-plan-cn.xiaomimimo.com/anthropic',
  minimax:    'https://api.minimaxi.com/anthropic',
  custom:     '',
}
const profiles = ref([])
const profilesLoading = ref(false)
const showProfileForm = ref(false)
const editingProfileId = ref(null)
const testingProfileId = ref(null)
const profileForm = ref({ name: '', provider: 'anthropic', base_url: '', auth_token: '', model: '' })
const profileError = ref('')

async function loadProfiles() {
  profilesLoading.value = true
  try {
    const data = await storeCredApi('/api/dashboard/credentials/profiles')
    profiles.value = data.profiles || []
  } catch (e) {
    console.error('Load profiles failed:', e)
  }
  profilesLoading.value = false
}

function openProfileForm(p) {
  profileError.value = ''
  if (p) {
    editingProfileId.value = p.id
    profileForm.value = { name: p.name, provider: p.provider, base_url: p.base_url, auth_token: '', model: p.model || '' }
  } else {
    editingProfileId.value = null
    profileForm.value = { name: '', provider: 'anthropic', base_url: PROVIDER_PRESETS.anthropic, auth_token: '', model: '' }
  }
  showProfileForm.value = true
}

function onProviderChange() {
  // Prefill base_url from preset only when empty or matching a known preset.
  const preset = PROVIDER_PRESETS[profileForm.value.provider]
  if (preset !== undefined && (!profileForm.value.base_url || Object.values(PROVIDER_PRESETS).includes(profileForm.value.base_url))) {
    profileForm.value.base_url = preset
  }
}

async function saveProfile() {
  profileError.value = ''
  const f = profileForm.value
  if (!f.name || !f.provider || !f.base_url) {
    profileError.value = t('credProfiles.requiredFields'); return
  }
  if (!editingProfileId.value && !f.auth_token) {
    profileError.value = t('credProfiles.tokenRequired'); return
  }
  try {
    if (editingProfileId.value) {
      const body = { name: f.name, provider: f.provider, base_url: f.base_url, model: f.model }
      if (f.auth_token) body.auth_token = f.auth_token  // rotate only if provided
      const r = await storeCredApi(`/api/dashboard/credentials/profiles/${editingProfileId.value}`, {
        method: 'PUT', body: JSON.stringify(body),
      })
      if (r.rotated && r.restartNeeded && r.restartNeeded.length) {
        alert(t('credProfiles.restartNeeded') + ' ' + r.restartNeeded.join(', '))
      }
    } else {
      await storeCredApi('/api/dashboard/credentials/profiles', {
        method: 'POST', body: JSON.stringify(f),
      })
    }
    showProfileForm.value = false
    await loadProfiles()
  } catch (e) {
    profileError.value = e.message
  }
}

async function deleteProfile(p) {
  if (p.agents_count > 0) { alert(t('credProfiles.inUse', { n: p.agents_count })); return }
  if (!confirm(t('credProfiles.confirmDelete', { name: p.name }))) return
  try {
    await storeCredApi(`/api/dashboard/credentials/profiles/${p.id}`, { method: 'DELETE' })
    await loadProfiles()
  } catch (e) {
    alert('Delete failed: ' + e.message)
  }
}

async function testProfile(p) {
  testingProfileId.value = p.id
  try {
    const r = await storeCredApi(`/api/dashboard/credentials/profiles/${p.id}/test`, { method: 'POST' })
    await loadProfiles()
    if (!r.ok) alert(t('credProfiles.testFail') + '\n' + (r.detail || ''))
  } catch (e) {
    alert('Test failed: ' + e.message)
  }
  testingProfileId.value = null
}

// ── SSE ───────────────────────────────────────────────────
const sse = inject('sse')
onMounted(() => {
  loadAll()
  loadProfiles()
})
</script>

<template>
  <div class="credentials-view">
    <div class="credentials-header">
      <h2>{{ t('credentials.title') }}</h2>
      <button class="refresh-btn" @click="refreshAll" :disabled="refreshing">&#128260;</button>
    </div>

    <div class="credentials-body">
      <!-- Overview Stats -->
      <div class="cred-overview-bar" v-if="localStore.overview.value">
        <div class="cred-stat-card">
          <div class="stat-value">{{ (localStore.overview.value.agents || []).length }}</div>
          <div class="stat-label">{{ t('credentials.agents') }}</div>
        </div>
        <div class="cred-stat-card green">
          <div class="stat-value">{{ (localStore.overview.value.agents || []).filter(a => a.auth_strategy === 'path_a').length }}</div>
          <div class="stat-label">{{ t('credentials.pathA') }}</div>
        </div>
        <div class="cred-stat-card orange">
          <div class="stat-value">{{ (localStore.overview.value.agents || []).filter(a => !a.auth_strategy || a.auth_strategy === 'legacy').length }}</div>
          <div class="stat-label">{{ t('credentials.legacy') }}</div>
        </div>
        <div class="cred-stat-card" v-if="localStore.overview.value.tokenStatus">
          <div class="stat-value" :style="{ color: localStore.overview.value.tokenStatus.isValid ? 'var(--green)' : 'var(--red)' }">
            {{ localStore.overview.value.tokenStatus.isValid ? t('credentials.connected') : t('credentials.disconnected') }}
          </div>
          <div class="stat-label">OAuth</div>
        </div>
      </div>

      <!-- Auth Strategy Table -->
      <div class="cred-section">
        <div class="section-title">{{ t('credentials.authStrategy') }}</div>
        <div v-if="!localStore.overview.value" class="cred-loading">{{ t('state.loading') }}</div>
        <table v-else-if="(localStore.overview.value.agents || []).length > 0" class="cred-table">
          <thead>
            <tr>
              <th>{{ t('credentials.agent') }}</th>
              <th>{{ t('credentials.role') }}</th>
              <th>{{ t('credentials.strategy') }}</th>
              <th>{{ t('credentials.status') }}</th>
              <th>{{ t('credentials.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="agent in (localStore.overview.value.agents || [])" :key="agent.name || agent.agent_id">
              <td>
                <span class="agent-name" :style="{ color: agentColor(agent.name || agent.agent_id) }">
                  {{ agent.name || agent.agent_id }}
                </span>
              </td>
              <td class="dim">{{ agent.role || '-' }}</td>
              <td>
                <span class="strategy-badge" :class="agent.auth_strategy === 'path_a' ? 'patha' : 'legacy'">
                  {{ agent.auth_strategy || 'legacy' }}
                </span>
              </td>
              <td>
                <span class="status-dot" :class="agent.status === 'online' ? 'online' : 'offline'"></span>
                {{ agent.status === 'online' ? t('credentials.online') : t('credentials.offline') }}
              </td>
              <td>
                <select
                  class="strategy-select"
                  :value="agent.auth_strategy || 'legacy'"
                  @change="switchStrategy(agent.name || agent.agent_id, $event.target.value)"
                >
                  <option value="legacy">{{ t('credentials.legacy') }}</option>
                  <option value="path_a">{{ t('credentials.pathA') }}</option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="cred-empty">{{ t('credentials.noLeases') }}</div>
      </div>

      <!-- API Key Profiles -->
      <div class="cred-section">
        <div class="section-title-row">
          <div class="section-title">{{ t('credProfiles.title') }}</div>
          <button class="cp-add-btn" @click="openProfileForm(null)">+ {{ t('credProfiles.add') }}</button>
        </div>

        <div v-if="profilesLoading" class="cred-loading">{{ t('state.loading') }}</div>
        <table v-else-if="profiles.length > 0" class="cred-table">
          <thead>
            <tr>
              <th>{{ t('credProfiles.name') }}</th>
              <th>{{ t('credProfiles.provider') }}</th>
              <th>{{ t('credProfiles.model') }}</th>
              <th>{{ t('credProfiles.token') }}</th>
              <th>{{ t('credProfiles.usedBy') }}</th>
              <th>{{ t('credProfiles.testStatus') }}</th>
              <th>{{ t('credentials.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in profiles" :key="p.id">
              <td><strong>{{ p.name }}</strong></td>
              <td class="dim">{{ p.provider }}</td>
              <td class="dim">{{ p.model || '-' }}</td>
              <td class="mono dim">{{ p.token_preview }}</td>
              <td>{{ p.agents_count }}</td>
              <td>
                <span v-if="p.last_test_status === 'ok'" class="cp-status ok" :title="p.last_tested_at">&#10003; {{ t('credProfiles.ok') }}</span>
                <span v-else-if="p.last_test_status === 'fail'" class="cp-status fail" :title="p.last_test_detail || ''">&#10007; {{ t('credProfiles.fail') }}</span>
                <span v-else class="cp-status untested">{{ t('credProfiles.untested') }}</span>
              </td>
              <td class="cp-actions">
                <button class="cp-btn" :disabled="testingProfileId === p.id" @click="testProfile(p)">
                  {{ testingProfileId === p.id ? t('credProfiles.testing') : t('credProfiles.test') }}
                </button>
                <button class="cp-btn" @click="openProfileForm(p)">{{ t('credProfiles.edit') }}</button>
                <button class="cp-btn danger" @click="deleteProfile(p)">{{ t('credProfiles.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="cred-empty">{{ t('credProfiles.empty') }}</div>

        <!-- Create / edit form -->
        <div v-if="showProfileForm" class="cp-form">
          <div class="cp-form-title">{{ editingProfileId ? t('credProfiles.editTitle') : t('credProfiles.addTitle') }}</div>
          <div class="cp-form-grid">
            <label>{{ t('credProfiles.name') }}
              <input v-model="profileForm.name" :placeholder="'xiaomi-mimo'" />
            </label>
            <label>{{ t('credProfiles.provider') }}
              <select v-model="profileForm.provider" @change="onProviderChange">
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="openrouter">openrouter</option>
                <option value="xiaomi">xiaomi</option>
                <option value="minimax">minimax</option>
                <option value="custom">custom</option>
              </select>
            </label>
            <label class="cp-wide">{{ t('credProfiles.baseUrl') }}
              <input v-model="profileForm.base_url" placeholder="https://..." />
            </label>
            <label class="cp-wide">{{ t('credProfiles.token') }}
              <input v-model="profileForm.auth_token" type="password"
                     :placeholder="editingProfileId ? t('credProfiles.tokenKeep') : 'sk-... / tp-...'" />
            </label>
            <label>{{ t('credProfiles.model') }}
              <input v-model="profileForm.model" placeholder="mimo-v2-pro" />
            </label>
          </div>
          <div v-if="profileError" class="cp-error">{{ profileError }}</div>
          <div class="cp-form-actions">
            <button class="cp-btn" @click="showProfileForm = false">{{ t('credProfiles.cancel') }}</button>
            <button class="cp-btn primary" @click="saveProfile">{{ t('credProfiles.save') }}</button>
          </div>
        </div>
      </div>

      <!-- Leases Table -->
      <div class="cred-section">
        <div class="section-title">{{ t('credentials.leases') }}</div>
        <div v-if="localStore.loading.value" class="cred-loading">{{ t('state.loading') }}</div>
        <table v-else-if="localStore.leases.value.length > 0" class="cred-table">
          <thead>
            <tr>
              <th>{{ t('credentials.leaseId') }}</th>
              <th>{{ t('credentials.agent') }}</th>
              <th>{{ t('credentials.issuedAt') }}</th>
              <th>{{ t('credentials.expiresAt') }}</th>
              <th>{{ t('credentials.status') }}</th>
              <th>{{ t('credentials.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lease in localStore.leases.value" :key="lease.lease_id || lease.id">
              <td class="lease-id">{{ (lease.lease_id || lease.id || '').substring(0, 8) }}</td>
              <td>
                <span class="agent-name" :style="{ color: agentColor(lease.agent) }">{{ lease.agent || '-' }}</span>
              </td>
              <td class="dim">{{ lease.leased_at ? formatDate(lease.leased_at, t) + ' ' + formatTime(lease.leased_at) : '-' }}</td>
              <td class="dim">{{ lease.expires_at ? formatDate(lease.expires_at, t) + ' ' + formatTime(lease.expires_at) : '-' }}</td>
              <td>
                <span class="status-dot" :class="lease.status === 'active' ? 'online' : (lease.status === 'revoked' ? 'offline' : 'warn')"></span>
                {{ lease.status === 'active' ? t('credentials.statusActive')
                   : lease.status === 'revoked' ? t('credentials.statusRevoked')
                   : lease.status === 'expired' ? t('credentials.statusExpired')
                   : t('credentials.statusUnknown') }}
              </td>
              <td>
                <button
                  v-if="lease.status === 'active'"
                  class="btn-revoke"
                  @click="revokeLease(lease.lease_id || lease.id)"
                >{{ t('credentials.revoke') }}</button>
                <span v-else class="dim">-</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="cred-empty">{{ t('credentials.noLeases') }}</div>

        <!-- Pagination -->
        <div v-if="localStore.leasesTotal.value > 50" class="leases-pagination">
          <span>{{ t('credentials.page') }} {{ leasesPage }} {{ t('credentials.of') }} {{ totalPages }} ({{ localStore.leasesTotal.value }} {{ t('credentials.total') }})</span>
          <button v-if="leasesPage > 1" class="btn-pagination" @click="loadPage(leasesPage - 1)">&larr;</button>
          <button v-if="leasesPage < totalPages" class="btn-pagination" @click="loadPage(leasesPage + 1)">&rarr;</button>
        </div>
      </div>

      <!-- TokenStore / OAuth Status Card -->
      <div class="cred-section">
        <div class="section-title">{{ t('credentials.tokenStore') }}</div>
        <div v-if="localStore.overview.value?.tokenStatus" class="tokenstore-card" :class="localStore.overview.value.tokenStatus.isValid ? 'ok' : 'bad'">
          <div class="tokenstore-status">
            <span class="status-dot" :class="localStore.overview.value.tokenStatus.isValid ? 'online' : 'offline'"></span>
            <span>{{ localStore.overview.value.tokenStatus.isValid ? t('credentials.connected') : t('credentials.disconnected') }}</span>
          </div>
          <div v-if="localStore.overview.value.tokenStatus.expiresAt" class="tokenstore-meta">
            {{ t('credentials.expires') }}: {{ new Date(localStore.overview.value.tokenStatus.expiresAt).toLocaleString() }}
            <span class="dim">({{ localStore.overview.value.tokenStatus.expiresIn }})</span>
          </div>
          <div v-if="localStore.overview.value.tokenStatus.lastRefresh" class="tokenstore-meta">
            {{ t('credentials.lastRefresh') }}: {{ formatDate(localStore.overview.value.tokenStatus.lastRefresh, t) }} {{ formatTime(localStore.overview.value.tokenStatus.lastRefresh) }}
          </div>
          <div class="tokenstore-actions">
            <button class="btn-token" @click="refreshOAuth" :disabled="refreshing">{{ t('credentials.refresh') }}</button>
            <button class="btn-token" @click="startOAuthLogin" :disabled="oauthPending">{{ t('credentials.reconnect') }}</button>
          </div>
          <!-- Inline OAuth completion form (shown after Re-login is clicked).
               Replaces the previous window.prompt() which was blocked by
               some browser configurations. -->
          <div v-if="oauthPending" class="oauth-paste-form">
            <p class="oauth-paste-hint">
              1. {{ t('credentials.oauthStep1') }}<br>
              2. {{ t('credentials.oauthStep2Prefix') }} <code>platform.claude.com/oauth/code/callback?code=...&state=...</code><br>
              3. <strong>{{ t('credentials.oauthStep3') }}</strong>
            </p>
            <input
              type="text"
              v-model="oauthPasted"
              class="oauth-paste-input"
              placeholder="https://platform.claude.com/oauth/code/callback?code=...&state=..."
              :disabled="oauthSubmitting"
              @keyup.enter="submitOAuthCode"
              autofocus
            />
            <div class="oauth-paste-actions">
              <button class="btn-token" @click="submitOAuthCode" :disabled="oauthSubmitting || !oauthPasted">
                {{ oauthSubmitting ? t('credentials.oauthSubmitting') : t('credentials.oauthSubmit') }}
              </button>
              <button class="btn-token btn-cancel" @click="cancelOAuthLogin" :disabled="oauthSubmitting">{{ t('credentials.cancel') }}</button>
            </div>
            <div v-if="oauthError" class="oauth-paste-error">{{ oauthError }}</div>
          </div>
        </div>
        <div v-else class="cred-loading">{{ t('state.loading') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.credentials-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.credentials-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.credentials-header h2 { font-size: 16px; font-weight: 700; }
.refresh-btn {
  margin-left: auto;
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}
.refresh-btn:hover { background: var(--bg-msg-hover); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.credentials-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Overview bar */
.cred-overview-bar { display: flex; gap: 16px; flex-wrap: wrap; }
.cred-stat-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 20px;
}
.cred-stat-card .stat-value { font-size: 22px; font-weight: 700; }
.cred-stat-card .stat-label { font-size: 12px; color: var(--text-dim); }
.cred-stat-card.green .stat-value { color: var(--green); }
.cred-stat-card.orange .stat-value { color: var(--orange); }

/* Sections */
.cred-section { }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}
.cred-loading, .cred-empty {
  color: var(--text-muted);
  font-size: 13px;
  padding: 12px 0;
}

/* Tables */
.cred-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.cred-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}
.cred-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.cred-table tr:hover td { background: var(--bg-msg-hover); }
.agent-name { font-weight: 600; }
.dim { color: var(--text-dim); font-size: 12px; }
.lease-id { font-family: monospace; font-size: 12px; }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  display: inline-block; margin-right: 6px;
}
.status-dot.online { background: var(--green); }
.status-dot.offline { background: var(--text-muted); }
.status-dot.warn { background: var(--orange); }

.strategy-badge {
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
}
.strategy-badge.patha {
  background: rgba(61,214,140,0.15);
  color: var(--green);
}
.strategy-badge.legacy {
  background: rgba(212,132,62,0.15);
  color: var(--orange);
}

.strategy-select {
  padding: 4px 8px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
}

.btn-revoke {
  padding: 4px 10px;
  background: rgba(229,83,75,0.15);
  color: var(--red);
  border: 1px solid rgba(229,83,75,0.3);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.btn-revoke:hover { background: rgba(229,83,75,0.25); }

/* Pagination */
.leases-pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  font-size: 12px;
  color: var(--text-dim);
}
.btn-pagination {
  padding: 4px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.btn-pagination:hover { background: var(--bg-msg-hover); }

/* TokenStore card */
.tokenstore-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}
.tokenstore-card.ok { border-left: 3px solid var(--green); }
.tokenstore-card.bad { border-left: 3px solid var(--red); }
.tokenstore-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.tokenstore-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.tokenstore-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.btn-token {
  padding: 6px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-token:hover { background: var(--bg-msg-hover); border-color: var(--accent); }
.btn-token:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-cancel { color: var(--text-dim); }
.oauth-paste-form {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-input);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
}
.oauth-paste-hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}
.oauth-paste-hint code {
  background: var(--bg-msg-hover);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
.oauth-paste-input {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
  font-family: monospace;
  box-sizing: border-box;
}
.oauth-paste-input:focus { outline: none; border-color: var(--accent); }
.oauth-paste-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.oauth-paste-error {
  margin-top: 8px;
  padding: 6px 10px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: var(--radius-sm);
  color: #ef4444;
  font-size: 12px;
}

/* ── Credential profiles ───────────────────────── */
.section-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.cp-add-btn {
  background: var(--accent); color: #fff; border: none; border-radius: var(--radius-sm);
  padding: 5px 12px; font-size: 13px; cursor: pointer;
}
.cp-add-btn:hover { background: var(--accent-dim); }
.mono { font-family: monospace; font-size: 12px; }
.cp-status { font-size: 12px; font-weight: 600; }
.cp-status.ok { color: var(--green, #22c55e); }
.cp-status.fail { color: var(--red, #ef4444); cursor: help; }
.cp-status.untested { color: var(--text-muted); font-weight: 400; }
.cp-actions { display: flex; gap: 6px; }
.cp-btn {
  background: var(--bg-msg); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text-dim); padding: 4px 10px; font-size: 12px; cursor: pointer;
}
.cp-btn:hover:not(:disabled) { background: var(--bg-msg-hover); color: var(--text); }
.cp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cp-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.cp-btn.danger:hover { color: var(--red, #ef4444); border-color: var(--red, #ef4444); }
.cp-form {
  margin-top: 12px; padding: 14px; background: var(--bg-msg);
  border: 1px solid var(--border); border-radius: var(--radius);
}
.cp-form-title { font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.cp-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cp-form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); }
.cp-form-grid label.cp-wide { grid-column: 1 / -1; }
.cp-form-grid input, .cp-form-grid select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text); padding: 7px 10px; font-size: 13px; font-family: inherit;
}
.cp-error { margin-top: 10px; color: #ef4444; font-size: 12px; }
.cp-form-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }
</style>
