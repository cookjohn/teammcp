function switchToTasks() {
  currentView = 'tasks';
  // Hide all views and overlays
  document.getElementById('messages-container').style.display = 'none';
  document.getElementById('compose').classList.remove('active');
  document.getElementById('channel-header').style.display = 'none';
  document.getElementById('pin-bar').classList.remove('active');
  document.getElementById('pinned-panel').classList.remove('active');
  document.getElementById('state-container').classList.remove('active');
  document.getElementById('agents-container').classList.remove('active');
  closeAllOverlays();
  // Show tasks view
  document.getElementById('tasks-container').classList.add('active');
  // Update sidebar highlights
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  document.getElementById('tasks-nav').classList.add('active');
  // Populate assignee filter
  populateAssigneeFilter();
  loadTasks();
}

function switchToMessages() {
  if (currentView === 'messages') return;
  currentView = 'messages';
  // Hide all other views and overlays
  document.getElementById('tasks-container').classList.remove('active');
  document.getElementById('state-container').classList.remove('active');
  document.getElementById('agents-container').classList.remove('active');
  closeAllOverlays();
  // Show messages view
  document.getElementById('messages-container').style.display = '';
  document.getElementById('channel-header').style.display = '';
  updatePinBar();
  updateComposeUI();
  // Remove tasks/state/agents nav highlight
  document.getElementById('tasks-nav').classList.remove('active');
  document.getElementById('state-nav').classList.remove('active');
  document.getElementById('agents-nav').classList.remove('active');
}

function populateAssigneeFilter() {
  const select = document.getElementById('filter-assignee');
  const current = select.value;
  let html = '<option value="">All Assignees</option>';
  for (const a of agents) {
    html += '<option value="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</option>';
  }
  select.innerHTML = html;
  select.value = current;

  // Also populate create form assignee
  const ctSelect = document.getElementById('ct-assignee');
  let ctHtml = '<option value="">Unassigned</option>';
  for (const a of agents) {
    ctHtml += '<option value="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</option>';
  }
  ctSelect.innerHTML = ctHtml;
}

function applyTaskFilters() {
  loadTasks();
}

async function loadTasks() {
  const status = document.getElementById('filter-status').value;
  const assignee = document.getElementById('filter-assignee').value;
  let url = '/api/tasks?limit=50&sort=-priority';
  if (status) url += '&status=' + encodeURIComponent(status);
  if (assignee) url += '&assignee=' + encodeURIComponent(assignee);
  try {
    const data = await api(url);
    tasksList = data.tasks || [];
    tasksTotal = data.total || 0;
    renderTasks();
  } catch (e) {
    console.error('Failed to load tasks:', e);
    document.getElementById('tasks-list').innerHTML = '<div class="tasks-empty"><div class="icon">&#9888;</div><div>Failed to load tasks</div></div>';
  }
}

function renderTasks() {
  const container = document.getElementById('tasks-list');
  if (tasksList.length === 0) {
    container.innerHTML = '<div class="tasks-empty"><div class="icon">&#128203;</div><div>No tasks yet. Click <strong>+ New Task</strong> to create one.</div></div>';
    return;
  }
  let html = '';
  for (const task of tasksList) {
    html += renderTaskCard(task);
  }
  container.innerHTML = html;
}

function renderTaskCard(task) {
  const statusClass = 'status-' + (task.status || 'todo');
  const priorityClass = 'priority-' + (task.priority || 'medium');
  const statusLabel = (task.status || 'todo').toUpperCase();
  const priorityLabel = (task.priority || 'medium').charAt(0).toUpperCase() + (task.priority || 'medium').slice(1);

  let metaHtml = '';
  metaHtml += '<span class="status-badge ' + statusClass + '">' + statusLabel + '</span>';
  metaHtml += '<span class="priority-badge ' + priorityClass + '">' + escapeHtml(priorityLabel) + '</span>';

  if (task.assignee) {
    metaHtml += '<span class="task-assignee"><span class="agent-dot online" style="width:6px;height:6px;background:' + agentColor(task.assignee) + '"></span>' + escapeHtml(task.assignee) + '</span>';
  }

  if (task.due_date) {
    const isOverdue = new Date(task.due_date) < new Date() && task.status !== 'done';
    metaHtml += '<span class="task-due' + (isOverdue ? ' overdue' : '') + '">Due: ' + escapeHtml(task.due_date) + '</span>';
  }

  // File badge
  let fileBadge = '';
  const taskMeta = typeof task.metadata === 'string' ? (function() { try { return JSON.parse(task.metadata); } catch(e) { return null; } })() : task.metadata;
  if (taskMeta && Array.isArray(taskMeta.files) && taskMeta.files.length > 0) {
    fileBadge = '<span class="task-file-badge">\uD83D\uDCCE ' + taskMeta.files.length + '</span>';
  }

  return '<div class="task-card" onclick="showTaskDetail(\'' + escapeHtml(task.id) + '\')">' +
    '<div class="task-card-body">' +
      '<div class="task-card-title">' + escapeHtml(task.title) + fileBadge + '</div>' +
      '<div class="task-card-meta">' + metaHtml + '</div>' +
    '</div>' +
  '</div>';
}

