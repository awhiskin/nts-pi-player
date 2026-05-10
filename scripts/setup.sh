#!/usr/bin/env bash
# Bootstrap the NTS Pi Player on a fresh Raspberry Pi.
# Run from the repo root or from anywhere — the script locates itself.
# Idempotent: safe to re-run after fixing a problem.

set -euo pipefail

# --- helpers -----------------------------------------------------------------

c_red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }

step() { c_blue "==> $*"; }
ok()   { c_green "    ✓ $*"; }
die()  { c_red "ERROR: $*" >&2; exit 1; }

# --- locate the repo ---------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

# --- preflight ---------------------------------------------------------------

[ "$(id -u)" -eq 0 ] && die "Run this as your normal user, not root. The script calls sudo where needed."

if [ ! -f /proc/device-tree/model ] || ! grep -qi "raspberry pi" /proc/device-tree/model; then
  die "This doesn't look like a Raspberry Pi. Refusing to continue."
fi

[ -f "${REPO_DIR}/backend/app.py" ] || die "Can't find backend/app.py. Run from a clone of nts-pi-player."

step "Caching sudo credentials (you may be prompted once)"
sudo -v

# --- 1. apt packages ---------------------------------------------------------

step "Installing system packages via apt"
sudo apt update
sudo apt install -y \
  mpv yt-dlp \
  python3-venv python3-gpiozero python3-lgpio python3-websockets \
  alsa-utils \
  xserver-xorg xinit openbox chromium x11-xserver-utils \
  git
ok "apt packages installed"

# --- 2. python venv + pip ----------------------------------------------------

step "Setting up the Python virtualenv"
if [ ! -d "${REPO_DIR}/.venv" ]; then
  python3 -m venv --system-site-packages "${REPO_DIR}/.venv"
  ok "venv created at ${REPO_DIR}/.venv"
else
  ok "venv already exists, skipping create"
fi

"${REPO_DIR}/.venv/bin/pip" install --quiet -r "${REPO_DIR}/requirements.txt"
ok "Python deps installed"

# --- 3. systemd unit ---------------------------------------------------------

step "Installing nts-pi-player.service"
USER_NAME="$(whoami)"

sudo tee /etc/systemd/system/nts-pi-player.service >/dev/null <<EOF
[Unit]
Description=NTS Pi Player backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${REPO_DIR}
Environment=PATH=${REPO_DIR}/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${REPO_DIR}/.venv/bin/uvicorn backend.app:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nts-pi-player
ok "service installed, enabled, and started"

# --- 4. boot-to-console autologin -------------------------------------------

step "Configuring boot to console with autologin"
sudo raspi-config nonint do_boot_behaviour B2
ok "boot behaviour set (takes effect on next reboot)"

# --- 5. ~/.bash_profile startx hook -----------------------------------------

step "Adding startx hook to ~/.bash_profile"
PROFILE="${HOME}/.bash_profile"
MARKER="# nts-pi-player startx hook"

if grep -qF "${MARKER}" "${PROFILE}" 2>/dev/null; then
  ok "startx hook already present, skipping"
else
  cat >> "${PROFILE}" <<'EOF'

# nts-pi-player startx hook
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec startx -- -nocursor
fi
EOF
  ok "startx hook appended"
fi

# --- 6. openbox autostart (kiosk launcher) -----------------------------------

step "Installing openbox kiosk autostart"
AUTOSTART="${HOME}/.config/openbox/autostart"
mkdir -p "$(dirname "${AUTOSTART}")"

if [ -f "${AUTOSTART}" ] && ! grep -qF "nts-pi-player kiosk" "${AUTOSTART}"; then
  c_red "    ! ${AUTOSTART} already exists and isn't ours. Leaving it alone."
  c_red "      Inspect it manually and either remove or merge before re-running."
else
  cat > "${AUTOSTART}" <<'EOF'
# nts-pi-player kiosk autostart

# Disable screen blanking and DPMS power-off
xset s off
xset -dpms
xset s noblank

# Wait for the backend to come up
while ! curl -sf http://127.0.0.1:8000/ >/dev/null; do
  sleep 0.5
done

# Launch Chromium kiosk pointed at the local backend
chromium \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --force-device-scale-factor=1.50 \
  http://127.0.0.1:8000/
EOF
  ok "openbox autostart written"
fi

# --- 7. smoke test: play Channel 1, prompt for confirmation ------------------

step "Smoke test: playing NTS Channel 1 for ~6 seconds"

# Give the freshly-started service a moment to be ready to accept WS clients
for _ in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8000/ >/dev/null; then break; fi
  sleep 0.5
done

python3 - <<'PY'
import asyncio, json
from websockets.asyncio.client import connect

async def main():
    async with connect("ws://127.0.0.1:8000/ws") as ws:
        await ws.send(json.dumps({"type": "play", "card_id": "channel-1"}))

asyncio.run(main())
PY

sleep 6

echo
read -r -p "    Did you hear NTS Channel 1? [y/N] " ANSWER
echo

case "${ANSWER:-N}" in
  [Yy]*)
    ok "Audio confirmed."
    ;;
  *)
    c_red "Audio not confirmed. Setup is technically complete but the smoke test failed."
    c_red "Diagnostics:"
    c_red "  - Check audio output: sudo raspi-config -> System Options -> Audio"
    c_red "  - Service status:    systemctl status nts-pi-player"
    c_red "  - Service logs:      journalctl -u nts-pi-player -n 50"
    c_red "After fixing, restart the service (sudo systemctl restart nts-pi-player)"
    c_red "or re-run this script."
    exit 1
    ;;
esac

# --- 8. final reboot ---------------------------------------------------------

step "All steps complete. Rebooting in 5 seconds (Ctrl-C to abort)"
sleep 5
sudo reboot
