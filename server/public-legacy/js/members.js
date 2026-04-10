// ── Channel Members Panel ─────────────────────────────

function closeMembersPanel() {
  var el = document.getElementById('channel-members-panel');
  if (el) el.classList.remove('visible');
}

function closeAllOverlays() {
  var el;
  el = document.getElementById('channel-files-panel'); if (el) el.classList.remove('active');
  el = document.getElementById('create-agent-overlay'); if (el) el.classList.remove('active');
  el = document.getElementById('create-task-overlay'); if (el) el.classList.remove('active');
  closeMembersPanel();
  if (typeof closeAgentDetail === 'function') closeAgentDetail();
  if (typeof closeTaskDetail === 'function') closeTaskDetail();
  if (typeof closeFieldDetail === 'function') closeFieldDetail();
}

let currentMembersList = [];

function renderMembers(members) {
  currentMembersList = members;
  filterMembers();
}

function filterMembers() {
  const list = document.getElementById('channel-members-list');
  const searchInput = document.getElementById('members-search');
  const query = searchInput ? searchInput.value.toLowerCase() : '';
  const canManage = agentName === 'Chairman' || agentName === 'CEO';

  const memberObjs = currentMembersList.map(m => {
    const agent = agents.find(a => a.name === m);
    return { name: m, role: agent ? agent.role : '', status: agent ? agent.status : 'offline' };
  }).filter(m => !query || m.name.toLowerCase().includes(query) || (m.role && m.role.toLowerCase().includes(query)));

  const online = memberObjs.filter(m => m.status === 'online').sort((a, b) => a.name.localeCompare(b.name));
  const offline = memberObjs.filter(m => m.status !== 'online').sort((a, b) => a.name.localeCompare(b.name));

  const subtitle = document.getElementById('members-subtitle');
  if (subtitle) {
    subtitle.textContent = online.length + ' ' + i18n.t('agents.online').toLowerCase() + ', ' + offline.length + ' ' + i18n.t('agents.offline').toLowerCase();
  }

  let html = '';

  if (online.length > 0) {
    html += '<div class="members-group-title">' + i18n.t('agents.online') + ' (' + online.length + ')</div>';
    for (const m of online) {
      html += renderMemberItem(m, canManage);
    }
  }

  if (offline.length > 0) {
    html += '<div class="members-group-title">' + i18n.t('agents.offline') + ' (' + offline.length + ')</div>';
    for (const m of offline) {
      html += renderMemberItem(m, canManage);
    }
  }

  if (html === '') {
    html = '<div style="color:var(--text-dim);padding:12px;text-align:center;">' + i18n.t('members.noMembers') + '</div>';
  }

  list.innerHTML = html;
}

function renderMemberItem(m, canManage) {
  const removeBtn = canManage ? '<button class="remove-btn" onclick="event.stopPropagation(); removeMemberFromChannel(\'' + m.name.replace(/'/g, "\\'") + '\')">&times;</button>' : '';
  const roleHtml = m.role ? '<span class="member-role">' + escapeHtml(m.role) + '</span>' : '';
  const dotClass = m.status === 'online' ? 'online' : 'offline';
  return '<div class="member-item" onclick="openDmWithAgent(\'' + escapeHtml(m.name) + '\')" title="' + escapeHtml(m.name) + '">' +
    '<span class="agent-dot ' + dotClass + '"></span>' +
    '<span class="member-name">' + escapeHtml(m.name) + '</span>' +
    roleHtml +
    removeBtn +
    '</div>';
}

async function addMemberToChannel() {
  const select = document.getElementById('add-member-select');
  const name = select.value;
  if (!name || !currentChannel) return;
  try {
    const res = await fetch('/api/channels/' + encodeURIComponent(currentChannel) + '/members', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: name })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to add member'); return; }
    select.value = '';
    const btn = document.getElementById('add-member-btn');
    btn.textContent = '\u2713';
    btn.style.background = 'var(--green)';
    setTimeout(function() {
      btn.textContent = 'Add';
      btn.style.background = 'var(--accent)';
    }, 500);
    openMembersPanel();
  } catch (e) {
    alert('Failed to add member: ' + e.message);
  }
}

async function removeMemberFromChannel(name) {
  if (!currentChannel) return;
  if (!confirm(name + ' - ' + i18n.t('members.confirmRemove'))) return;
  try {
    const res = await fetch('/api/channels/' + encodeURIComponent(currentChannel) + '/members/' + encodeURIComponent(name), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed to remove member'); return; }
    openMembersPanel();
  } catch (e) {
    alert('Failed to remove member: ' + e.message);
  }
}

async function loadChangeLog(projectId, field) {
  try {
    const data = await api('/api/state/history?project_id=' + encodeURIComponent(projectId) + '&field=' + encodeURIComponent(field) + '&limit=20');
    return Array.isArray(data) ? data : (data.items || []);
  } catch (e) {
    console.error('Failed to load change log:', e);
    return [];
  }
}
