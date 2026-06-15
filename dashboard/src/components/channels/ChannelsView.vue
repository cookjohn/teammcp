<script setup>
import { ref, computed, inject, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatTime } from '../../utils/format'

const apiKey = inject('apiKey')
const { t } = useI18n()

const channels = ref([])
const agents = ref([])
const loading = ref(true)
const showArchived = ref(false)
const error = ref('')

const PROTECTED = new Set(['general', 'teammcp-dev'])

async function req(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey.value },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status))
  return data
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [chRes, agRes] = await Promise.all([
      req('GET', '/api/channels/manage'),
      req('GET', '/api/agents'),
    ])
    channels.value = chRes.channels || []
    agents.value = (agRes.agents || agRes || []).map(a => a.name).filter(Boolean)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
onMounted(load)

const activeChannels = computed(() => channels.value.filter(c => !c.archived_at))
const archivedChannels = computed(() => channels.value.filter(c => c.archived_at))

// ── Create ───────────────────────────────────────────────
const showCreate = ref(false)
const newCh = ref({ name: '', type: 'group', description: '', category: '', members: '' })
const createBusy = ref(false)
function openCreate() {
  newCh.value = { name: '', type: 'group', description: '', category: '', members: '' }
  error.value = ''
  showCreate.value = true
}
async function doCreate() {
  if (!newCh.value.name.trim()) { error.value = t('chanAdmin.nameLabel') + ' ?'; return }
  createBusy.value = true
  error.value = ''
  try {
    const members = newCh.value.members.split(',').map(s => s.trim()).filter(Boolean)
    await req('POST', '/api/channels', {
      name: newCh.value.name.trim(),
      type: newCh.value.type,
      description: newCh.value.description.trim(),
      category: newCh.value.category.trim() || undefined,
      members,
    })
    showCreate.value = false
    await load()
  } catch (e) {
    error.value = t('chanAdmin.createFailed') + ': ' + e.message
  } finally {
    createBusy.value = false
  }
}

// ── Edit ─────────────────────────────────────────────────
const showEdit = ref(false)
const editCh = ref(null)
const editBusy = ref(false)
function openEdit(ch) {
  editCh.value = { id: ch.id, name: ch.name || '', description: ch.description || '', category: ch.category || '' }
  error.value = ''
  showEdit.value = true
}
async function doEdit() {
  editBusy.value = true
  error.value = ''
  try {
    await req('PATCH', '/api/channels/' + encodeURIComponent(editCh.value.id), {
      name: editCh.value.name,
      description: editCh.value.description,
      category: editCh.value.category.trim() || null,
    })
    showEdit.value = false
    await load()
  } catch (e) {
    error.value = t('chanAdmin.editFailed') + ': ' + e.message
  } finally {
    editBusy.value = false
  }
}

// ── Archive / Unarchive ──────────────────────────────────
async function archive(ch) {
  try { await req('POST', '/api/channels/' + encodeURIComponent(ch.id) + '/archive'); await load() }
  catch (e) { error.value = e.message }
}
async function unarchive(ch) {
  try { await req('DELETE', '/api/channels/' + encodeURIComponent(ch.id) + '/archive'); await load() }
  catch (e) { error.value = e.message }
}

// ── Hard delete ──────────────────────────────────────────
async function hardDelete(ch) {
  const msg = t('chanAdmin.confirmDeletePrefix') + ' "' + (ch.name || ch.id) + '" '
    + t('chanAdmin.confirmDeleteSuffix')
  if (!window.confirm(msg)) return
  try {
    await req('DELETE', '/api/channels/' + encodeURIComponent(ch.id))
    await load()
  } catch (e) {
    error.value = t('chanAdmin.deleteFailed') + ': ' + e.message
  }
}

// ── Members ──────────────────────────────────────────────
const showMembers = ref(false)
const membersCh = ref(null)
const memberList = ref([])
const addAgent = ref('')
const membersBusy = ref(false)
async function openMembers(ch) {
  membersCh.value = ch
  addAgent.value = ''
  error.value = ''
  showMembers.value = true
  await loadMembers()
}
async function loadMembers() {
  membersBusy.value = true
  try {
    const r = await req('GET', '/api/channels/' + encodeURIComponent(membersCh.value.id) + '/members')
    memberList.value = r.members || []
  } catch (e) { error.value = e.message } finally { membersBusy.value = false }
}
async function addMember() {
  if (!addAgent.value) return
  try {
    await req('POST', '/api/channels/' + encodeURIComponent(membersCh.value.id) + '/members', { agent_name: addAgent.value })
    addAgent.value = ''
    await loadMembers()
  } catch (e) { error.value = e.message }
}
async function removeMember(name) {
  try {
    await req('DELETE', '/api/channels/' + encodeURIComponent(membersCh.value.id) + '/members/' + encodeURIComponent(name))
    await loadMembers()
  } catch (e) { error.value = e.message }
}
const addableAgents = computed(() => agents.value.filter(a => !memberList.value.includes(a)))

