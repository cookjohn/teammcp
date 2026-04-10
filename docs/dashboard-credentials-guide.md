# TeamMCP Dashboard -- Credential Management Frontend Implementation Guide

> Target audience: external developers (xiaomi/minimax)
> Last updated: 2026-04-09
> Author: B (Frontend Engineer)

---

## Table of Contents

1. [Dashboard Architecture Overview](#1-dashboard-architecture-overview)
2. [Existing Component Patterns](#2-existing-component-patterns)
3. [CSS Specification](#3-css-specification)
4. [Sidebar Routing / Navigation](#4-sidebar-routing--navigation)
5. [API Call Patterns](#5-api-call-patterns)
6. [Credential Management UI Design Guide](#6-credential-management-ui-design-guide)
7. [credentials.js Module Structure Suggestion](#7-credentialsjs-module-structure-suggestion)

---

## 1. Dashboard Architecture Overview

### Tech Stack

- **Pure Vanilla JS** -- no framework, no build tool, no bundler
- **Traditional `<script>` tags** -- NOT ES Modules, all files loaded via `<script src="js/xxx.js">` in `index.html`
- **Single-page application** -- one `index.html` entry point, view switching via CSS class toggling (`display: none` / `display: flex`)
- **CSS** -- single file `css/dashboard.css`, uses CSS custom properties (variables) for theming
- **i18n** -- custom `i18n` object in `js/i18n.js`, supports EN/ZH switching

### File Organization

```
server/public/
  index.html          -- Single HTML entry, contains ALL view containers and overlays
  css/
    dashboard.css     -- All styles (2000+ lines, single file)
  js/
    app.js            -- Core: global state, API helper, auth, SSE, init, utility functions
    channels.js       -- Channel list, message rendering, compose, reply, reactions, pins
    tasks.js          -- Tasks view: switchToTasks(), loadTasks(), renderTasks(), CRUD
    state.js          -- State/Observability view: switchToState(), fields, approvals, audit reports
    agents.js         -- Agent sidebar list, Agent Management view, agent CRUD, output viewer
    members.js        -- Channel members panel, closeAllOverlays()
    wechat.js         -- WeChat Bridge panel
    wizard.js         -- First-run setup wizard
    i18n.js           -- Internationalization dictionary and helper
```

### Script Load Order (in index.html)

```html
<script src="js/i18n.js"></script>   <!-- i18n dictionary, must be first -->
<script src="js/app.js"></script>     <!-- Core globals, api(), SSE, init() -->
<script src="js/channels.js"></script>
<script src="js/tasks.js"></script>
<script src="js/state.js"></script>
<script src="js/agents.js"></script>
<script src="js/members.js"></script>
<script src="js/wechat.js"></script>
<script src="js/wizard.js"></script>
```

**Key point:** All JS files share the global scope. Variables defined in `app.js` (like `API_KEY`, `agents`, `currentView`, `agentName`) are directly accessible from any other file. No import/export mechanism is used.

### Global State Variables (defined in app.js)

| Variable | Type | Description |
|----------|------|-------------|
| `API_KEY` | string | Current user's Bearer token |
| `currentChannel` | string | Currently selected channel ID |
| `channels` | array | All channels the user can see |
| `agents` | array | All registered agents |
| `messages` | array | Messages for the current channel |
| `currentView` | string | Active view: `'messages'`, `'tasks'`, `'state'`, `'agents'` |
| `agentName` | string | Current logged-in agent's name |

---

## 2. Existing Component Patterns

### Standard Page Module Structure

Every "view" module (tasks.js, state.js, agents.js) follows the same pattern:

#### a) Switch function -- activates the view

```js
function switchToXxx() {
  currentView = 'xxx';

  // 1. Hide all other views
  document.getElementById('messages-container').style.display = 'none';
  document.getElementById('compose').classList.remove('active');
  document.getElementById('channel-header').style.display = 'none';
  document.getElementById('pin-bar').classList.remove('active');
  document.getElementById('pinned-panel').classList.remove('active');
  document.getElementById('tasks-container').classList.remove('active');
  document.getElementById('state-container').classList.remove('active');
  document.getElementById('agents-container').classList.remove('active');
  closeAllOverlays();

  // 2. Show this view
  document.getElementById('xxx-container').classList.add('active');

  // 3. Update sidebar highlight
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  document.getElementById('xxx-nav').classList.add('active');

  // 4. Load data
  loadXxx();
}
```

#### b) Data loading function -- fetches from API

```js
async function loadXxx() {
  try {
    const data = await api('/api/xxx?param=value');
    xxxList = data.items || [];
    renderXxx();
  } catch (e) {
    console.error('Failed to load xxx:', e);
    document.getElementById('xxx-body').innerHTML =
      '<div class="xxx-empty">Failed to load</div>';
  }
}
```

#### c) Render function -- builds HTML string and sets innerHTML

```js
function renderXxx() {
  const container = document.getElementById('xxx-body');
  if (xxxList.length === 0) {
    container.innerHTML = '<div class="xxx-empty">...</div>';
    return;
  }
  let html = '';
  for (const item of xxxList) {
    html += renderXxxCard(item);
  }
  container.innerHTML = html;
}
```

#### d) Card/item renderer -- returns HTML string

```js
function renderXxxCard(item) {
  return '<div class="xxx-card" onclick="showXxxDetail(\'' + escapeHtml(item.id) + '\')">' +
    '<div class="xxx-card-title">' + escapeHtml(item.title) + '</div>' +
    '<div class="xxx-card-meta">' + escapeHtml(item.status) + '</div>' +
  '</div>';
}
```

### Key Conventions

1. **HTML is built as strings** -- no DOM creation APIs, no template literals with complex logic. String concatenation with `+` operator is the dominant pattern.
2. **`escapeHtml()`** -- always used for user-provided content to prevent XSS.
3. **Event handlers are inline** -- `onclick="functionName('param')"` in the HTML string.
4. **Detail panels** are fixed-position sidebars (right side, 420px wide) that slide in by adding `.active` class.
5. **Overlay forms** (create task, create agent) use a fixed full-screen backdrop with centered card.
6. **No virtual DOM, no diffing** -- full `innerHTML` replacement on every render.

### Helper Functions Available (from app.js)

| Function | Usage |
|----------|-------|
| `api(path)` | GET request with auth, returns parsed JSON |
| `escapeHtml(str)` | XSS-safe HTML escaping |
| `formatTime(iso)` | Returns `HH:MM` format |
| `formatDate(iso)` | Returns `Today` / `Yesterday` / `Mon DD, YYYY` |
| `agentColor(name)` | Deterministic color from agent name |
| `agentInitial(name)` | First letter uppercase |

---

## 3. CSS Specification

### CSS Variable System

All colors and theme values are defined as CSS custom properties on `:root` (dark theme) and `[data-theme="light"]` (light theme):

```css
:root {
  --bg: #0f1117;            /* Page background */
  --bg-sidebar: #161822;    /* Sidebar background */
  --bg-header: #1a1d2e;     /* Header and compose area */
  --bg-msg: #1e2133;        /* Card / message background */
  --bg-msg-hover: #252840;  /* Hover state for cards */
  --bg-input: #1a1d2e;      /* Input field background */
  --border: #2a2d3e;        /* All borders */
  --text: #e1e3eb;          /* Primary text */
  --text-dim: #8b8fa3;      /* Secondary text */
  --text-muted: #5c6078;    /* Tertiary / label text */
  --accent: #5b7ff5;        /* Primary brand color (blue) */
  --accent-dim: #3d5bd9;    /* Hover state for accent */
  --green: #3dd68c;         /* Success / online */
  --red: #e5534b;           /* Error / danger */
  --orange: #d4843e;        /* Warning */
  --yellow: #c9b44a;        /* Pending / WIP */
  --code-bg: #12141f;       /* Code block background */
  --radius: 8px;            /* Standard border-radius */
  --radius-sm: 4px;         /* Small border-radius */
}
```

### Theme Switching

Theme is toggled by setting `data-theme="light"` on `<html>`. The `toggleTheme()` function in app.js handles this. All CSS uses `var(--xxx)` references, so the theme switch is automatic.

### Style Naming Conventions

- **View containers**: `#xxx-container` (e.g., `#tasks-container`, `#state-container`, `#agents-container`)
- **View headers**: `#xxx-header`
- **View bodies**: `#xxx-body` or `#xxx-list`
- **Cards**: `.xxx-card` with `.xxx-card-title`, `.xxx-card-meta`
- **Detail panels**: `#xxx-detail` with `.detail-header`, `.detail-body`, `.detail-field`, `.detail-label`, `.detail-value`
- **Status badges**: `.status-badge .status-xxx` (e.g., `.status-todo`, `.status-doing`, `.status-done`)
- **Section titles**: `.xxx-section-title` -- 11px, uppercase, letter-spacing 0.5px, color `var(--text-muted)`
- **Empty state**: `.xxx-empty` centered flex container with icon and message

### Standard View Container CSS Pattern

```css
#xxx-container {
  display: none;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
#xxx-container.active { display: flex; }

#xxx-header {
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
}

#xxx-header h2 {
  font-size: 15px;
  font-weight: 700;
}

#xxx-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 24px;
}
```

### Standard Card CSS Pattern

```css
.xxx-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.xxx-card:hover {
  background: var(--bg-msg-hover);
  border-color: var(--accent);
}
```

### Standard Detail Panel CSS Pattern

```css
#xxx-detail {
  display: none;
  position: fixed;
  top: 0;
  right: 0;
  width: 420px;
  height: 100vh;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  z-index: 500;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0,0,0,0.3);
  overflow-y: auto;
}
#xxx-detail.active { display: flex; }
```

### Standard Overlay (Modal) CSS Pattern

```css
#xxx-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 1000;
  align-items: center;
  justify-content: center;
}
#xxx-overlay.active { display: flex; }

.xxx-card {  /* modal card inside overlay */
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: 440px;
  max-height: 80vh;
  overflow-y: auto;
}
```

### Standard Form Elements

```css
.form-group {
  margin-bottom: 14px;
}
.form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.form-group input, .form-group select {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.form-group input:focus, .form-group select:focus {
  border-color: var(--accent);
}
.form-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.btn-cancel {
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.btn-create {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  cursor: pointer;
}
```

---

## 4. Sidebar Routing / Navigation

### How views are structured

The Dashboard is a **single-page app** with multiple view containers inside `<div id="main">`. Only one is visible at a time:

| View | Container ID | Nav Element | Switch Function |
|------|-------------|-------------|-----------------|
| Messages (default) | `#messages-container` | `.channel-item` in `#channel-list` | `switchToMessages()` |
| Tasks | `#tasks-container` | `#tasks-nav` | `switchToTasks()` |
| State | `#state-container` | `#state-nav` | `switchToState()` |
| Agents | `#agents-container` | `#agents-nav` | `switchToAgents()` |

### Steps to add a new "Credentials" page

#### Step 1: Add sidebar navigation entry in `index.html`

Insert a new `<div class="sidebar-section">` block in `<div id="sidebar">`. Follow the existing pattern:

```html
<!-- Credentials -->
<div class="sidebar-section">
  <div class="sidebar-section-title">Credentials</div>
  <ul class="channel-list">
    <li class="channel-item" id="credentials-nav" onclick="switchToCredentials()">
      <span class="channel-icon">&#128274;</span>
      <span class="channel-name">Credential Vault</span>
    </li>
  </ul>
</div>
```

Recommended placement: **after the State section, before the Agents section**.

#### Step 2: Add view container in `index.html`

Inside `<div id="main">`, add the container alongside the existing ones:

```html
<!-- Credentials View -->
<div id="credentials-container">
  <div id="credentials-header">
    <h2>&#128274; Credentials</h2>
    <button class="credentials-refresh-btn" onclick="loadCredentials()">&#128260;</button>
    <button id="new-credential-btn" onclick="showCreateCredentialForm()">+ New Credential</button>
  </div>
  <div id="credentials-body">
    <div class="credentials-empty">
      <div class="icon">&#128274;</div>
      <div>Loading credentials...</div>
    </div>
  </div>
</div>
```

#### Step 3: Add detail panel in `index.html`

```html
<!-- Credential Detail Panel -->
<div id="credential-detail">
  <div class="detail-header">
    <h3>Credential Detail</h3>
    <button class="detail-close" onclick="closeCredentialDetail()">&times;</button>
  </div>
  <div class="detail-body" id="credential-detail-body"></div>
</div>
```

#### Step 4: Add create overlay in `index.html`

```html
<!-- Create Credential Overlay -->
<div id="create-credential-overlay">
  <div class="create-credential-card">
    <h3>Add New Credential</h3>
    <!-- form fields here -->
    <div class="form-buttons">
      <button class="btn-cancel" onclick="hideCreateCredentialForm()">Cancel</button>
      <button class="btn-create" onclick="submitCreateCredential()">Create</button>
    </div>
  </div>
</div>
```

#### Step 5: Add script tag in `index.html`

```html
<script src="js/credentials.js"></script>
```

Place it **after agents.js** and **before members.js** (or after members.js -- order within peer modules is not critical as long as it's after `app.js`).

#### Step 6: Update `switchToMessages()` and all other switch functions

In `tasks.js` (where `switchToMessages()` is defined), add:

```js
document.getElementById('credentials-container').classList.remove('active');
```

Similarly, update `switchToTasks()`, `switchToState()`, `switchToAgents()` to also hide `credentials-container`.

#### Step 7: Update `closeAllOverlays()` in `members.js`

Add:
```js
el = document.getElementById('create-credential-overlay'); if (el) el.classList.remove('active');
if (typeof closeCredentialDetail === 'function') closeCredentialDetail();
```

#### Step 8: Update `currentView` tracking

The `currentView` variable should accept a new value `'credentials'`. The SSE handler in `app.js` can optionally respond to credential-related events.

---

## 5. API Call Patterns

### GET requests -- use `api()` helper

The global `api(path)` function (defined in `app.js`) handles GET requests:

```js
async function api(path) {
  const res = await fetch(path, {
    headers: { 'Authorization': 'Bearer ' + API_KEY }
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}
```

Usage:
```js
const data = await api('/api/credentials?limit=50');
```

### POST/PATCH/DELETE -- use `fetch()` directly

For mutating requests, the codebase uses raw `fetch()`:

```js
const res = await fetch('/api/credentials', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ name: 'my-key', provider: 'anthropic', token: 'sk-...' })
});

if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  throw new Error(err.error || 'Create failed');
}

const result = await res.json();
```

### Error Handling Convention

```js
try {
  // ... API call
} catch (e) {
  console.error('Failed to xxx:', e);
  // For user-facing errors:
  alert('Failed to xxx: ' + e.message);
  // For non-critical UI updates:
  container.innerHTML = '<div class="xxx-empty">Failed to load: ' + escapeHtml(e.message) + '</div>';
}
```

### Permission (403) Handling

Several modules have specific 403 checks:

```js
if (res.status === 403) {
  alert('Permission denied: ' + (err.error || 'insufficient permissions'));
  return;
}
```

### Existing Backend Credential APIs (from router.mjs)

The backend already exposes these credential-related endpoints:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/status` | None | Get credential/OAuth status |
| POST | `/api/auth/login/start` | None | Start OAuth login session |
| POST | `/api/auth/login/complete` | None | Complete OAuth callback |
| POST | `/api/auth/refresh` | Bearer | Manually refresh OAuth token |
| GET | `/api/credentials/lease/:agent_name` | HMAC | Agent lease a credential |
| POST | `/api/credentials/lease/:agent_name/revoke` | HMAC | Revoke a lease |
| POST | `/api/credentials/busy/:agent_name/(acquire\|heartbeat\|release)` | HMAC | Busy-agent lock management |

**Note:** The `/api/credentials/lease/*` and `/api/credentials/busy/*` endpoints use HMAC Bearer auth (not the standard API key), as they are intended for agent-to-server communication. The Dashboard credential management page should primarily interact with `/api/auth/status` and `/api/auth/refresh`, plus any new CRUD endpoints you implement for credential vault management.

---

## 6. Credential Management UI Design Guide

### Recommended 3-zone Layout

The credential management page should follow the same pattern as the Agents view, using a **header + scrollable body** layout with three logical zones:

```
+--------------------------------------------------+
| [Header] Credentials  [Refresh] [+ New Credential]|
+--------------------------------------------------+
| Zone 1: Status Summary Bar                        |
|   [Total Credentials] [Active] [Expired] [OAuth]  |
+--------------------------------------------------+
| Zone 2: Credential Cards Grid                     |
|   +----------+ +----------+ +----------+          |
|   | Anthro.. | | OpenAI.. | | Custom.. |          |
|   | sk-***4a | | sk-***b2 | | token... |          |
|   | Active   | | Expired  | | Active   |          |
|   +----------+ +----------+ +----------+          |
+--------------------------------------------------+
| Zone 3: OAuth Status Panel                        |
|   Status: Connected | Last Refresh: 10:32         |
|   [Refresh Token] [Login/Re-login]                |
+--------------------------------------------------+
```

### Zone 1: Status Summary Bar

Follow the pattern from `state.js` `renderStateView()`:

```html
<div class="credentials-summary-bar">
  <div class="credentials-stat-card">
    <div class="stat-value">5</div>
    <div class="stat-label">Total Credentials</div>
  </div>
  <div class="credentials-stat-card green">
    <div class="stat-value">3</div>
    <div class="stat-label">Active</div>
  </div>
  <div class="credentials-stat-card red">
    <div class="stat-value">1</div>
    <div class="stat-label">Expired</div>
  </div>
</div>
```

### Zone 2: Credential Cards

Follow the card pattern from `agents.js` `renderAgentGrid()`:

```html
<div class="credentials-card-grid">
  <div class="credential-card active" onclick="showCredentialDetail('id')">
    <div class="credential-card-header">
      <span class="credential-card-name">Anthropic Production</span>
      <span class="credential-card-provider">anthropic</span>
    </div>
    <div class="credential-card-token">sk-ant-***4a2b</div>
    <div class="credential-card-status">
      <span class="dot online"></span>
      <span class="label">Active</span>
    </div>
    <div class="credential-card-meta">
      <span>Last used: 2h ago</span>
      <span>Leased by: A</span>
    </div>
  </div>
</div>
```

### Zone 3: OAuth Status

Display the result of `GET /api/auth/status` with action buttons:

```html
<div class="oauth-status-section">
  <div class="oauth-status-title">OAuth Status</div>
  <div class="oauth-status-card">
    <div class="oauth-status-indicator connected">
      <span class="dot online"></span> Connected
    </div>
    <div class="oauth-status-meta">
      Last refresh: 10:32 AM | Expires in: 45m
    </div>
    <div class="oauth-status-actions">
      <button onclick="refreshOAuthFromDashboard()">Refresh Token</button>
      <button onclick="startOAuthLogin()">Re-login</button>
    </div>
  </div>
</div>
```

### Detail Panel (right sidebar)

When clicking a credential card, show a detail panel following the same pattern as `#agent-detail`:

Fields to display:
- Name / Label
- Provider (anthropic / openai / openrouter / custom)
- Token (masked, with copy button)
- Base URL
- Model (if applicable)
- Status (active / expired / revoked)
- Created at / Updated at
- Current lease info (which agent, since when)
- Actions: Edit / Revoke / Delete

### Create/Edit Overlay

Follow the `#create-agent-overlay` pattern with form fields:
- Name (text input, required)
- Provider (select: anthropic / openai / openrouter / custom)
- Token (password input, required)
- Base URL (text input, optional)
- Model (text input, optional)
- Notes (textarea, optional)

---

## 7. credentials.js Module Structure Suggestion

Below is a skeleton module following the exact patterns observed in the codebase:

```js
// ── Credentials ──────────────────────────────────────────

let credentialsList = [];
let credentialOAuthStatus = null;
let currentCredentialDetail = null;

// ── Switch to Credentials View ──────────────────────────
function switchToCredentials() {
  currentView = 'credentials';

  // Hide all views and overlays
  document.getElementById('messages-container').style.display = 'none';
  document.getElementById('compose').classList.remove('active');
  document.getElementById('channel-header').style.display = 'none';
  document.getElementById('pin-bar').classList.remove('active');
  document.getElementById('pinned-panel').classList.remove('active');
  document.getElementById('tasks-container').classList.remove('active');
  document.getElementById('state-container').classList.remove('active');
  document.getElementById('agents-container').classList.remove('active');
  closeAllOverlays();

  // Show credentials view
  document.getElementById('credentials-container').classList.add('active');

  // Update sidebar highlights
  document.querySelectorAll('.channel-item').forEach(function(el) {
    el.classList.remove('active');
  });
  document.getElementById('credentials-nav').classList.add('active');

  // Load data
  loadCredentials();
}

// ── Load Credentials ────────────────────────────────────
async function loadCredentials() {
  try {
    // Load credential list and OAuth status in parallel
    var results = await Promise.all([
      api('/api/credentials'),        // TODO: implement this endpoint
      api('/api/auth/status')
    ]);
    credentialsList = results[0].credentials || [];
    credentialOAuthStatus = results[1];
    renderCredentials();
  } catch (e) {
    console.error('Failed to load credentials:', e);
    document.getElementById('credentials-body').innerHTML =
      '<div class="credentials-empty"><div class="icon">&#128274;</div>' +
      '<div>Failed to load credentials: ' + escapeHtml(e.message) + '</div></div>';
  }
}

// ── Render Credentials View ─────────────────────────────
function renderCredentials() {
  var body = document.getElementById('credentials-body');
  var html = '';

  // Zone 1: Summary stats bar
  var active = credentialsList.filter(function(c) { return c.status === 'active'; });
  var expired = credentialsList.filter(function(c) { return c.status === 'expired'; });

  html += '<div class="credentials-summary-bar">';
  html += '<div class="credentials-stat-card"><div class="stat-value">' + credentialsList.length + '</div><div class="stat-label">Total</div></div>';
  html += '<div class="credentials-stat-card green"><div class="stat-value">' + active.length + '</div><div class="stat-label">Active</div></div>';
  if (expired.length > 0) {
    html += '<div class="credentials-stat-card red"><div class="stat-value">' + expired.length + '</div><div class="stat-label">Expired</div></div>';
  }
  html += '</div>';

  // Zone 2: Credential cards grid
  html += '<div class="credentials-section">';
  html += '<div class="credentials-section-title">API Keys & Tokens</div>';
  if (credentialsList.length === 0) {
    html += '<div class="credentials-empty"><div class="icon">&#128274;</div><div>No credentials stored. Click <strong>+ New Credential</strong> to add one.</div></div>';
  } else {
    html += '<div class="credentials-card-grid">';
    for (var i = 0; i < credentialsList.length; i++) {
      html += renderCredentialCard(credentialsList[i]);
    }
    html += '</div>';
  }
  html += '</div>';

  // Zone 3: OAuth status
  html += renderOAuthStatusSection();

  body.innerHTML = html;
}

// ── Render Single Credential Card ───────────────────────
function renderCredentialCard(cred) {
  var isActive = cred.status === 'active';
  var maskedToken = cred.token_preview || '***';
  var providerLabel = cred.provider ? cred.provider.charAt(0).toUpperCase() + cred.provider.slice(1) : 'Unknown';

  var html = '<div class="credential-card ' + (isActive ? 'active' : 'inactive') + '" onclick="showCredentialDetail(\'' + escapeHtml(cred.id) + '\')">';
  html += '<div class="credential-card-header">';
  html += '<span class="credential-card-name">' + escapeHtml(cred.name || cred.id) + '</span>';
  html += '<span class="credential-card-provider">' + escapeHtml(providerLabel) + '</span>';
  html += '</div>';
  html += '<div class="credential-card-token">' + escapeHtml(maskedToken) + '</div>';
  html += '<div class="credential-card-status">';
  html += '<span class="dot ' + (isActive ? 'online' : 'offline') + '"></span>';
  html += '<span class="label">' + (isActive ? 'Active' : escapeHtml(cred.status || 'Unknown')) + '</span>';
  html += '</div>';
  if (cred.last_used_at) {
    html += '<div class="credential-card-meta">' + escapeHtml(formatDate(cred.last_used_at) + ' ' + formatTime(cred.last_used_at)) + '</div>';
  }
  html += '</div>';
  return html;
}

// ── OAuth Status Section ────────────────────────────────
function renderOAuthStatusSection() {
  var status = credentialOAuthStatus;
  if (!status) return '';

  var connected = status.authenticated || status.has_token;
  var html = '<div class="oauth-status-section">';
  html += '<div class="credentials-section-title">OAuth Status</div>';
  html += '<div class="oauth-status-card">';
  html += '<div class="oauth-status-indicator">';
  html += '<span class="dot ' + (connected ? 'online' : 'offline') + '"></span>';
  html += '<span>' + (connected ? 'Authenticated' : 'Not Connected') + '</span>';
  html += '</div>';
  if (status.expires_at) {
    html += '<div class="oauth-status-meta">Expires: ' + escapeHtml(formatDate(status.expires_at) + ' ' + formatTime(status.expires_at)) + '</div>';
  }
  html += '<div class="oauth-status-actions">';
  html += '<button class="btn-create" onclick="refreshOAuthFromDashboard()">Refresh Token</button>';
  if (!connected) {
    html += '<button class="btn-create" style="background:var(--green);" onclick="startOAuthLogin()">Login</button>';
  }
  html += '</div>';
  html += '</div>';
  html += '</div>';
  return html;
}

// ── Show Credential Detail ──────────────────────────────
async function showCredentialDetail(id) {
  try {
    var data = await api('/api/credentials/' + encodeURIComponent(id));
    var cred = data.credential || data;
    if (!cred) return;
    currentCredentialDetail = cred;

    var html = '';

    // Name
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Name</div>';
    html += '<div class="detail-value" style="font-weight:700;">' + escapeHtml(cred.name || cred.id) + '</div>';
    html += '</div>';

    // Provider
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Provider</div>';
    html += '<div class="detail-value">' + escapeHtml(cred.provider || 'N/A') + '</div>';
    html += '</div>';

    // Token (masked)
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Token</div>';
    html += '<div class="detail-value" style="font-family:\'SF Mono\',monospace; font-size:13px;">' + escapeHtml(cred.token_preview || '***') + '</div>';
    html += '</div>';

    // Base URL
    if (cred.base_url) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Base URL</div>';
      html += '<div class="detail-value">' + escapeHtml(cred.base_url) + '</div>';
      html += '</div>';
    }

    // Status
    html += '<div class="detail-field">';
    html += '<div class="detail-label">Status</div>';
    html += '<div class="detail-value">';
    var isActive = cred.status === 'active';
    html += '<span style="display:inline-flex;align-items:center;gap:6px;">';
    html += '<span class="dot ' + (isActive ? 'online' : 'offline') + '"></span>';
    html += escapeHtml(cred.status || 'unknown');
    html += '</span></div>';
    html += '</div>';

    // Timestamps
    if (cred.created_at) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Created</div>';
      html += '<div class="detail-value" style="font-size:12px;color:var(--text-dim);">' + escapeHtml(formatDate(cred.created_at) + ' ' + formatTime(cred.created_at)) + '</div>';
      html += '</div>';
    }

    // Current lease info
    if (cred.leased_by) {
      html += '<div class="detail-field">';
      html += '<div class="detail-label">Currently Leased By</div>';
      html += '<div class="detail-value" style="color:' + agentColor(cred.leased_by) + ';">' + escapeHtml(cred.leased_by) + '</div>';
      html += '</div>';
    }

    // Actions
    html += '<div class="detail-field" style="display:flex; gap:8px; margin-top:16px;">';
    html += '<button style="padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:none; background:var(--accent); color:#fff;" onclick="editCredential(\'' + escapeHtml(cred.id) + '\')">Edit</button>';
    if (cred.leased_by) {
      html += '<button style="padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:1px solid var(--orange); background:transparent; color:var(--orange);" onclick="revokeCredentialLease(\'' + escapeHtml(cred.id) + '\')">Revoke Lease</button>';
    }
    html += '</div>';

    // Delete
    html += '<div class="detail-field" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">';
    html += '<button style="padding:8px 20px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:1px solid var(--red); background:transparent; color:var(--red); width:100%;" onclick="confirmDeleteCredential(\'' + escapeHtml(cred.id) + '\')">Delete Credential</button>';
    html += '</div>';

    document.getElementById('credential-detail-body').innerHTML = html;
    document.getElementById('credential-detail').classList.add('active');
  } catch (e) {
    console.error('Failed to load credential detail:', e);
    alert('Failed to load credential detail: ' + e.message);
  }
}

function closeCredentialDetail() {
  currentCredentialDetail = null;
  document.getElementById('credential-detail').classList.remove('active');
}

// ── Create Credential Form ──────────────────────────────
function showCreateCredentialForm() {
  document.getElementById('cc-name').value = '';
  document.getElementById('cc-provider').value = '';
  document.getElementById('cc-token').value = '';
  document.getElementById('cc-base-url').value = '';
  document.getElementById('cc-model').value = '';
  document.getElementById('create-credential-overlay').classList.add('active');
  document.getElementById('cc-name').focus();
}

function hideCreateCredentialForm() {
  document.getElementById('create-credential-overlay').classList.remove('active');
}

async function submitCreateCredential() {
  var name = document.getElementById('cc-name').value.trim();
  var provider = document.getElementById('cc-provider').value;
  var token = document.getElementById('cc-token').value.trim();

  if (!name) { alert('Name is required'); return; }
  if (!token) { alert('Token is required'); return; }

  var body = { name: name, token: token };
  if (provider) body.provider = provider;

  var baseUrl = document.getElementById('cc-base-url').value.trim();
  if (baseUrl) body.base_url = baseUrl;

  var model = document.getElementById('cc-model').value.trim();
  if (model) body.model = model;

  try {
    var res = await fetch('/api/credentials', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      if (res.status === 403) {
        alert('Permission denied: ' + (err.error || 'insufficient permissions'));
        return;
      }
      throw new Error(err.error || 'Create failed');
    }
    hideCreateCredentialForm();
    loadCredentials();
  } catch (e) {
    console.error('Failed to create credential:', e);
    alert('Failed to create credential: ' + e.message);
  }
}

// ── Delete Credential ───────────────────────────────────
async function confirmDeleteCredential(id) {
  if (!confirm('Are you sure you want to delete this credential?')) return;
  if (!confirm('This action cannot be undone. Continue?')) return;

  try {
    var res = await fetch('/api/credentials/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      throw new Error(err.error || 'Delete failed');
    }
    closeCredentialDetail();
    loadCredentials();
  } catch (e) {
    console.error('Failed to delete credential:', e);
    alert('Failed to delete credential: ' + e.message);
  }
}

// ── OAuth Actions ───────────────────────────────────────
async function refreshOAuthFromDashboard() {
  try {
    var res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY }
    });
    if (!res.ok) throw new Error('Refresh failed: ' + res.status);
    credentialOAuthStatus = await res.json();
    renderCredentials();
  } catch (e) {
    console.error('Failed to refresh OAuth:', e);
    alert('Failed to refresh OAuth token: ' + e.message);
  }
}

async function startOAuthLogin() {
  try {
    var res = await fetch('/api/auth/login/start', { method: 'POST' });
    var data = await res.json();
    if (data.url) {
      window.open(data.url, '_blank');
    } else {
      alert('No login URL returned');
    }
  } catch (e) {
    console.error('Failed to start OAuth login:', e);
    alert('Failed to start login: ' + e.message);
  }
}

// ── Escape key handler ──────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (document.getElementById('create-credential-overlay').classList.contains('active')) {
      hideCreateCredentialForm();
    } else if (document.getElementById('credential-detail').classList.contains('active')) {
      closeCredentialDetail();
    }
  }
});

// Close overlay on backdrop click
document.addEventListener('DOMContentLoaded', function() {
  var overlay = document.getElementById('create-credential-overlay');
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) hideCreateCredentialForm();
    });
  }
});
```

### CSS to Add (append to dashboard.css)

```css
/* ── Credentials View ───────────────────────────────── */
#credentials-container {
  display: none;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
#credentials-container.active { display: flex; }

#credentials-header {
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
}
#credentials-header h2 {
  font-size: 15px;
  font-weight: 700;
  margin-right: auto;
}

#credentials-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 24px;
}

.credentials-summary-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}
.credentials-stat-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  text-align: center;
  min-width: 100px;
}
.credentials-stat-card.green { border-color: var(--green); }
.credentials-stat-card.red { border-color: var(--red); }
.credentials-stat-card .stat-value {
  font-size: 24px;
  font-weight: 700;
}
.credentials-stat-card .stat-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.credentials-section { margin-bottom: 24px; }
.credentials-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.credentials-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.credential-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.credential-card:hover {
  background: var(--bg-msg-hover);
  border-color: var(--accent);
}
.credential-card.inactive { opacity: 0.6; }

.credential-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.credential-card-name {
  font-size: 14px;
  font-weight: 600;
}
.credential-card-provider {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-input);
  padding: 2px 8px;
  border-radius: 10px;
}
.credential-card-token {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.credential-card-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
}
.credential-card-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
}

/* Credential Detail Panel */
#credential-detail {
  display: none;
  position: fixed;
  top: 0;
  right: 0;
  width: 420px;
  height: 100vh;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  z-index: 500;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0,0,0,0.3);
  overflow-y: auto;
}
#credential-detail.active { display: flex; }

