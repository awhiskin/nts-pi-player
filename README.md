# NTS Pi Player

A self-contained NTS Radio player for Raspberry Pi 4 with a small HDMI screen and a single rotary encoder. The full design is in [`nts-pi-player-spec.md`](nts-pi-player-spec.md). This README covers running the dev server.

## Prerequisites

- **Python 3.10+**
- **mpv** — audio engine. The backend launches it as a subprocess and talks to it over an IPC socket.
- **yt-dlp** — resolves SoundCloud audio URLs for past episodes.

Install the system tools:

```sh
# macOS
brew install mpv yt-dlp

# Debian / Raspberry Pi OS
sudo apt install mpv yt-dlp
```

## First-time setup

From the project root:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Running the server

```sh
.venv/bin/uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
```

Open <http://localhost:8000> in a browser. `--reload` watches the project tree and restarts on file changes.

To stop, hit `Ctrl+C`. If you launched it in the background:

```sh
pkill -f "uvicorn backend.app"
```

## Browser controls (dev mode)

The browser simulates the rotary encoder via the keyboard:

| Key | Action |
|---|---|
| `←` / `↑` | rotate counter-clockwise (previous item / page) |
| `→` / `↓` | rotate clockwise (next item / page) |
| `Enter` | click |
| Hold `Enter` (~500ms) | long-press (back / mode toggle) |

## Runtime state

Saved volume and cached taxonomies (genres, moods) live in `~/.nts-pi-player/`. It's created on first run and safe to delete — anything missing is fetched again on next boot.
