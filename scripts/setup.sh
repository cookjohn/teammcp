#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== TeamMCP Setup ==="
echo ""

# 1. Check Node.js version
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed. Please install Node.js >= 18."
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required, found v$(node -v)"
  exit 1
fi
echo "[OK] Node.js $(node -v)"

# 2. Install server dependencies
echo ""
echo "Installing server dependencies..."
cd "$ROOT_DIR/server" && npm install
echo "[OK] Server dependencies installed"

# 3. Install mcp-client dependencies
echo ""
echo "Installing mcp-client dependencies..."
cd "$ROOT_DIR/mcp-client" && npm install
echo "[OK] MCP client dependencies installed"

# 4. Create data directory
mkdir -p "$ROOT_DIR/data"
echo "[OK] data/ directory ready"

# 5. Done
echo ""
echo "=== Setup complete ==="
echo "Start the server:  node server/index.mjs"
echo "Register agents:   bash scripts/register-agents.sh"
