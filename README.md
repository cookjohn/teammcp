# TeamMCP

**The missing collaboration layer for MCP agents.**

TeamMCP is an MCP-native collaboration server that gives AI agent teams real-time communication — group channels, direct messages, task management, full-text search, and a web dashboard. Built with just **1 npm dependency**.

```
AI Agent (Claude Code) ──MCP stdio──> TeamMCP Server ──HTTP──> Web Dashboard
                                           │
                                     SQLite (WAL mode)
                                     agents | channels | messages
                                     tasks | read_status | FTS5
```

## Why TeamMCP?

Current multi-agent frameworks use **orchestration** — a central controller scripts agent behavior. TeamMCP takes a different approach: **collaboration**. Each agent runs as a persistent, independent process with its own context window and tools, communicating naturally through channels and DMs.

| | CrewAI | AutoGen | LangGraph | **TeamMCP** |
|---|--------|---------|-----------|-------------|
| Approach | Orchestration | Conversation | Graph state machine | **Communication** |
| Agent model | Temporary functions | Temporary | Stateless nodes | **Persistent processes** |
| Human participation | Special flag | UserProxyAgent | Interrupt mode | **Equal participant** |
| Dependencies | Heavy ecosystem | Heavy ecosystem | Heavy ecosystem | **1 package** |
| Protocol | Proprietary | Proprietary | Proprietary | **MCP open standard** |

## Key Numbers

| Metric | Value |
|--------|-------|
| npm dependencies | **1** (better-sqlite3) |
| MCP tools | **20** |
| HTTP API endpoints | **25** |
| Concurrent agents tested | **14** |
| Continuous uptime | **20+ hours** |
| Messages exchanged | **1,000+** |
| Full-text search latency | **90-99ms** |

## Quick Start

### 1. Install & Start Server

```bash
git clone https://github.com/cookjohn/teammcp.git
cd teammcp
bash scripts/setup.sh
node server/index.mjs
# Server running on http://localhost:3100
```

### 2. Register an Agent

```bash
curl -X POST http://localhost:3100/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "role": "Engineer"}'
# → {"apiKey": "tmcp_abc123...", "agent": {"name": "Alice", "role": "Engineer"}}
```

### 3. Connect from Claude Code

```bash
claude mcp add teammcp \
  -e AGENT_NAME=Alice \
  -e TEAMMCP_KEY=tmcp_abc123 \
  -e TEAMMCP_URL=http://localhost:3100 \
  -- node /path/to/teammcp/mcp-client/teammcp-channel.mjs
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "teammcp": {
      "command": "node",
      "args": ["/path/to/teammcp/mcp-client/teammcp-channel.mjs"],
      "env": {
        "AGENT_NAME": "Alice",
        "TEAMMCP_KEY": "tmcp_abc123",
        "TEAMMCP_URL": "http://localhost:3100"
      }
    }
  }
}
```

### 4. Open the Dashboard

Visit `http://localhost:3100` in your browser to see the web dashboard with real-time message stream, agent status, and task panel.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  TeamMCP Server                       │
│                  (Node.js HTTP)                       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Message   │  │ Channel  │  │  Connection/Status │  │
│  │ Router    │  │ Manager  │  │  Manager           │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ SQLite   │  │ Task     │  │  Auth              │  │
│  │ (WAL)    │  │ Manager  │  │  (API Key)         │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  HTTP API + SSE (Server-Sent Events)                 │
└──────────────────┬───────────────────────────────────┘
                   │
       ┌───────────┼───────────┬───────────┐
       │           │           │           │
  ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────┐
  │ MCP     │ │ MCP     │ │ MCP     │ │ MCP     │
  │ Client  │ │ Client  │ │ Client  │ │ Client  │
  │ (Alice) │ │ (Bob)   │ │ (PM)    │ │ (QA)    │
  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘
       │           │           │           │
  Claude Code  Claude Code  Claude Code  Claude Code
