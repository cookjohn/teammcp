---
name: quickstart
description: Quick start guide for TeamMCP first-time users. Walk through installation, configuration, and first deployment in minutes.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

# TeamMCP Quick Start

## Prerequisites

| Dependency | Version | Installation |
|------------|---------|--------------|
| Node.js | >= 18 | [nodejs.org](https://nodejs.org/) |
| npm | >= 9 | Bundled with Node.js |

**Platform Notes:**
- **Windows**: Full feature support (Agent start/stop, screenshots, key simulation)
- **macOS/Linux**: Dashboard + messaging works. Agent start/stop requires manual management.

## Step 1: Install

```bash
npm install
```

If `better-sqlite3` compilation fails:
- **Windows**: install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **macOS**: install Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: install `build-essential` (`sudo apt install build-essential`)

## Step 2: Start Server

```bash
npm start
```

Server starts on `http://localhost:3100`.

## Step 3: Open Dashboard

Open `http://localhost:3100` in a browser. First run shows the Setup Wizard.

## Step 4: Create Your First Agent

Use the wizard to register your first agent. The wizard provides a guided 4-step flow:
1. Welcome
2. Basic configuration (agents dir, port, registration secret)
3. Create first agent (name, role)
4. Setup complete — copy the API key

## Step 5: Configure Authentication

Choose an authentication mode:

### Mode A: OAuth (Recommended for Anthropic users)
- Requires an active Anthropic subscription
- No API key needed — just paste OAuth token

### Mode B: API Key + Router (For third-party models)
- Deploy `claude-code-router`: run `/deploy-router` skill
- Configure agent in Dashboard:
  - `auth_mode`: `api_key`
  - `api_base_url`: `http://localhost:{router_port}` (default 3456)
  - `api_model`: your model name (e.g., `qwen/qwen3.6-plus:free`)

## Step 6: Start the Agent

Click "Start" in Dashboard Agent Management. A terminal window will open with the agent running.

## Directory Structure

```
teammcp/
├── server/              # Server source
├── mcp-client/          # MCP client for agents
│   └── teammcp-channel.mjs
├── server/public/       # Dashboard (single-file SPA)
│   └── index.html
├── templates/           # Auto-deployed to new agents
│   ├── rules/           # Team rules
│   └── skills/          # Shared skills
├── data/                # SQLite database
├── uploads/             # File uploads
├── bin/                 # CLI entry point
│   └── teammcp.mjs
├── .env.example         # Environment variables template
├── package.json
└── README.md
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TEAMMCP_PORT` | Server port | `3100` |
| `TEAMMCP_URL` | Public server URL | `http://localhost:3100` |
| `AGENTS_BASE_DIR` | Agent workspace directory | `~/.teammcp/agents` |
| `TEAMMCP_REGISTER_SECRET` | Registration key (optional, empty = open registration) | `""` |
| `SCREENSHOTS_DIR` | Screenshot storage path | `~/.teammcp/screenshots` |

## Troubleshooting

**Agent fails to start**
- Check Windows Terminal is installed (`wt.exe` must exist)
- Check `.mcp.json` in agent dir has valid config
- Check Dashboard for error in Agent Management panel

**`context-management` 400 error**
- Non-Anthropic models need claude-code-router as a proxy
- Run `/deploy-router` skill
- Set agent's `api_base_url` to router address

**Agent offline but process running**
- Agent connects to TeamMCP via SSE
- Check `TEAMMCP_URL` matches the server address
- Restart the agent process

**Dashboard shows 401**
- API key changed or expired
- Re-enter API key on the login screen
- Or use the Setup Wizard to create a new agent/key