async function showTaskDetail(taskId) {
  try {
    const data = await api('/api/tasks/' + encodeURIComponent(taskId));
    const task = data.task;
    if (!task) return;
    currentTaskDetail = task;

    const statusClass = 'status-' + (task.status || 'todo');
    const priorityClass = 'priority-' + (task.priority || 'medium');

    let html = '';

    // Title
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Title</div>';
    html += '<div class="detail-value">' + escapeHtml(task.title) + '</div>';
    html += '</div>';

    // Status with action buttons
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Status</div>';
    html += '<div class="detail-actions">';
    ['todo', 'doing', 'done'].forEach(s => {
      const active = task.status === s ? ' active-status' : '';
      html += '<button class="' + active + '" onclick="updateTaskField(\'' + task.id + '\', \'status\', \'' + s + '\')">' + s.toUpperCase() + '</button>';
    });
    html += '</div>';
    html += '</div>';

    // Priority
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Priority</div>';
    html += '<div class="detail-value"><span class="priority-badge ' + priorityClass + '">' + escapeHtml((task.priority || 'medium').charAt(0).toUpperCase() + (task.priority || 'medium').slice(1)) + '</span></div>';
    html += '</div>';

    // Creator
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Creator</div>';
    html += '<div class="detail-value">' + escapeHtml(task.creator || '-') + '</div>';
    html += '</div>';

    // Assignee
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Assignee</div>';
    html += '<div class="detail-value">' + escapeHtml(task.assignee || 'Unassigned') + '</div>';
    html += '</div>';

    // Due date
    if (task.due_date) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Due Date</div>';
      html += '<div class="detail-value">' + escapeHtml(task.due_date) + '</div>';
      html += '</div>';
    }

    // Labels
    const labelsArr = Array.isArray(task.labels) ? task.labels : (typeof task.labels === 'string' && task.labels !== '[]' && task.labels.trim() ? JSON.parse(task.labels) : []);
    if (labelsArr.length > 0) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Labels</div>';
      html += '<div class="detail-value">' + escapeHtml(labelsArr.join(', ')) + '</div>';
      html += '</div>';
    }

    // Result
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Result</div>';
    html += '<textarea class="detail-result-input" id="detail-result" placeholder="Enter result..." onchange="updateTaskField(\'' + task.id + '\', \'result\', this.value)">' + escapeHtml(task.result || '') + '</textarea>';
    html += '</div>';

    // Sub-tasks
    if (task.sub_tasks && task.sub_tasks.length > 0) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Sub-tasks</div>';
      for (const sub of task.sub_tasks) {
        const subStatusClass = 'status-' + (sub.status || 'todo');
        html += '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;display:flex;align-items:center;gap:8px;">';
        html += '<span class="status-badge ' + subStatusClass + '" style="font-size:10px">' + (sub.status || 'todo').toUpperCase() + '</span>';
        html += '<span>' + escapeHtml(sub.title) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Files (from metadata)
    const detailMeta = typeof task.metadata === 'string' ? (function() { try { return JSON.parse(task.metadata); } catch(e) { return null; } })() : task.metadata;
    if (detailMeta && Array.isArray(detailMeta.files) && detailMeta.files.length > 0) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Files (\uD83D\uDCCE ' + detailMeta.files.length + ')</div>';
      html += '<div class="task-files-list">';
      for (const f of detailMeta.files) {
        html += '<div class="task-file-item">' + escapeHtml(f) + '</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Created at
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Created</div>';
    html += '<div class="detail-value" style="font-size:12px;color:var(--text-muted)">' + escapeHtml(task.created_at || '') + '</div>';
    html += '</div>';

    // Delete button
    html += '<button class="detail-delete-btn" onclick="confirmDeleteTask(\'' + task.id + '\')">Delete Task</button>';

    document.getElementById('detail-body').innerHTML = html;
    document.getElementById('task-detail').classList.add('active');
  } catch (e) {
    console.error('Failed to load task detail:', e);
    if (e.message && e.message.includes('403')) {
      alert('Permission denied: you cannot view this task.');
    }
  }
}

