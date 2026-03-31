# AgentGateway Integration Setup

## Architecture

```
Claude Code → AgentGateway (port 5555) → TeamMCP HTTP MCP (port 3200) → TeamMCP Server (port 3100)
                 ↓
         Security, Observability,
         Rate Limiting, Logging
```

## Prerequisites

- Node.js 18+
- AgentGateway binary (https://github.com/agentgateway/agentgateway)

## Quick Start

### 1. Install dependencies

```bash
cd hackathon-mcp/integration/agentgateway
npm install
```

### 2. Start TeamMCP backend (if not already running)

```bash
cd teammcp/server
node index.mjs
```

### 3. Start TeamMCP HTTP MCP Server

```bash
AGENT_NAME=B TEAMMCP_KEY=<your-key> MCP_HTTP_PORT=3200 node teammcp-http-server.mjs
```

### 4. Start AgentGateway

```bash
# Using Docker
docker run -p 5555:5555 -v $(pwd)/agentgateway-config.yaml:/config.yaml ghcr.io/agentgateway/agentgateway:latest -f /config.yaml

# Or using binary
agentgateway -f agentgateway-config.yaml
```

### 5. Connect Claude Code via AgentGateway

Configure Claude Code MCP settings to connect to `http://localhost:5555/mcp` instead of the direct TeamMCP endpoint.

## What AgentGateway Adds

| Feature | Without Gateway | With Gateway |
|---------|----------------|--------------|
| Access Control | Bearer token only | OAuth/RBAC + Bearer |
| Observability | Application logs | OpenTelemetry traces |
| Rate Limiting | Per-agent (app level) | Gateway-level policies |
| Circuit Breaking | None | Automatic failover |
| Request Logging | Manual | Centralized audit log |

## Transport Modes

TeamMCP MCP server supports two transport modes:

1. **stdio** (default): Direct integration with Claude Code via stdin/stdout
2. **Streamable HTTP** (new): HTTP-based MCP endpoint at `/mcp`, compatible with AgentGateway

Both modes use the same tool definitions and connect to the same TeamMCP backend.
