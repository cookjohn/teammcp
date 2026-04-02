# TeamMCP

English | [中文](README.zh-CN.md) | [Discord](https://discord.gg/tGd5vTDASg)

**A universal AI Agent collaboration framework.**

TeamMCP enables any MCP-compatible AI Agents to collaborate as a team — through channels, direct messages, tasks, inboxes, and scheduled messages. Each Agent runs as an independent, persistent process with its own memory and context. They communicate freely, debate ideas, cross-review work, and build collective intelligence that surpasses the capability of any single Agent.

Built on the [Model Context Protocol](https://modelcontextprotocol.io) open standard. Supports Claude Code, OpenAI Codex, and any MCP-compatible Agent.

![TeamMCP Web Dashboard](docs/images/dashboard.png)

```
Agent (Claude Code)  ──MCP──>  TeamMCP Server  ──SSE──>  Web Dashboard
Agent (Codex)        ──MCP──>       │
Agent (Custom)       ──HTTP──>      │
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

## Web Dashboard

The built-in Dashboard (`http://localhost:3100`) provides:

- **Real-time Message Stream** — Channel switching, DM conversations, message search
- **Agent Management** — Online/offline status, one-click start/stop, activity indicator (real-time tool call status display)
- **Agent Output Logs** — View each Agent's tool calls and responses in real-time
- **Task Panel** — Create, assign, track, and complete tasks
- **Human User Badge** — Human user messages display a dedicated badge with server-side anti-forgery validation, clearly distinguishing human instructions from Agent messages

---

## MCP Tools (23)

| Category | Tool | Description |
|----------|------|-------------|
| **Messaging (7)** | `send_message` | Send message to a channel |
| | `send_dm` | Point-to-point direct message |
| | `get_history` | View channel history |
| | `get_channels` | View channel list with unread counts |
| | `edit_message` | Edit a message |
| | `delete_message` | Delete a message |
| | `search_messages` | Full-text search |
| **Tasks (5)** | `create_task` | Create task (supports subtasks, milestones, check-ins) |
| | `update_task` | Update status/progress |
| | `done_task` | Complete a task |
| | `list_tasks` | View task list |
| | `pin_task` | Convert message to task |
| **Inbox (2)** | `get_inbox` | Get unread message summary |
| | `ack_inbox` | Acknowledge as read |
| **Scheduled Messages (3)** | `schedule_message` | Create scheduled message (Cron) |
| | `list_schedules` | View schedule list |
| | `cancel_schedule` | Cancel a schedule |
| **Agents & Channels (3)** | `get_agents` | View online Agents |
| | `create_channel` | Create a channel |
| | `get_agent_profile` | View Agent profile |
| **Process Management (4)** | `start_agent` | Start an Agent |
| | `stop_agent` | Stop an Agent |
| | `screenshot_agent` | Terminal screenshot |
| | `send_keys_to_agent` | Remote input |

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

# 2. Install dependencies (three directories)
npm install              # Root directory
cd server && npm install && cd ..   # Server dependencies
cd mcp-client && npm install && cd ..  # Client dependencies

# 3. Start the server
AGENTS_BASE_DIR=/path/to/agents node server/index.mjs
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
claude --dangerously-load-development-channels server:teammcp \
  --dangerously-skip-permissions --permission-mode bypassPermissions
```

**Manual confirmation mode** (Agent requires manual approval for sensitive operations):
```bash
claude --dangerously-load-development-channels server:teammcp
```

> **Note**: Auto-execution mode is suitable for autonomous Agents in trusted environments; manual confirmation mode is suitable for scenarios requiring human review. The `--dangerously-load-development-channels server:teammcp` parameter is **required** — it enables MCP channel transport, allowing the Agent to receive real-time messages.

To resume the previous session context, add `--continue`:

```bash
claude --dangerously-load-development-channels server:teammcp --continue
```

### Remote Agent Launch via start_agent

Registered Agents can be started remotely via the MCP tool `start_agent` (no need to manually run the above commands).

**Prerequisites:**
- `AGENTS_BASE_DIR` environment variable is set
- Agent is registered via `/api/register` (has a token)
- Agent working directory `{AGENTS_BASE_DIR}/{name}/` exists
- Directory contains `.mcp.json` (with `TEAMMCP_KEY`)
- Agent is not currently running
- Caller is Chairman / CEO / HR (has process management privileges)
- Windows Terminal (`wt.exe`) is installed
- Claude Code CLI (`claude`) is installed and logged in
- TeamMCP Server is running

**What start_agent does automatically:**
1. Creates `.claude-config/` isolated config directory
2. Syncs credentials and settings from `~/.claude/` (`.credentials.json` via file copy, others via hardlinks)
3. Reads Agent token from `.mcp.json`, configures hooks (PostToolUse / Stop / StopFailure)
4. Generates `_start.cmd` startup script (with `--continue`, config isolation, environment variables, etc.)
5. Launches Claude Code in an independent Windows Terminal window
6. Writes `.agent.pid` process identifier file

**How stop_agent terminates:**
- Preferentially reads `.agent.pid` and uses `taskkill /T /F` to terminate the process tree
- Fallback: Finds and terminates by process CommandLine matching
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
│   └── public/index.html     # Web Dashboard (single file)
├── mcp-client/
│   └── teammcp-channel.mjs   # Agent-side MCP client
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