function closeTaskDetail() {
  currentTaskDetail = null;
  document.getElementById('task-detail').classList.remove('active');
}

async function updateTaskField(taskId, field, value) {
  try {
    const body = {};
    body[field] = value;
    const res = await fetch('/api/tasks/' + encodeURIComponent(taskId), {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 403) {
        alert('Permission denied: ' + (err.error || 'you cannot modify this field'));
        return;
      }
      throw new Error(err.error || 'Update failed');
    }
    // Refresh
    loadTasks();
    if (currentTaskDetail && currentTaskDetail.id === taskId) {
      showTaskDetail(taskId);
    }
  } catch (e) {
    console.error('Failed to update task:', e);
    alert('Failed to update: ' + e.message);
  }
}

async function confirmDeleteTask(taskId) {
  if (!confirm('Are you sure you want to delete this task?')) return;
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(taskId), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 403) {
        alert('Permission denied: ' + (err.error || 'only creator or managers can delete'));
        return;
      }
      throw new Error(err.error || 'Delete failed');
    }
    closeTaskDetail();
    loadTasks();
  } catch (e) {
    console.error('Failed to delete task:', e);
    alert('Failed to delete: ' + e.message);
  }
}

// ── Create Task Form ────────────────────────────────────────
function showCreateTaskForm() {
  populateAssigneeFilter();
  document.getElementById('ct-title').value = '';
  document.getElementById('ct-priority').value = 'medium';
  document.getElementById('ct-assignee').value = '';
  document.getElementById('ct-due-date').value = '';
  document.getElementById('create-task-overlay').classList.add('active');
  document.getElementById('ct-title').focus();
}

function hideCreateTaskForm() {
  document.getElementById('create-task-overlay').classList.remove('active');
}

async function submitCreateTask() {
  const title = document.getElementById('ct-title').value.trim();
  if (!title) {
    document.getElementById('ct-title').focus();
    return;
  }

  const body = { title: title };
  const priority = document.getElementById('ct-priority').value;
  if (priority) body.priority = priority;
  const assignee = document.getElementById('ct-assignee').value;
  if (assignee) body.assignee = assignee;
  const dueDate = document.getElementById('ct-due-date').value;
  if (dueDate) body.due_date = dueDate;

  const btn = document.getElementById('ct-submit');
  btn.disabled = true;
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 403) {
        alert('Permission denied: ' + (err.error || 'you cannot create tasks'));
        btn.disabled = false;
        return;
      }
      throw new Error(err.error || 'Create failed');
    }
    hideCreateTaskForm();
    loadTasks();
  } catch (e) {
    console.error('Failed to create task:', e);
    alert('Failed to create task: ' + e.message);
  }
  btn.disabled = false;
}

// Close create overlay on Escape or background click
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('create-task-overlay').classList.contains('active')) {
      hideCreateTaskForm();
    } else if (document.getElementById('state-field-detail').classList.contains('active')) {
      closeFieldDetail();
    } else if (document.getElementById('task-detail').classList.contains('active')) {
      closeTaskDetail();
    }
  }
});

document.getElementById('create-task-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('create-task-overlay')) {
    hideCreateTaskForm();
  }
});

// ── Long Message Collapse ────────────────────────────────
function toggleMsgCollapse(btn, e) {
  e.stopPropagation();
  const wrapper = btn.previousElementSibling;
  if (wrapper.classList.contains('collapsed')) {
    wrapper.classList.remove('collapsed');
    btn.textContent = 'Show less';
  } else {
    wrapper.classList.add('collapsed');
    btn.textContent = 'Show more';
  }
}

// ── Reactions ────────────────────────────────────────────
function renderReactions(msg) {
  const reactions = msg.reactions || [];
  if (reactions.length === 0) return '<div class="msg-reactions" data-msgid="' + msg.id + '"></div>';

  // Group by emoji
  const groups = {};
  for (const r of reactions) {
    if (!groups[r.emoji]) groups[r.emoji] = [];
    groups[r.emoji].push(r.agent_name);
  }

  let html = '<div class="msg-reactions" data-msgid="' + msg.id + '">';
  for (const [emoji, agents_list] of Object.entries(groups)) {
    const isMine = agents_list.includes(agentName);
    const mineClass = isMine ? ' mine' : '';
    const title = agents_list.join(', ');
    html += '<span class="reaction-chip' + mineClass + '" title="' + escapeHtml(title) + '" onclick="toggleReaction(\'' + msg.id + '\', \'' + emoji + '\', event)">';
    html += '<span class="r-emoji">' + emoji + '</span>';
    html += '<span class="r-count">' + agents_list.length + '</span>';
    html += '</span>';
  }
  html += '</div>';
  return html;
}