function fmt(ts) { return ts ? formatTime(ts) : t('chanAdmin.never') }
</script>

<template>
  <div class="chan-admin">
    <div class="ca-header">
      <h3>{{ t('chanAdmin.title') }}</h3>
      <div class="ca-header-actions">
        <label class="ca-toggle">
          <input type="checkbox" v-model="showArchived" />
          {{ t('chanAdmin.showArchived') }}
        </label>
        <button class="ca-btn primary" @click="openCreate">{{ t('chanAdmin.newChannel') }}</button>
      </div>
    </div>

    <div v-if="error" class="ca-error">{{ error }}</div>
    <div v-if="loading" class="ca-loading">{{ t('chanAdmin.loading') }}</div>

    <template v-else>
      <table class="ca-table">
        <thead>
          <tr>
            <th>{{ t('chanAdmin.name') }}</th>
            <th>{{ t('chanAdmin.type') }}</th>
            <th>{{ t('chanAdmin.category') }}</th>
            <th class="num">{{ t('chanAdmin.members') }}</th>
            <th class="num">{{ t('chanAdmin.messages') }}</th>
            <th>{{ t('chanAdmin.lastActivity') }}</th>
            <th>{{ t('chanAdmin.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ch in activeChannels" :key="ch.id">
            <td>
              <div class="ca-name">{{ ch.name || ch.id }}</div>
              <div class="ca-id">{{ ch.id }}</div>
            </td>
            <td><span class="ca-type">{{ ch.type }}</span></td>
            <td>{{ ch.category || t('chanAdmin.uncategorized') }}</td>
            <td class="num">{{ ch.member_count }}</td>
            <td class="num">{{ ch.message_count }}</td>
            <td class="ca-time">{{ fmt(ch.last_activity_at) }}</td>
            <td class="ca-actions">
              <button class="ca-link" @click="openEdit(ch)">{{ t('chanAdmin.edit') }}</button>
              <button class="ca-link" @click="openMembers(ch)">{{ t('chanAdmin.manageMembers') }}</button>
              <template v-if="PROTECTED.has(ch.id)">
                <span class="ca-protected">{{ t('chanAdmin.protected') }}</span>
              </template>
              <template v-else>
                <button class="ca-link warn" @click="archive(ch)">{{ t('chanAdmin.archive') }}</button>
                <button class="ca-link danger" @click="hardDelete(ch)">{{ t('chanAdmin.delete') }}</button>
              </template>
            </td>
          </tr>
          <tr v-if="activeChannels.length === 0">
            <td colspan="7" class="ca-empty">{{ t('chanAdmin.empty') }}</td>
          </tr>
        </tbody>
      </table>

      <template v-if="showArchived && archivedChannels.length">
        <h4 class="ca-section">{{ t('chanAdmin.archived') }} ({{ archivedChannels.length }})</h4>
        <table class="ca-table archived">
          <tbody>
            <tr v-for="ch in archivedChannels" :key="ch.id">
              <td>
                <div class="ca-name">{{ ch.name || ch.id }}</div>
                <div class="ca-id">{{ ch.id }} · {{ t('chanAdmin.archived') }} {{ fmt(ch.archived_at) }} · {{ ch.archived_by }}</div>
              </td>
              <td><span class="ca-type">{{ ch.type }}</span></td>
              <td>{{ ch.category || t('chanAdmin.uncategorized') }}</td>
              <td class="num">{{ ch.member_count }}</td>
              <td class="num">{{ ch.message_count }}</td>
              <td class="ca-time">{{ fmt(ch.last_activity_at) }}</td>
              <td class="ca-actions">
                <button class="ca-link" @click="unarchive(ch)">{{ t('chanAdmin.unarchive') }}</button>
                <button class="ca-link danger" @click="hardDelete(ch)">{{ t('chanAdmin.delete') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </template>

    <!-- Create modal -->
    <div v-if="showCreate" class="ca-modal-bg" @click.self="showCreate = false">
      <div class="ca-modal">
        <h4>{{ t('chanAdmin.newChannel') }}</h4>
        <label>{{ t('chanAdmin.nameLabel') }}</label>
        <input v-model="newCh.name" class="ca-input" />
        <label>{{ t('chanAdmin.typeLabel') }}</label>
        <select v-model="newCh.type" class="ca-input">
          <option value="group">group</option>
          <option value="topic">topic</option>
        </select>
        <label>{{ t('chanAdmin.catLabel') }}</label>
        <input v-model="newCh.category" class="ca-input" />
        <label>{{ t('chanAdmin.descLabel') }}</label>
        <input v-model="newCh.description" class="ca-input" />
        <label>{{ t('chanAdmin.membersLabel') }}</label>
        <input v-model="newCh.members" class="ca-input" placeholder="CEO, CTO" />
        <div class="ca-modal-actions">
          <button class="ca-btn" @click="showCreate = false">{{ t('chanAdmin.cancel') }}</button>
          <button class="ca-btn primary" :disabled="createBusy" @click="doCreate">{{ t('chanAdmin.create') }}</button>
        </div>
      </div>
    </div>

    <!-- Edit modal -->
    <div v-if="showEdit" class="ca-modal-bg" @click.self="showEdit = false">
      <div class="ca-modal">
        <h4>{{ t('chanAdmin.edit') }}: {{ editCh.id }}</h4>
        <label>{{ t('chanAdmin.nameLabel') }}</label>
        <input v-model="editCh.name" class="ca-input" />
        <label>{{ t('chanAdmin.catLabel') }}</label>
        <input v-model="editCh.category" class="ca-input" />
        <label>{{ t('chanAdmin.descLabel') }}</label>
        <input v-model="editCh.description" class="ca-input" />
        <div class="ca-modal-actions">
          <button class="ca-btn" @click="showEdit = false">{{ t('chanAdmin.cancel') }}</button>
          <button class="ca-btn primary" :disabled="editBusy" @click="doEdit">{{ t('chanAdmin.save') }}</button>
        </div>
      </div>
    </div>

    <!-- Members modal -->
    <div v-if="showMembers" class="ca-modal-bg" @click.self="showMembers = false">
      <div class="ca-modal">
        <h4>{{ t('chanAdmin.members') }}: {{ membersCh.name || membersCh.id }}</h4>
        <ul class="ca-member-list">
          <li v-for="m in memberList" :key="m">
            <span>{{ m }}</span>
            <button class="ca-link danger" @click="removeMember(m)">{{ t('chanAdmin.removeMember') }}</button>
          </li>
          <li v-if="memberList.length === 0" class="ca-empty">{{ t('chanAdmin.none') }}</li>
        </ul>
        <div class="ca-add-member">
          <select v-model="addAgent" class="ca-input">
            <option value="">{{ t('chanAdmin.selectAgent') }}</option>
            <option v-for="a in addableAgents" :key="a" :value="a">{{ a }}</option>
          </select>
          <button class="ca-btn primary" :disabled="!addAgent" @click="addMember">{{ t('chanAdmin.addMember') }}</button>
        </div>
        <div class="ca-modal-actions">
          <button class="ca-btn" @click="showMembers = false">{{ t('chanAdmin.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chan-admin { padding: 20px 24px; overflow-y: auto; }
.ca-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
.ca-header h3 { margin: 0; font-size: 16px; }
.ca-header-actions { display: flex; gap: 14px; align-items: center; }
.ca-toggle { font-size: 12px; color: var(--text-dim); display: flex; gap: 5px; align-items: center; cursor: pointer; }
.ca-error { background: rgba(220,50,50,.12); color: #e66; border: 1px solid rgba(220,50,50,.3); padding: 8px 12px; border-radius: var(--radius); margin-bottom: 12px; font-size: 13px; }
.ca-loading { color: var(--text-dim); padding: 20px; }
.ca-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ca-table th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--text-dim); font-weight: 500; font-size: 11px; text-transform: uppercase; }
.ca-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ca-table .num { text-align: right; }
.ca-table.archived { opacity: .7; }
.ca-name { font-weight: 600; }
.ca-id { font-size: 11px; color: var(--text-muted); }
.ca-type { font-size: 11px; padding: 2px 7px; border-radius: 10px; background: var(--bg-sidebar); border: 1px solid var(--border); }
.ca-time { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.ca-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.ca-link { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--accent); padding: 0; }
.ca-link:hover { text-decoration: underline; }
.ca-link.warn { color: #d98324; }
.ca-link.danger { color: #e25555; }
.ca-protected { font-size: 11px; color: var(--text-muted); }
.ca-empty { text-align: center; color: var(--text-dim); padding: 20px; }
.ca-section { margin: 24px 0 8px; font-size: 13px; color: var(--text-dim); }
.ca-btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: transparent; color: var(--text); cursor: pointer; font-size: 13px; }
.ca-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.ca-btn:disabled { opacity: .5; cursor: not-allowed; }
.ca-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.ca-modal { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; width: 380px; max-width: 90vw; }
.ca-modal h4 { margin: 0 0 14px; font-size: 14px; }
.ca-modal label { display: block; font-size: 11px; color: var(--text-dim); margin: 10px 0 4px; }
.ca-input { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-sidebar); color: var(--text); font-size: 13px; }
.ca-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.ca-member-list { list-style: none; padding: 0; margin: 0 0 12px; max-height: 200px; overflow-y: auto; }
.ca-member-list li { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.ca-add-member { display: flex; gap: 8px; align-items: center; }
.ca-add-member .ca-input { flex: 1; }
</style>
