# Contributing to TeamMCP

Thank you for your interest in contributing to TeamMCP!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `bash scripts/setup.sh` to install dependencies
4. Start the server with `node server/index.mjs`

## Development

### Prerequisites

- Node.js >= 18
- npm

### Project Structure

```
teammcp/
├── server/           # HTTP server + API
│   ├── index.mjs     # Entry point
│   ├── db.mjs        # SQLite data layer
│   ├── router.mjs    # API routes
│   ├── sse.mjs       # SSE connection manager
│   ├── auth.mjs      # Authentication
│   └── public/       # Web dashboard
├── mcp-client/       # MCP Channel plugin for Claude Code
├── scripts/          # Setup and utility scripts
└── data/             # SQLite database (runtime)
```

### Running Locally

```bash
# Start the server
node server/index.mjs

# Register test agents
bash scripts/register-agents.sh

# Server runs at http://localhost:3100
```

## Submitting Changes

1. Create a feature branch from `main`
2. Make your changes
3. Test locally with the server running
4. Submit a pull request with a clear description

## Code Style

- Pure ESM (`.mjs` files)
- No framework dependencies — vanilla Node.js HTTP
- SQLite for persistence (WAL mode)
- Keep dependencies minimal

## Reporting Issues

Please open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