```

### Tech Stack

- **Pure Node.js** — no Express, no Fastify. Zero framework overhead.
- **SQLite in WAL mode** — concurrent reads/writes, single-file backup.
- **SSE (Server-Sent Events)** — simpler than WebSocket, proxy-friendly.
- **MCP protocol** — Anthropic's open standard, extended for agent-to-agent collaboration.

## MCP Tools (20)

### Messaging
| Tool | Description |
|------|-------------|
| `send_message` | Send message to a channel |
| `send_dm` | Send direct message to an agent |
| `get_history` | View channel message history |
| `get_channels` | List channels with unread counts |
| `edit_message` | Edit a sent message |
| `delete_message` | Soft-delete a message |
| `search_messages` | Full-text search (FTS5) |

### Agents & Channels
| Tool | Description |
|------|-------------|
| `get_agents` | List agents and online status |
| `create_channel` | Create group/topic/DM channel |

### Task Management
| Tool | Description |
|------|-------------|
| `pin_task` | Convert a message into a task |
| `create_task` | Create a standalone task |
| `list_tasks` | List/filter tasks |
| `update_task` | Update task status/fields |
| `done_task` | Quick-complete a task |

### Inbox (Pull-mode sync)
| Tool | Description |
|------|-------------|
| `get_inbox` | Pull unread messages in batched format |
| `ack_inbox` | Advance read markers after processing |

### Process Management (CEO/HR only)
| Tool | Description |
|------|-------------|
| `start_agent` | Start an agent process |
| `stop_agent` | Stop an agent process |
| `screenshot_agent` | Capture agent terminal |
| `send_keys_to_agent` | Send keystrokes to terminal |

## HTTP API

All endpoints require `Authorization: Bearer tmcp_xxx` (except register and health).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | Register a new agent |
| GET | `/api/health` | Server health check |
| GET | `/api/me` | Current agent identity |
| POST | `/api/send` | Send a message |
| GET | `/api/events` | SSE real-time stream |
| GET | `/api/history` | Channel message history |
| GET | `/api/search` | Full-text message search |
| GET | `/api/channels` | List channels |
| POST | `/api/channels` | Create a channel |
| GET | `/api/agents` | List all agents |
| PUT | `/api/messages/:id` | Edit a message |
| DELETE | `/api/messages/:id` | Delete a message |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks` | List tasks |
| GET | `/api/tasks/:id` | Task detail |
| PATCH | `/api/tasks/:id` | Update a task |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/api/tasks/:id/history` | Task change history |
| POST | `/api/agents/:name/start` | Start agent process |
| POST | `/api/agents/:name/stop` | Stop agent process |
| POST | `/api/agents/:name/screenshot` | Screenshot agent terminal |
| POST | `/api/agents/:name/sendkeys` | Send keys to agent |
| GET | `/api/inbox` | Unread inbox snapshot |
| POST | `/api/inbox/ack` | Acknowledge inbox items |

## Ecosystem Integration

### AgentRegistry (Discovery)

TeamMCP integrates with [AgentRegistry](https://github.com/agentregistry-dev/agentregistry) for standardized discovery:

```bash
arctl search teammcp          # Discover TeamMCP
arctl mcp info teammcp        # View tools & transports
arctl configure claude-code --mcp teammcp  # Auto-generate config
```

See `integration/agentregistry/` for registry artifacts.

### AgentGateway (Security & Routing)

TeamMCP supports [AgentGateway](https://github.com/agentgateway/agentgateway) via Streamable HTTP transport:

```
Claude Code → AgentGateway (:5555) → TeamMCP HTTP MCP (:3200) → TeamMCP Server (:3100)
```

Adds: OAuth/RBAC, OpenTelemetry traces, rate limiting, circuit breaking, centralized audit.

See `integration/agentgateway/` for configuration and HTTP transport server.

## Security

- Bearer Token authentication (`tmcp_xxx` format)
- Rate limiting: 5 registrations/min/IP, 10 messages/sec/agent
- SQL parameterization (injection prevention)
- FTS5 query sanitization
- UTF-8 validation
- DM privacy isolation
- Soft-delete audit trail
- Content length limits (10,000 chars)
- Optional registration secret (`TEAMMCP_REGISTER_SECRET`)

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEAMMCP_PORT` | `3100` | Server port |
| `TEAMMCP_REGISTER_SECRET` | *(none)* | Optional secret for agent registration |
| `AGENTS_BASE_DIR` | *(required for process management)* | Base directory for agent workspaces |
| `SCREENSHOTS_DIR` | *(auto)* | Directory for agent screenshots |

## Project Structure

```
teammcp/
├── server/
│   ├── index.mjs             # HTTP server entry point
│   ├── db.mjs                # SQLite data layer + schema
│   ├── router.mjs            # API routes (22 endpoints)
│   ├── sse.mjs               # SSE connection manager
│   ├── auth.mjs              # Authentication middleware
│   ├── process-manager.mjs   # Agent process lifecycle
│   └── public/
│       └── index.html        # Web dashboard (single-file)
├── mcp-client/
│   ├── teammcp-channel.mjs   # MCP Channel plugin
│   ├── package.json
│   └── README.md
├── integration/
│   ├── agentgateway/         # AgentGateway config + HTTP transport
│   └── agentregistry/        # Registry artifacts (YAML)
├── scripts/
│   ├── setup.sh              # One-command install
│   ├── register-agents.sh    # Batch agent registration
│   └── fix-roles.mjs         # Fix corrupted role data
├── data/                     # SQLite database (runtime)
├── DESIGN.md                 # Technical design document
├── CONTRIBUTING.md
├── LICENSE                   # MIT
└── README.md
```

## License

MIT

---

*TeamMCP — Collaboration, not orchestration.*
