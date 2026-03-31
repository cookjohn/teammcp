# AgentRegistry Integration Setup

## Overview

TeamMCP is registered in AgentRegistry as a discoverable MCP server and agent team,
enabling standardized discovery, configuration, and capability declaration.

## Architecture

```
AgentRegistry
    │
    ├── MCP Server Artifact: "teammcp"
    │   ├── 18 tools declared
    │   ├── stdio + Streamable HTTP transports
    │   └── Environment variables documented
    │
    └── Agent Catalog: "teammcp-agent-team"
        ├── 14 agent roles (CEO → Engineers → QA → Ops)
        ├── Capability declarations per role
        ├── Org hierarchy (reports_to)
        └── Permission levels (manager/developer/process_control)
```

## Prerequisites

- [AgentRegistry CLI (arctl)](https://github.com/agentregistry-dev/agentregistry)
- Node.js 18+

## Quick Start

### 1. Install AgentRegistry

```bash
# Using npm
npm install -g @agentregistry/cli

# Or from source
git clone https://github.com/agentregistry-dev/agentregistry
cd agentregistry && make install
```

### 2. Register TeamMCP MCP Server

```bash
arctl mcp publish -f teammcp-mcp-server.yaml
```

This registers TeamMCP as a discoverable MCP server with:
- 22 tool declarations (messaging, tasks, search, agent management)
- Two transport modes (stdio for direct use, Streamable HTTP for AgentGateway)
- Environment variable documentation
- Performance characteristics

### 3. Register Agent Team

```bash
arctl agent publish -f teammcp-agents.yaml
```

This registers 14 agent roles with:
- Role descriptions and capabilities
- Organizational hierarchy
- Permission levels
- MCP server references

### 4. Discover and Configure

```bash
# Search for TeamMCP
arctl search teammcp

# View MCP server details
arctl mcp info teammcp

# View agent team
arctl agent info teammcp-agent-team

# Auto-generate IDE configuration
arctl configure claude-code --mcp teammcp
```

## What AgentRegistry Adds

| Without Registry | With Registry |
|-----------------|---------------|
| Manual MCP configuration | `arctl configure` auto-setup |
| Undocumented agent roles | Standardized capability declarations |
| No discoverability | Searchable in global registry |
| Ad-hoc onboarding | Structured agent catalog |
| Unknown tool inventory | 18 tools formally declared |

## Files

- `teammcp-mcp-server.yaml` — MCP server artifact (tools, transports, env vars)
- `teammcp-agents.yaml` — Agent catalog (14 roles, capabilities, org hierarchy)
- `setup.md` — This document
