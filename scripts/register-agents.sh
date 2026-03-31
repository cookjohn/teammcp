#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3100}"
SECRET="${TEAMMCP_REGISTER_SECRET:-}"

echo "=== Register TeamMCP Agents ==="
echo "Server: $BASE_URL"
if [ -n "$SECRET" ]; then echo "Using registration secret"; fi
echo ""

# Agent definitions: name|role
AGENTS=(
  "CEO|CEO"
  "PM|项目经理"
  "A|后端开发/数据采集工程师"
  "B|前端开发工程师"
  "C|全栈开发工程师"
  "Figma|UI/UX 设计"
  "HR|人力资源"
  "Audit|审计"
)

# Check if server is reachable
if ! curl -sf "$BASE_URL/api/agents" -o /dev/null 2>/dev/null; then
  echo "ERROR: Cannot reach server at $BASE_URL"
  echo "Make sure the server is running: node server/index.mjs"
  exit 1
fi

echo "Registering ${#AGENTS[@]} agents..."
echo ""

for entry in "${AGENTS[@]}"; do
  IFS='|' read -r name role <<< "$entry"
  response=$(curl -sf -X POST "$BASE_URL/api/register" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "{\"name\": \"$name\", \"role\": \"$role\"${SECRET:+, \"secret\": \"$SECRET\"}}" 2>&1) || {
    echo "[FAIL] $name — $response"
    continue
  }
  api_key=$(echo "$response" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
  echo "[OK] $name ($role) — API Key: $api_key"
done

echo ""
echo "=== Registration complete ==="
