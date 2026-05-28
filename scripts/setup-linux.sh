#!/usr/bin/env bash
# setup-linux.sh — one-shot Linux deployment for TeamMCP.
#
# Codifies the manual steps a fresh Linux box needs:
#   - dedicated `teammcp` user (claude CLI refuses to run --dangerously-skip-permissions as root)
#   - code under /opt/teammcp, data under /home/teammcp/teammcp-data
#   - OS deps for node-pty native build + bun unzip
#   - claude CLI + bun installed where teammcp can reach them
#   - systemd unit running as teammcp, logs to journald
#
# Idempotent — safe to re-run.
#
# Usage:  sudo bash scripts/setup-linux.sh [path-to-teammcp-source]
#   If the path arg is omitted, the script assumes it's running from inside
#   the source tree and uses the parent of this script.
set -euo pipefail

TEAMMCP_USER="teammcp"
CODE_DIR="/opt/teammcp"
DATA_DIR="/home/${TEAMMCP_USER}/teammcp-data"
UNIT_PATH="/etc/systemd/system/teammcp.service"
PORT="${TEAMMCP_PORT:-3100}"

say()   { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m[!] %s\033[0m\n' "$*" >&2; }
die()   { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Must run as root. Try: sudo bash $0"

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
[[ -f "$SRC/server/index.mjs" ]] || die "Source path '$SRC' doesn't look like a teammcp checkout (no server/index.mjs)"

say "Source: $SRC"
say "Code target: $CODE_DIR"
say "Data target: $DATA_DIR"

# ── 1. teammcp user ────────────────────────────────────────
if id "$TEAMMCP_USER" &>/dev/null; then
  say "User '$TEAMMCP_USER' already exists"
else
  say "Creating user '$TEAMMCP_USER'"
  useradd -m -s /bin/bash "$TEAMMCP_USER"
fi

# ── 2. OS deps ─────────────────────────────────────────────
say "Installing OS dependencies (unzip + node-pty build toolchain)"
if command -v apt-get &>/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y unzip python3 make g++ curl ca-certificates >/dev/null
elif command -v dnf &>/dev/null; then
  dnf install -y unzip python3 make gcc-c++ curl >/dev/null
else
  warn "Unknown package manager — install unzip, python3, make, g++ manually"
fi

# ── 3. Node.js 22 ──────────────────────────────────────────
if ! command -v node &>/dev/null || ! node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)'; then
  say "Installing Node.js 22 via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null
else
  say "Node.js $(node --version) OK"
fi

# ── 4. claude CLI (system-wide) ────────────────────────────
if command -v claude &>/dev/null; then
  say "claude CLI: $(claude --version)"
else
  say "Installing @anthropic-ai/claude-code globally"
  npm install -g @anthropic-ai/claude-code >/dev/null
  command -v claude &>/dev/null || die "claude install failed"
fi

# ── 5. Code → /opt/teammcp ─────────────────────────────────
if [[ -d "$CODE_DIR" ]]; then
  say "Code dir $CODE_DIR exists — syncing changes (rsync if present, else cp)"
  if command -v rsync &>/dev/null; then
    rsync -a --delete --exclude=node_modules --exclude='.git' "$SRC/" "$CODE_DIR/"
  else
    cp -a "$SRC/." "$CODE_DIR/"
  fi
else
  say "Copying source to $CODE_DIR"
  mkdir -p "$CODE_DIR"
  if command -v rsync &>/dev/null; then
    rsync -a --exclude=node_modules --exclude='.git' "$SRC/" "$CODE_DIR/"
  else
    cp -a "$SRC/." "$CODE_DIR/"
  fi
fi

# ── 6. Install server deps ─────────────────────────────────
say "Installing server npm deps (node-pty native build runs here)"
( cd "$CODE_DIR" && npm install --no-audit --no-fund --omit=dev >/dev/null 2>&1 ) || \
  ( cd "$CODE_DIR" && npm install --no-audit --no-fund >/dev/null )

# ── 7. Build dashboard ─────────────────────────────────────
if [[ -d "$CODE_DIR/dashboard/src" ]]; then
  say "Building dashboard (Vite)"
  ( cd "$CODE_DIR/dashboard" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null )
fi

# ── 8. Data dir ────────────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── 9. chown to teammcp ────────────────────────────────────
say "chown -R $TEAMMCP_USER:$TEAMMCP_USER $CODE_DIR $DATA_DIR"
chown -R "$TEAMMCP_USER:$TEAMMCP_USER" "$CODE_DIR"
chown -R "$TEAMMCP_USER:$TEAMMCP_USER" "$DATA_DIR"

# ── 10. bun (under teammcp's home) ─────────────────────────
if [[ -x "/home/${TEAMMCP_USER}/.bun/bin/bun" ]]; then
  say "bun already installed for $TEAMMCP_USER ($(/home/${TEAMMCP_USER}/.bun/bin/bun --version))"
else
  say "Installing bun under /home/$TEAMMCP_USER/.bun"
  sudo -u "$TEAMMCP_USER" bash -lc 'curl -fsSL https://bun.sh/install | bash' >/dev/null
fi
# Symlink for system-wide PATH access (teammcp's home is 755 by default so this works)
ln -sf "/home/${TEAMMCP_USER}/.bun/bin/bun" /usr/local/bin/bun

# ── 11. systemd unit ───────────────────────────────────────
say "Writing systemd unit: $UNIT_PATH"
cat > "$UNIT_PATH" <<EOF
[Unit]
Description=TeamMCP Server (as ${TEAMMCP_USER} user)
After=network.target

[Service]
Type=simple
User=${TEAMMCP_USER}
Group=${TEAMMCP_USER}
WorkingDirectory=${CODE_DIR}
Environment=HOME=/home/${TEAMMCP_USER}
Environment=TEAMMCP_HOME=${DATA_DIR}
Environment=TEAMMCP_PORT=${PORT}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/${TEAMMCP_USER}/.bun/bin
ExecStart=/usr/bin/node ${CODE_DIR}/server/index.mjs
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable teammcp.service >/dev/null

# ── 12. Done ───────────────────────────────────────────────
cat <<EOF

$(printf '\033[1;32m')✓ Setup complete$(printf '\033[0m')

Next steps:
  1. (Optional) Authenticate claude as the teammcp user so spawned agents
     inherit the OAuth credentials:
       sudo -u ${TEAMMCP_USER} -i claude /login

  2. Start the service:
       systemctl start teammcp.service

  3. Tail logs:
       journalctl -u teammcp.service -f

  4. Verify health:
       curl http://127.0.0.1:${PORT}/api/health
       curl http://127.0.0.1:${PORT}/api/system/health

  5. Open the dashboard:
       http://<this-host>:${PORT}

EOF
