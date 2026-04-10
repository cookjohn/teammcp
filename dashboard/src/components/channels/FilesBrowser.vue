<script setup>
import { ref, watch, inject } from 'vue'
import { formatFileSize, formatTime } from '../../utils/format.js'

const props = defineProps({
  channelId: { type: String, required: true },
  api: { type: Function, required: true }
})

const emit = defineEmits(['close'])

const folders = ref([])
const files = ref([])
const loading = ref(false)
const currentFolderId = ref(null)
const folderPath = ref([]) // [{id, name}]
const newFolderName = ref('')
const showNewFolder = ref(false)
const renamingId = ref(null)
const renameValue = ref('')

// Watch for SSE file/folder change events to auto-refresh
const fileChangeCounter = inject('fileChangeCounter', ref(0))
watch(fileChangeCounter, () => {
  loadContents()
})

watch(() => props.channelId, () => {
  currentFolderId.value = null
  folderPath.value = []
  loadContents()
}, { immediate: true })

async function loadContents() {
  loading.value = true
  try {
    const folderId = currentFolderId.value
    const folderQuery = folderId ? `&parent_id=${encodeURIComponent(folderId)}` : ''
    const folderFileQuery = folderId ? `&folder_id=${encodeURIComponent(folderId)}` : ''

    const [foldersData, filesData] = await Promise.all([
      props.api(`/api/folders?channel=${encodeURIComponent(props.channelId)}${folderQuery}`).catch(() => []),
      props.api(`/api/files?channel=${encodeURIComponent(props.channelId)}${folderFileQuery}&limit=50`).catch(() => [])
    ])
    folders.value = foldersData || []
    files.value = (filesData?.files || filesData) || []
  } finally {
    loading.value = false
  }
}

function navigateToFolder(folder) {
  currentFolderId.value = folder.id
  folderPath.value.push({ id: folder.id, name: folder.name })
  loadContents()
}

function navigateToRoot() {
  currentFolderId.value = null
  folderPath.value = []
  loadContents()
}

function navigateToBreadcrumb(index) {
  const item = folderPath.value[index]
  currentFolderId.value = item.id
  folderPath.value = folderPath.value.slice(0, index + 1)
  loadContents()
}

async function createFolder() {
  if (!newFolderName.value.trim()) return
  try {
    await props.api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({
        channel: props.channelId,
        name: newFolderName.value.trim(),
        parent_id: currentFolderId.value
      })
    })
    newFolderName.value = ''
    showNewFolder.value = false
    loadContents()
  } catch (e) {
    console.error('Create folder failed:', e)
  }
}

async function renameFolder(folder) {
  if (!renameValue.value.trim()) return
  try {
    await props.api(`/api/folders/${encodeURIComponent(folder.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: renameValue.value.trim() })
    })
    renamingId.value = null
    renameValue.value = ''
    loadContents()
  } catch (e) {
    console.error('Rename failed:', e)
  }
}

async function deleteFolder(folder) {
  try {
    await props.api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })
    loadContents()
  } catch (e) {
    console.error('Delete folder failed:', e)
  }
}

function startRename(folder) {
  renamingId.value = folder.id
  renameValue.value = folder.name
}

function getDownloadUrl(file) {
  return `/api/files/${encodeURIComponent(file.id)}/download`
}
</script>

<template>
  <div class="files-browser">
    <div class="files-header">
      <h3>Files</h3>
      <button class="close-btn" @click="$emit('close')">✕</button>
    </div>

    <!-- Breadcrumbs -->
    <div class="breadcrumbs">
      <span class="breadcrumb-item" @click="navigateToRoot">Root</span>
      <template v-for="(item, i) in folderPath" :key="item.id">
        <span class="breadcrumb-sep">/</span>
        <span class="breadcrumb-item" @click="navigateToBreadcrumb(i)">{{ item.name }}</span>
      </template>
    </div>

    <!-- New folder -->
    <div class="actions-bar">
      <button v-if="!showNewFolder" class="new-folder-btn" @click="showNewFolder = true">+ New Folder</button>
      <div v-else class="new-folder-form">
        <input
          v-model="newFolderName"
          class="folder-input"
          placeholder="Folder name"
          @keydown.enter="createFolder"
          @keydown.escape="showNewFolder = false"
        />
        <button class="action-small-btn" @click="createFolder">Create</button>
        <button class="action-small-btn cancel" @click="showNewFolder = false">Cancel</button>
      </div>
    </div>

    <div v-if="loading" class="loading-state">Loading...</div>

    <div v-else class="files-list">
      <!-- Folders -->
      <div v-for="folder in folders" :key="folder.id" class="file-row folder-row">
        <template v-if="renamingId === folder.id">
          <span class="file-icon">📁</span>
          <input
            v-model="renameValue"
            class="folder-input inline"
            @keydown.enter="renameFolder(folder)"
            @keydown.escape="renamingId = null"
          />
          <button class="action-small-btn" @click="renameFolder(folder)">Save</button>
        </template>
        <template v-else>
          <span class="file-icon" @click="navigateToFolder(folder)">📁</span>
          <span class="file-name" @click="navigateToFolder(folder)">{{ folder.name }}</span>
          <div class="file-actions">
            <button class="action-small-btn" @click="startRename(folder)">Rename</button>
            <button class="action-small-btn delete" @click="deleteFolder(folder)">Del</button>
          </div>
        </template>
      </div>

      <!-- Files -->
      <div v-for="file in files" :key="file.id" class="file-row">
        <span class="file-icon">📄</span>
        <div class="file-info">
          <a :href="getDownloadUrl(file)" target="_blank" class="file-name link">{{ file.name || file.filename }}</a>
          <div class="file-meta">
            <span>{{ formatFileSize(file.size) }}</span>
            <span v-if="file.uploader"> &middot; {{ file.uploader }}</span>
            <span v-if="file.created_at"> &middot; {{ formatTime(file.created_at) }}</span>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="folders.length === 0 && files.length === 0" class="empty-state">
        No files or folders
      </div>
    </div>
  </div>
</template>

<style scoped>
.files-browser {
  width: 320px;
  border-left: 1px solid var(--border);
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.files-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.files-header h3 {
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

.breadcrumbs {
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
}

.breadcrumb-item {
  cursor: pointer;
  color: var(--accent);
}

.breadcrumb-item:hover {
  text-decoration: underline;
}

.breadcrumb-sep {
  color: var(--text-muted);
  margin: 0 2px;
}

.actions-bar {
  padding: 4px 16px 8px;
}

.new-folder-btn {
  background: none;
  border: 1px dashed var(--border);
  color: var(--text-dim);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  width: 100%;
}

.new-folder-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.new-folder-form {
  display: flex;
  gap: 6px;
  align-items: center;
}

.folder-input {
  flex: 1;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 4px 8px;
  font-size: 12px;
  outline: none;
}

.folder-input:focus {
  border-color: var(--accent);
}

.folder-input.inline {
  flex: 1;
  min-width: 0;
}

.action-small-btn {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.action-small-btn:hover {
  background: var(--bg-msg-hover);
  color: var(--text);
}

.action-small-btn.cancel {
  color: var(--text-muted);
}

.action-small-btn.delete {
  color: var(--red);
}

.loading-state {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.files-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background 0.1s;
}

.file-row:hover {
  background: var(--bg-msg);
}

.folder-row {
  cursor: pointer;
}

.file-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-name.link {
  color: var(--accent);
  text-decoration: none;
}

.file-name.link:hover {
  text-decoration: underline;
}

.file-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.file-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.empty-state {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