function toggleReactionPicker(msgId, e) {
  e.stopPropagation();
  // Close all other pickers
  document.querySelectorAll('.reaction-picker.active').forEach(p => {
    if (p.id !== 'picker-' + msgId) p.classList.remove('active');
  });
  const picker = document.getElementById('picker-' + msgId);
  picker.classList.toggle('active');
}

// Close reaction pickers when clicking elsewhere
document.addEventListener('click', () => {
  document.querySelectorAll('.reaction-picker.active').forEach(p => p.classList.remove('active'));
});

async function reactToMsg(msgId, emoji, e) {
  if (e) e.stopPropagation();
  // Close picker
  document.querySelectorAll('.reaction-picker.active').forEach(p => p.classList.remove('active'));

  // Check if already reacted — toggle
  const msg = messages.find(m => m.id === msgId);
  if (!msg) return;
  const reactions = msg.reactions || [];
  const existing = reactions.find(r => r.emoji === emoji && r.agent_name === agentName);

  try {
    if (existing) {
      await fetch('/api/messages/' + encodeURIComponent(msgId) + '/reactions/' + encodeURIComponent(emoji), {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + API_KEY }
      });
      msg.reactions = reactions.filter(r => !(r.emoji === emoji && r.agent_name === agentName));
    } else {
      await fetch('/api/messages/' + encodeURIComponent(msgId) + '/reactions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji })
      });
      if (!msg.reactions) msg.reactions = [];
      msg.reactions.push({ emoji, agent_name: agentName });
    }
    renderMessages(false);
  } catch (err) {
    console.error('Reaction failed:', err);
  }
}

function toggleReaction(msgId, emoji, e) {
  e.stopPropagation();
  reactToMsg(msgId, emoji, null);
}

// ── Pin Messages ──────────────────────────────────────────
async function loadPins(channelId) {
  if (!channelId) return;
  try {
    const data = await api('/api/channels/' + encodeURIComponent(channelId) + '/pins');
    pinnedMessages = data.pins || [];
    pinnedMsgIds = new Set(pinnedMessages.map(p => p.message_id));
    updatePinBar();
  } catch (err) {
    console.error('Failed to load pins:', err);
    pinnedMessages = [];
    pinnedMsgIds = new Set();
    updatePinBar();
  }
}

function updatePinBar() {
  const bar = document.getElementById('pin-bar');
  const count = document.getElementById('pin-count');
  if (pinnedMessages.length > 0) {
    bar.classList.add('active');
    count.textContent = pinnedMessages.length;
  } else {
    bar.classList.remove('active');
    document.getElementById('pinned-panel').classList.remove('active');
    pinnedPanelOpen = false;
  }
}

function togglePinnedPanel() {
  pinnedPanelOpen = !pinnedPanelOpen;
  const panel = document.getElementById('pinned-panel');
  if (pinnedPanelOpen) {
    renderPinnedPanel();
    panel.classList.add('active');
  } else {
    panel.classList.remove('active');
  }
}

function renderPinnedPanel() {
  const panel = document.getElementById('pinned-panel');
  if (pinnedMessages.length === 0) {
    panel.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:13px;">No pinned messages</div>';
    return;
  }
  let html = '';
  for (const p of pinnedMessages) {
    const color = agentColor(p.from_agent);
    html += '<div class="pinned-msg">';
    html += '<div class="pinned-msg-body">';
    html += '<div class="pinned-msg-sender" style="color:' + color + '">' + escapeHtml(p.from_agent) + '</div>';
    html += '<div class="pinned-msg-content">' + escapeHtml((p.content || '').slice(0, 150)) + '</div>';
    html += '</div>';
    html += '<button class="pinned-msg-unpin" onclick="unpinMsg(\'' + p.message_id + '\', event)" title="Unpin">&times;</button>';
    html += '</div>';
  }
  panel.innerHTML = html;
}

async function pinMsg(msgId, e) {
  if (e) e.stopPropagation();
  try {
    await fetch('/api/messages/' + encodeURIComponent(msgId) + '/pin', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: '{}'
    });
    await loadPins(currentChannel);
    renderMessages(false);
  } catch (err) {
    console.error('Pin failed:', err);
  }
}

async function unpinMsg(msgId, e) {
  if (e) e.stopPropagation();
  try {
    await fetch('/api/messages/' + encodeURIComponent(msgId) + '/pin', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    await loadPins(currentChannel);
    renderMessages(false);
    if (pinnedPanelOpen) renderPinnedPanel();
  } catch (err) {
    console.error('Unpin failed:', err);
  }
}

// ── State / Observability View ──────────────────────────────
