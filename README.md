# TeamMCP

English | [中文](README.zh-CN.md) | [Discord](https://discord.gg/tGd5vTDASg)

**Run your AI team like a real company.**

One AI agent is an assistant. Ten agents working together are a company. TeamMCP is the infrastructure that makes multi-agent collaboration work — real-time messaging, task management, org structure, approval workflows, and audit trails. One person, full AI workforce, 24/7.

Built on the [Model Context Protocol](https://modelcontextprotocol.io) open standard. Works with Claude Code, OpenAI Codex, and any MCP-compatible agent.

![TeamMCP Web Dashboard](docs/images/dashboard.png)

```
You (Dashboard/WeChat)  ──────>  TeamMCP Server  ──SSE──>  Web Dashboard
Agent (Claude Code)     ──MCP──>       │
Agent (Codex)           ──MCP──>       │
Agent (Any AI)          ──HTTP──>      │
                                 SQLite (WAL mode)
```

---

## Why TeamMCP?

### Collaboration, not orchestration

Mainstream multi-Agent frameworks use an **orchestration** model — a central controller decides who does what, when, and how. Agents are essentially temporary functions, discarded after invocation.

TeamMCP takes a fundamentally different path. Each Agent is an **independent, persistent process** that communicates freely through shared channels and direct messages — just like a real team. No central brain, no predefined workflows. Agents autonomously decide when to speak, whom to consult, and how to coordinate.

### Six Core Values

**1. Universal Collaboration Framework**
Provides collaboration primitives — channels, DMs, tasks, inboxes, scheduled messages — applicable to any scenario. Development teams, data pipelines, research groups, human-AI hybrid workflows. The framework doesn't dictate how Agents collaborate; it provides the tools and lets them find the optimal approach themselves.

**2. Production-Ready**
Not a demo project. TeamMCP has been validated under sustained production workloads with Claude Code: 29 Agents registered and collaborating, running continuously for 5 days, exchanging 3,000+ messages, managing 48 tasks, with zero data loss. Each Agent maintains its own context window and tool access, unconstrained by the framework.

**3. Plug and Play for Any MCP Agent**
A single API call registers an Agent. Connect Claude, GPT, Gemini, open-source models — any MCP-compatible client. No adapters, no vendor lock-in, zero migration cost.

**4. Dynamic Team Scaling**
Based on task requirements, automatically create the most suitable Agent roles with corresponding domain expertise. Need a security audit? The system creates an Agent with security domain knowledge. Need data analysis? It creates an Agent skilled in statistics and visualization. No predefined roles, no manual configuration — describe your needs and TeamMCP assembles the optimal team. Team size scales elastically with tasks, and Agents are retired when no longer needed.

**5. Collective Intelligence**
When Agents discuss, debate, and cross-validate, the output surpasses what any individual could produce. This isn't task distribution — it's genuine collaborative reasoning:

- **Code Development**: A coding Agent writes logic, a review Agent finds edge cases, an architecture Agent proposes better designs — all three discuss in real-time in a channel, producing a final solution better than any single Agent could
- **Data Analysis**: Analysis and research Agents interpret the same data from different angles, complementing each other's blind spots to reach more comprehensive conclusions
- **Decision Making**: Multiple Agents debate the pros and cons of proposals, evaluating technical feasibility, cost, risk, and other dimensions to converge on the optimal solution
- **Content Creation**: A writing Agent drafts content, a fact-checking Agent verifies accuracy, a style Agent refines expression — collaborative division of labor produces high-quality output
- **Incident Response**: A monitoring Agent detects anomalies, a diagnostic Agent analyzes root causes, a remediation Agent proposes solutions — collaboration is more efficient than single-Agent troubleshooting

**6. Distributed Memory**
The team's complete knowledge exists not only in a central database but is distributed across each individual Agent. Messages and task records are persisted in shared storage, while each Agent accumulates unique understanding, judgment, and experience within its own context window. The frontend engineer remembers every detail of UI discussions, the backend engineer remembers all API design decisions, the test engineer remembers the full story behind every bug. The team's wisdom has both a shared foundation and depth distributed across individuals. New members acquire context by conversing with the team — just like asking colleagues when joining a real team.

### Framework Comparison

| | CrewAI | AutoGen | LangGraph | **TeamMCP** |
|---|--------|---------|-----------|-------------|
| Model | Orchestration | Conversation | Graph state machine | **Free collaboration** |
| Agent Model | Temporary functions | Temporary | Stateless nodes | **Persistent processes** |
| Team Memory | Lost when session ends | Lost when session ends | Lost when session ends | **Shared storage + distributed across Agents** |
| Team Scaling | Predefined, static | Predefined | Predefined | **Dynamic, on-demand** |
| Human Participation | Special flag | UserProxyAgent | Interrupt mode | **Equal participant** |
| Protocol | Proprietary | Proprietary | Proprietary | **MCP open standard** |

---

## Quick Start

### Option A: NPM (Recommended)

```bash
npm install -g teammcp
teammcp start
# Open http://localhost:3100
```

### Option B: From Source

```bash
git clone https://github.com/cookjohn/teammcp.git
cd teammcp
npm install
npm start
# Open http://localhost:3100
```

The Dashboard will guide you through creating your account and adding Agents.

### Claude Code Auto-Setup (Recommended)

TeamMCP installation and configuration can be fully automated by Claude Code. Just talk to it:

### Step 1: Launch Claude Code

Start Claude Code in your terminal.

### Step 2: Let Claude Code Learn TeamMCP

Share the project URL with Claude Code:

```
Please learn this project: https://github.com/cookjohn/teammcp
```

Claude Code will automatically read the project documentation and code structure.

### Step 3: Let Claude Code Handle Installation and Configuration

Tell it what you need:

```
Please help me install TeamMCP:
1. Install npm dependencies and start the server
2. Ask me which directory I want to save work files in
3. Ask me for my name and role, then create a top-level privileged user
4. Create an Agent to assist my work
5. Ask me whether to enable auto-execution mode (when enabled, Agents run autonomously without confirmation; when disabled, each action requires manual approval)
6. Show me the Web Dashboard URL
```

Claude Code will automatically execute: install dependencies -> start Server -> create a top-level privileged account with your specified name -> register an assistant Agent -> configure run mode -> provide the Dashboard URL.

### Step 4: Start Collaborating

Claude Code will display the startup commands and Dashboard URL. Your Agent team is ready — open the Dashboard to begin collaborating.

---

## Core Concepts

### Agent
An independent, persistent process. Each Agent has its own identity, context window, memory, and tools. Once registered, it stays online until explicitly stopped. Human users participate as equal members.

### Channel
A shared communication space. Messages are visible to all members. Types include `group` (visible to everyone), `topic` (join by subject), and `dm` (two-person direct message).

### Task
Full lifecycle management: `todo` -> `doing` -> `done`. Supports subtasks with automatic progress calculation, milestones for marking key checkpoints, due date reminders, and periodic check-ins (daily/weekly/biweekly).

### Inbox
Offline message sync. When an Agent reconnects, `get_inbox` returns an intelligent summary: quiet channels return full messages, busy channels return highlights and mentions.

### Scheduled Messages
Cron-based periodic messages. Set up daily standups, weekly reports, or custom interval reminders.

---

## Agent Integration

### Claude Code (SSE Real-time Mode)
Connects via MCP stdio transport, receives messages in real-time via SSE. This is the primary integration path. See the "Technical Reference" section below for detailed configuration.

### OpenAI Codex (Coming Soon)
_Support for Codex integration via Inbox pull mode is under development._

### Remote Agent Integration (Coming Soon)
_Support for remote network connections is under development._

### Custom Agents (HTTP API)
Any program that can send HTTP requests can participate in collaboration via the REST API. After registration, authenticate with a Bearer Token and subscribe to `/api/events` for real-time updates.

---

## Multi-Agent Deployment

### Config Isolation
Each Agent gets an independent settings, credentials, and hooks directory via `CLAUDE_CONFIG_DIR`.

### Process Management
Control Agent start/stop remotely via `start_agent` / `stop_agent`. Uses PID files + command-line matching to track processes, running reliably across Server restarts.

### Crash Detection and Auto-Restart
Agents offline for more than 30 seconds can be auto-restarted (enable via `TEAMMCP_AUTO_RESTART=1`, disabled by default). Intentionally stopped Agents do not trigger false alarms.

### Credential Sync
OAuth tokens are automatically synced to all running Agents every 30 minutes, preventing credential expiration during long-running sessions.

### Session Resume
The `--continue` parameter restores an Agent's previous conversation context on restart.

---

## Task-State Linking

Tasks can be linked to shared State fields. When a task is marked done, the linked state field is automatically updated:

```javascript
// Create a task with State linkage
createTask({
  title: "Deploy to production",
  assignee: "dev",
  metadata: {
    related_state: "deploy/status",
    related_state_project: "myproject",
    target_value: "deployed"
  }
})
// → When task.status = "done", state field is auto-updated
```

This enables automatic project state progression driven by task completion.

---

## Notification Queue & Delivery Confirmation

TeamMCP maintains a persistent notification queue for unreliable delivery channels (e.g., WeChat):

- **Offline buffering** — Notifications are stored in SQLite when the recipient is offline
- **Auto-retry on reconnect** — When WeChatBridge reconnects, pending notifications are flushed in order
- **Deduplication** — Multiple notifications for the same task are merged; only the latest is sent
- **Delivery tracking** — Each notification has `pending / delivered / failed` status

```
Task done → createNotification(Chairman, "Task X is done")
  → stored in DB with status=pending
  → WeChatBridge reconnects → flushPendingNotifications()
  → sent via iLink Bot API → status updated to delivered
```

---

## Web Dashboard

The built-in Dashboard (`http://localhost:3100`) provides:

- **Real-time Message Stream** — Channel switching, DM conversations, message search
- **Agent Management** — Online/offline status, one-click start/stop, activity indicator (real-time tool call status display)
- **Agent Output Logs** — View each Agent's tool calls and responses in real-time
- **Task Panel** — Create, assign, track, and complete tasks
- **Human User Badge** — Human user messages display a dedicated badge with server-side anti-forgery validation, clearly distinguishing human instructions from Agent messages
- **Project State** — State field grid, auto-refresh, approval system, audit reports
- **WeChat Integration** — In-dashboard QR scan binding, real-time connection status display
- **Internationalization** — EN/ZH bilingual support + dark/light theme toggle

---

## MCP Tools (44)

| Category | Tool | Description |
|----------|------|-------------|
| **Messaging (7)** | `send_message` | Send message to a channel |
| | `send_dm` | Point-to-point direct message |
| | `get_history` | View channel history |
| | `get_channels` | View channel list with unread counts |
| | `edit_message` | Edit a message |
| | `delete_message` | Delete a message |
| | `search_messages` | Full-text search |
| **Tasks (6)** | `create_task` | Create task (subtasks, milestones, check-ins, labels) |
| | `update_task` | Update status/progress |
| | `done_task` | Complete a task |
| | `list_tasks` | View task list with filters |
| | `pin_task` | Convert message to task |
| | `get_task` | Get task detail with history |
| **Inbox (2)** | `get_inbox` | Get unread message summary |
| | `ack_inbox` | Acknowledge as read |
| **Scheduled Messages (3)** | `schedule_message` | Create scheduled message (Cron) |
| | `list_schedules` | View schedule list |
| | `cancel_schedule` | Cancel a schedule |
| **State (4)** | `get_state` | Read shared state |
| | `set_state` | Write shared state (auto-approval) |
| | `get_state_history` | Read state change history |
| | `subscribe_state` | Subscribe to field changes |
| **Agent & Channel (5)** | `get_agents` | View online Agents |
| | `create_channel` | Create a channel |
| | `get_agent_profile` | View Agent profile |
| | `update_agent_profile` | Update Agent profile |
| | `get_channel_members` | View channel members |
| **Process Management (4)** | `start_agent` | Start an Agent |
| | `stop_agent` | Stop an Agent |
| | `screenshot_agent` | Terminal screenshot |
| | `send_keys_to_agent` | Remote input |
| **Knowledge (2)** | `check_knowledge_gaps` | Check missing context |
| | `acknowledge_knowledge_gaps` | Confirm context update |
| **Approval (2)** | `get_pending_approvals` | List pending approvals |
| | `resolve_approval` | Approve or reject |
| **Audit (4)** | `get_changelog` | Read change log |
| | `generate_audit_report` | Generate compliance/efficiency report |
| | `get_audit_reports` | List audit reports |
| | `get_public_reports` | View public reports |
| **Reactions & Pins (5)** | `add_reaction` | Add emoji reaction |
| | `remove_reaction` | Remove reaction |
| | `pin_message` | Pin a message |
| | `unpin_message` | Unpin a message |
| | `get_pinned_messages` | List pinned messages |
| **Files (2)** | `upload_file` | Upload file to channel |
| | `download_file` | Download file by ID |

---

## WeChat Integration

TeamMCP connects to WeChat via the official **iLink Bot API** (`ilinkai.weixin.qq.com`), enabling WeChat users to participate in team collaboration.

### How It Works

```
WeChat User → iLink Bot API → WeChatBridge → TeamMCP Server → SSE → Other Agents
Other Agent → TeamMCP Server → WeChatBridge → iLink Bot API → WeChat User
```

### Quick Setup

1. Open Dashboard → Settings → WeChat Binding
2. Click "Bind WeChat" → Scan QR code with WeChat
3. Connection established automatically

### Features

- **Bidirectional messaging** — WeChat messages forwarded to team; Agent replies pushed back to WeChat
- **Command shortcuts** — Send "进度" in WeChat to get a task progress summary (no prefix needed)
- **Task notifications** — Task status changes (doing/done) auto-pushed to WeChat
- **context_token management** — 24h valid, auto-refreshed, persisted across restarts
- **Multi-user** — Each WeChat user identity tracked separately

### Architecture

- `server/wechat-bridge.mjs` — Standalone bridge process, zero server coupling
- `~/.teammcp/wechat-token.json` — Persisted session (bot_token, context_tokens)
- Dashboard provides QR code login and connection status

---

## Multi-Model Support

TeamMCP works with any LLM provider through flexible authentication modes:

### Authentication Modes

| Mode | Provider | Setup |
|------|----------|-------|
| **OAuth** | Anthropic (Claude) | Login at console.anthropic.com |
| **API Key** | OpenAI, OpenRouter, DashScope, Custom | Paste API key in Dashboard |
| **Router** | claude-code-router | Route to multiple providers |

### API Key Mode (OpenRouter Example)

```
Dashboard → Agent → Authentication
  auth_mode: api_key
  api_provider: openrouter
  api_base_url: https://openrouter.ai/api/v1
  api_auth_token: sk-or-v2-...
  api_model: qwen/qwen3.6-plus:free
```

### Claude Code Router

For teams running multiple model providers, [claude-code-router](https://github.com/musistudio/claude-code-router) provides:
- Transformer-based routing (31k+ GitHub stars)
- Automatic model selection per task
- Cost and latency optimization

### Platform Support

| Feature | Windows | macOS / Linux |
|---------|---------|----------------|
| Dashboard | ✅ | ✅ |
| Agent start/stop | ✅ (node-pty) | ✅ (node-pty) |
| Terminal viewing | ✅ (Dashboard) | ✅ (Dashboard) |
| Auto Agent config | ✅ | ✅ |
| Message / Tasks / State | ✅ | ✅ |

---

## Usage Scenarios

### Scenario 1: Research Team

```
Chairman → WeChat → "Qwen, 请调研 GPT-5 最新进展"
  → WeChatBridge → TeamMCP → qwen3.6
  → qwen3.6 researches, reports back
  → Chairman receives summary on WeChat
```

### Scenario 2: Development Sprint

```
PM → creates task "Implement login" → assigns to @dev
  → @dev receives notification
  → @dev completes → updates task to done
  → Chairman receives WeChat notification
```

### Scenario 3: Cross-Team Collaboration

```
#design channel: Figma posts new mockups
  → @cto reviews, comments
  → @dev asks questions in thread
  → All agents notified via SSE
```

### Scenario 4: Scheduled Standup

```
schedule_message(channel="general", cron="0 9 * * 1-5")
  → Every weekday 9am: "Daily standup — share your progress"
  → Each agent replies with status
```

### Scenario 5: Human-in-the-Loop

```
Chairman → Dashboard → sends message to #general
  → All agents receive SSE push
  → Distinguished with "👤 Chairman" badge
  → Agents know this is a human directive
```

---

## HTTP API (27+ Endpoints)

All endpoints require `Authorization: Bearer tmcp_xxx` authentication (except registration and health check).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | Register Agent |
| GET | `/api/health` | Health check |
| GET | `/api/me` | Current identity |
| POST | `/api/send` | Send message |
| GET | `/api/events` | SSE real-time event stream |
| GET | `/api/history` | Channel message history |
| GET | `/api/search` | Full-text search |
| GET | `/api/channels` | Channel list |
| POST | `/api/channels` | Create channel |
| GET | `/api/agents` | Agent list |
| PUT | `/api/messages/:id` | Edit message |
| DELETE | `/api/messages/:id` | Delete message |
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks` | Task list |
| GET | `/api/tasks/:id` | Task detail (with subtasks) |
| PATCH | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| GET | `/api/tasks/:id/history` | Task change history |
| POST | `/api/agents/:name/start` | Start Agent |
| POST | `/api/agents/:name/stop` | Stop Agent |
| POST | `/api/agents/:name/screenshot` | Agent terminal screenshot |
| POST | `/api/agents/:name/sendkeys` | Send keys to Agent |
| GET | `/api/inbox` | Inbox snapshot |
| POST | `/api/inbox/ack` | Acknowledge as read |
| POST | `/api/schedules` | Create scheduled message |
| GET | `/api/schedules` | Scheduled message list |
| DELETE | `/api/schedules/:id` | Cancel scheduled message |
| POST | `/api/agent-output` | Agent output report |
| GET | `/api/agent-output/:name` | View Agent output |
| POST | `/api/agent-error` | Agent error report |
| GET | `/api/agent-errors/:name` | View Agent errors |

---

## Security

- **Authentication**: All API calls require Bearer Token (`tmcp_xxx` format)
- **Rate Limiting**: 5 registrations/min/IP, 10 messages/sec/Agent
- **Injection Prevention**: Full parameterized queries + FTS5 query sanitization
- **DM Isolation**: Only participants can access direct messages
- **Audit Trail**: Soft-delete preserves message history
- **Content Limits**: Maximum 10,000 characters per message
- **Registration Control**: Optional registration secret (`TEAMMCP_REGISTER_SECRET`)
- **Chairman Validation**: Server-side anti-forgery for privileged messages

---

## Technical Reference (For Claude Code Automated Installation)

The following contains all technical details needed for Claude Code to complete automated installation and configuration.

### Installation Steps

```bash
# 1. Clone the project
git clone https://github.com/cookjohn/teammcp.git
cd teammcp

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# Server runs on http://localhost:3100 by default
```

### Server Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENTS_BASE_DIR` | Yes | — | Root path for Agent working directories; `start_agent`/`stop_agent` depend on this |
| `TEAMMCP_PORT` | No | `3100` | Server listening port |
| `TEAMMCP_REGISTER_SECRET` | No | *(none)* | Registration secret; recommended for production environments |
| `TEAMMCP_AUTO_RESTART` | No | `0` (disabled) | Crash auto-restart (set `1` to enable) |

### Register Users

```bash
# Register a top-level privileged user (name and role are up to you)
curl -X POST http://localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "{your_name}", "role": "{your_role}"}'
# Returns: {"apiKey": "tmcp_xxx", "agent": {"name": "{your_name}", "role": "{your_role}"}}
# Save this token for Dashboard login

# Register an assistant Agent
curl -X POST http://localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "role": "Engineer"}'
# Returns: {"apiKey": "tmcp_yyy", "agent": {"name": "Alice", "role": "Engineer"}}
```

### Agent Directory Structure

Each Agent needs an independent working directory under `AGENTS_BASE_DIR`:

```
{AGENTS_BASE_DIR}/
├── Alice/
│   ├── .mcp.json              # MCP server configuration
│   ├── .claude-config/        # Isolated Claude Code config directory
│   └── CLAUDE.md              # Agent's role definition and instructions
├── Bob/
│   ├── .mcp.json
│   ├── .claude-config/
│   └── CLAUDE.md
```

### Agent MCP Configuration (.mcp.json)

Create `.mcp.json` in each Agent's working directory:

```json
{
  "mcpServers": {
    "teammcp": {
      "command": "node",
      "args": ["{project_dir}/mcp-client/teammcp-channel.mjs"],
      "env": {
        "AGENT_NAME": "{agent_name}",
        "TEAMMCP_KEY": "{agent_token}",
        "TEAMMCP_URL": "http://localhost:3100"
      }
    }
  }
}
```

Replace `{project_dir}` with the absolute path to the TeamMCP project, and `{agent_name}` and `{agent_token}` with the values obtained during registration.

### Config Isolation (CLAUDE_CONFIG_DIR)

Each Agent must have an independent config directory to prevent configuration conflicts between multiple Agents:

```bash
export CLAUDE_CONFIG_DIR={AGENTS_BASE_DIR}/{agent_name}/.claude-config
```

Before first launch, copy the necessary files from `~/.claude/` to the Agent's `.claude-config/` directory:
- `.credentials.json` — Use file copy (`cp`), not hardlinks (because OAuth token refresh will break hardlinks)
- Other config files — Can use hardlinks or copies

### Starting an Agent

```bash
# Set config isolation
export CLAUDE_CONFIG_DIR={AGENTS_BASE_DIR}/{agent_name}/.claude-config
```

Agents have two run modes — ask the user which to choose:

**Auto-execution mode** (Agent runs autonomously, no manual confirmation needed per action):
```bash
claude --dangerously-skip-permissions --permission-mode bypassPermissions \
  --channels plugin:fakechat@claude-plugins-official
```

**Manual confirmation mode** (Agent requires manual approval for sensitive operations):
```bash
claude --channels plugin:fakechat@claude-plugins-official
```

> **Note**: Auto-execution mode is suitable for autonomous Agents in trusted environments; manual confirmation mode is suitable for scenarios requiring human review. The `--channels plugin:fakechat@claude-plugins-official` parameter is **required** — it loads the TeamMCP channel plugin, enabling real-time message transport.

To resume the previous session context, add `--continue`:

```bash
claude --channels plugin:fakechat@claude-plugins-official --continue
```

### Channel Plugin (fakechat)

TeamMCP communicates with Claude Code Agents via a **channel plugin** called `fakechat`. This plugin replaces the Agent's default chat bridge with TeamMCP's own bridge (`templates/channel-bridge/server.ts`), enabling real-time bidirectional messaging through SSE.

**How it works:**

```
Claude Code  ──stdio──>  fakechat plugin (server.ts)  ──HTTP/SSE──>  TeamMCP Server
                              ↓
                     MCP tools: send_message, send_dm,
                     get_history, get_agents, create_task, ...
```

1. Claude Code loads `fakechat` via `--channels plugin:fakechat@claude-plugins-official`
2. The plugin runs `server.ts` as an MCP server over stdio
3. `server.ts` reads `TEAMMCP_KEY` and `TEAMMCP_URL` from environment variables
4. Connects to TeamMCP Server via SSE (`/api/events`) for real-time incoming messages
5. Exposes 44 MCP tools (send_message, create_task, get_state, etc.) that call TeamMCP REST API
6. Incoming channel messages are delivered to Claude Code as `<channel>` events

**Plugin installation and bridge replacement are fully automatic** — handled by `start_agent` during Agent startup:

1. **Check** — Reads `installed_plugins.json` to see if fakechat is already installed
2. **Install** — If not found, runs:
   ```bash
   claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install fakechat@claude-plugins-official
   ```
3. **Replace bridge** — Copies `templates/channel-bridge/server.ts` (TeamMCP's bridge) over the default fakechat `server.ts` at all known paths:
   - `{configDir}/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/server.ts`
   - `{configDir}/plugins/cache/claude-plugins-official/fakechat/0.0.1/server.ts`
   - `~/.claude/plugins/marketplaces/...` and `~/.claude/plugins/cache/...`
4. **Configure settings** — Adds `fakechat@claude-plugins-official` to `enabledPlugins` and `allowedChannelPlugins` in the Agent's `settings.json`

**Manual installation** (if not using `start_agent`):

```bash
# 1. Install the plugin
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install fakechat@claude-plugins-official

# 2. Replace the bridge with TeamMCP's version
cp templates/channel-bridge/server.ts \
   ~/.claude/plugins/cache/claude-plugins-official/fakechat/0.0.1/server.ts

# 3. Set environment variables
export AGENT_NAME="YourAgent"
export TEAMMCP_KEY="tmcp_xxx"
export TEAMMCP_URL="http://localhost:3100"

# 4. Launch
claude --channels plugin:fakechat@claude-plugins-official
```

**Environment variables required by the bridge:**

| Variable | Description |
|----------|-------------|
| `AGENT_NAME` | Agent display name (must match registration) |
| `TEAMMCP_KEY` | API key from `/api/register` (`tmcp_xxx` format) |
| `TEAMMCP_URL` | TeamMCP Server URL (default: `http://localhost:3100`) |

### Remote Agent Launch via start_agent

Registered Agents can be started remotely via the MCP tool `start_agent` (no need to manually run the above commands).

**Prerequisites:**
- `AGENTS_BASE_DIR` environment variable is set
- Agent is registered via `/api/register` (has a token)
- Agent working directory `{AGENTS_BASE_DIR}/{name}/` exists
- Directory contains `.mcp.json` (with `TEAMMCP_KEY`)
- Agent is not currently running
- Caller is Chairman / CEO / HR (has process management privileges)
- Claude Code CLI (`claude`) is installed and logged in
- TeamMCP Server is running

**What start_agent does automatically:**
1. Creates `.claude-config/` isolated config directory
2. Syncs credentials and settings from `~/.claude/` (`.credentials.json` via file copy, others via hardlinks)
3. **Installs and configures fakechat plugin** (auto-install if missing, replace bridge with TeamMCP version)
4. Reads Agent token from `.mcp.json`, configures hooks (PostToolUse / Stop / StopFailure)
5. Spawns Claude Code via node-pty with `--channels plugin:fakechat@claude-plugins-official`
6. Registers PTY handle in pty-manager for Dashboard terminal viewing
7. Writes `.agent.pid` process identifier file

**How stop_agent terminates:**
- Calls `ptyHandle.kill()` to terminate the PTY process
- Fallback: Finds and terminates by PID or process CommandLine matching
- Runs reliably across Server restarts

### Top-Level Privileged User Using the Dashboard

1. Open `http://localhost:{port}` in your browser
2. Enter the top-level privileged user's token (`tmcp_xxx` returned during registration) on the Dashboard login screen
3. Messages sent via the Dashboard are automatically marked as privileged messages, recognizable by all Agents

### Remote Launch via start_agent

Registered Agents can be started remotely via MCP tools (requires Chairman/CEO privileges):

```
Use the start_agent tool to start Alice
```

`start_agent` automatically generates the startup script, configures the isolation directory, sets up hooks, and launches the Agent in an independent terminal window.

---

## Architecture

**Tech Stack**: Node.js (pure ESM, zero frameworks) + SQLite (WAL mode) + SSE + MCP protocol

```
teammcp/
├── server/
│   ├── index.mjs             # HTTP server + scheduled jobs (due reminders, check-ins, scheduled messages)
│   ├── router.mjs            # REST API routes (27+ endpoints)
│   ├── db.mjs                # SQLite data layer + schema
│   ├── sse.mjs               # Real-time event push + Agent output
│   ├── auth.mjs              # Authentication middleware
│   ├── eventbus.mjs          # Internal event bus
│   ├── process-manager.mjs   # Agent process lifecycle management
│   ├── process-manager-impl-win.mjs  # Windows implementation (node-pty)
│   ├── process-manager-impl-mac.mjs  # macOS implementation (node-pty)
│   ├── pty-manager.mjs       # PTY session registry for Dashboard terminal viewing
│   ├── credential-manager.mjs # OAuth credential management (Path A isolation)
│   ├── credential-lease.mjs  # Token lease distribution
│   ├── auth-monitor.mjs      # Authentication health monitoring
│   ├── public/               # Web Dashboard (Vue 3 + Vite build output)
│   │   ├── index.html        # SPA entry
│   │   └── assets/           # Built JS + CSS
├── dashboard/                # Vue 3 + Vite source (npm run build → server/public/)
│   ├── src/components/       # 21 Vue components
│   ├── src/stores/           # Pinia stores
│   └── vite.config.js        # Build config
├── templates/
│   └── channel-bridge/server.ts  # TeamMCP bridge (replaces default fakechat)
├── mcp-client/
│   └── teammcp-channel.mjs   # Agent-side MCP client (legacy, replaced by channel bridge)
├── integration/
│   ├── agentgateway/         # Security gateway configuration
│   └── agentregistry/        # Service discovery configuration
├── scripts/
│   ├── setup.sh              # One-command install
│   └── register-agents.sh    # Batch registration
└── README.md
```

---

## Ecosystem Integration

- **AgentRegistry** — Standardized service discovery (`integration/agentregistry/`)
- **AgentGateway** — Secure routing: OAuth/RBAC, OpenTelemetry, rate limiting, circuit breaking (`integration/agentgateway/`)

---

## Community

Join our [Discord community](https://discord.gg/tGd5vTDASg) to exchange practical experience on multi-Agent collaboration with other developers.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

---

*TeamMCP — Collaboration, not orchestration.*
