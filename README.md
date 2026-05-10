# NTS Pi Player

A self-contained NTS Radio player for Raspberry Pi 4/5 with a small HDMI screen and a single rotary encoder. Full design lives in [`nts-pi-player-spec.md`](nts-pi-player-spec.md).

This README covers two things: deploying onto a Pi, and running the dev server on macOS.

---

## Hardware

- Raspberry Pi 4 or 5 (any RAM tier)
- HDMI display
- One rotary encoder with integrated push-switch (e.g. KY-040 or similar)

### Encoder wiring

| Encoder pin | GPIO  | Pin #         |
|-------------|-------|---------------|
| 5V/3v3      | —     | 1             |
| S1          | 17    | 11            |
| S2          | 27    | 13            |
| KEY         | 22    | 15            |
| GND         | —     | 39            |

Default GPIO pins can be overridden without a code edit by setting `NTS_ENCODER_A_PIN`, `NTS_ENCODER_B_PIN`, or `NTS_ENCODER_BUTTON_PIN` in the systemd unit's `Environment=` lines. If rotation comes out inverted on a different encoder (clockwise registers as counter-clockwise), swap the values of `NTS_ENCODER_A_PIN` and `NTS_ENCODER_B_PIN`.

My encoder has a pin for 5V but seems to work fine using 3V3 pin instead; important as the screen I will be using occupies both 5V pins.

---

## Install on a Raspberry Pi

Tested on Raspberry Pi OS Lite. Other Raspberry Pi OS variants likely work but are untested.

Two paths: an automated setup script, or the same steps spelled out manually.

### Path A — Automated install

From a fresh Pi (booted, on the network, accessible via SSH):

```sh
sudo apt update && sudo apt install -y git
git clone https://github.com/awhiskin/nts-pi-player.git
cd nts-pi-player
./scripts/setup.sh
```

The script does everything in Path B end-to-end, then plays NTS Channel 1 for a few seconds and asks `Did you hear audio? [y/N]`. If you confirm, it reboots; the kiosk comes up automatically on the attached display.

If you didn't hear audio, it bails with a hint to check audio output (see [Audio output](#audio-output)) and the service status (`systemctl status nts-pi-player`).

### Path B — Manual install

Same steps the script runs, in case you want to inspect or customise:

**1. Install system packages.**

```sh
sudo apt update
sudo apt install -y \
  mpv yt-dlp \
  python3-venv python3-gpiozero python3-lgpio python3-websockets \
  alsa-utils \
  xserver-xorg xinit openbox chromium x11-xserver-utils \
  git
```

**2. Clone the repo.**

```sh
git clone https://github.com/awhiskin/nts-pi-player.git
cd nts-pi-player
```

**3. Create the virtualenv and install Python deps.**

```sh
python3 -m venv --system-site-packages .venv
.venv/bin/pip install -r requirements.txt
```

`--system-site-packages` is required so the venv can see the apt-installed `gpiozero` and `lgpio` packages; the lgpio C extension is fragile to install via pip on a Pi, so we let apt own it.

**4. Install and start the systemd unit.**

```sh
sudo tee /etc/systemd/system/nts-pi-player.service >/dev/null <<EOF
[Unit]
Description=NTS Pi Player backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PWD
Environment=PATH=$PWD/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$PWD/.venv/bin/uvicorn backend.app:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nts-pi-player
```

At this point the app is running. Verify by browsing to `http://<pi-ip>:8000` from another device on the LAN — the keyboard fallback (see [Without an encoder](#without-an-encoder)) lets you play a stream and confirm audio is coming out of the Pi.

**5. Configure boot to console with autologin.**

```sh
sudo raspi-config nonint do_boot_behaviour B2
```

This sets the system to boot to a CLI on tty1 and autologin the current user.

**6. Add the startx hook to `~/.bash_profile`.**

```sh
cat >> ~/.bash_profile <<'EOF'

# nts-pi-player: start X (no cursor) on physical-console login
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec startx -- -nocursor
fi
EOF
```

When the autologin getty drops you onto tty1, this hook replaces the shell with `startx`, bringing up X with no mouse cursor. SSH sessions are unaffected.

**7. Add the openbox autostart kiosk launcher.**

```sh
mkdir -p ~/.config/openbox
cat > ~/.config/openbox/autostart <<'EOF'
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
```

**8. Reboot.**

```sh
sudo reboot
```

After reboot the Pi autologins, starts X, openbox runs the autostart, and Chromium opens fullscreen against the backend.

---

## Audio output

Default audio output is whatever the Pi is currently set to (typically the 3.5mm jack). To switch to HDMI or a USB DAC, run `sudo raspi-config` → System Options → Audio.

mpv follows the system default. After changing the device, restart the service so the next playback picks up the new sink:

```sh
sudo systemctl restart nts-pi-player
```

---

## Without an encoder

If the encoder isn't wired up yet (or you just want to drive the app from a laptop), browse to `http://<pi-ip>:8000` from any device on the LAN. The frontend forwards keyboard input to the backend as encoder events:

| Key                    | Action                                       |
|------------------------|----------------------------------------------|
| `←` / `↑`              | rotate counter-clockwise (previous item/page) |
| `→` / `↓`              | rotate clockwise (next item/page)             |
| `Enter`                | click                                        |
| Hold `Enter` (~500ms)  | long-press (back / mode toggle)              |

This works whether or not a physical encoder is connected.

---

## Development on macOS

Everything except the rotary encoder works on macOS unchanged.

```sh
brew install mpv yt-dlp
python3 -m venv .venv
.venv/bin/pip install fastapi 'uvicorn[standard]'
.venv/bin/uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
```

Open <http://localhost:8000> in any browser. `--reload` watches the project tree and restarts on file changes. Use the keyboard fallback above; gpiozero is skipped automatically off-Linux.

---

## Runtime state

Saved volume and cached taxonomies (genres, moods) live in `~/.nts-pi-player/`. It's created on first run and safe to delete — anything missing is fetched again on next boot.