/* Create Credential Overlay */
#create-credential-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 1000;
  align-items: center;
  justify-content: center;
}
#create-credential-overlay.active { display: flex; }

.create-credential-card {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: 440px;
  max-height: 80vh;
  overflow-y: auto;
}
.create-credential-card h3 {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 16px;
}

/* OAuth Status */
.oauth-status-section { margin-bottom: 24px; }
.oauth-status-card {
  background: var(--bg-msg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}
.oauth-status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.oauth-status-meta {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 12px;
}
.oauth-status-actions {
  display: flex;
  gap: 8px;
}

.credentials-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--text-muted);
  font-size: 14px;
  gap: 8px;
}
.credentials-empty .icon { font-size: 40px; opacity: 0.5; }

.credentials-refresh-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  padding: 5px 10px;
  cursor: pointer;
  font-size: 14px;
}
.credentials-refresh-btn:hover { background: var(--bg-msg); color: var(--text); }

#new-credential-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}
#new-credential-btn:hover { background: var(--accent-dim); }
```

### i18n Keys to Add (optional)

If you want to support the bilingual system, add entries to the `i18n` object in `i18n.js`:

```js
// English
'credentials.title': 'Credentials',
'credentials.vault': 'Credential Vault',
'credentials.total': 'Total',
'credentials.active': 'Active',
'credentials.expired': 'Expired',
'credentials.new': '+ New Credential',
'credentials.apiKeys': 'API Keys & Tokens',
'credentials.oauthStatus': 'OAuth Status',
'credentials.empty': 'No credentials stored.',
'credentials.name': 'Name',
'credentials.provider': 'Provider',
'credentials.token': 'Token',
'credentials.baseUrl': 'Base URL',
'credentials.status': 'Status',
'credentials.delete': 'Delete Credential',
'credentials.confirmDelete': 'Are you sure you want to delete this credential?',

// Chinese
'credentials.title': '凭证管理',
'credentials.vault': '凭证库',
'credentials.total': '总数',
'credentials.active': '有效',
'credentials.expired': '已过期',
// ... etc
```

---

## Appendix: Quick Reference Checklist

When implementing the credentials page, ensure you:

- [ ] Add HTML containers to `index.html` (view, detail panel, create overlay)
- [ ] Add `<script src="js/credentials.js">` to `index.html` (after agents.js)
- [ ] Add sidebar nav entry in `index.html`
- [ ] Create `js/credentials.js` following the skeleton above
- [ ] Append CSS to `css/dashboard.css`
- [ ] Update `switchToMessages()`, `switchToTasks()`, `switchToState()`, `switchToAgents()` to hide `#credentials-container`
- [ ] Update `closeAllOverlays()` in `members.js`
- [ ] Add i18n keys if bilingual support is needed
- [ ] (Backend) Implement CRUD endpoints: `GET/POST /api/credentials`, `GET/PATCH/DELETE /api/credentials/:id`
- [ ] Test both dark and light themes
- [ ] Test Escape key closes overlays/details
- [ ] Test backdrop click closes overlays
