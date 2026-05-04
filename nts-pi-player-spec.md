# NTS Pi Player — Project Specification

A self-contained NTS Radio player for Raspberry Pi 4, controlled by a single rotary encoder, with a 7" HDMI screen showing a full-viewport carousel UI.

---

## 1. Goal

Build a small dedicated unit running on a Raspberry Pi 4 that:

- Plays NTS Radio's two live channels.
- Plays NTS' Infinite Mixtapes.
- Browses past episodes by genre and by mood.
- Plays past episodes (sourced from SoundCloud via yt-dlp).
- Is operated entirely with one rotary encoder (rotate + click + long-press).
- Displays a full-viewport carousel UI on an attached 7" HDMI screen.

## 2. Non-goals

These are deliberately excluded — do not implement them:

- Free-text search.
- Multi-genre or multi-mood combination filters.
- Date or location-based filtering.
- Artist lookup.
- User accounts, favourites, playlists.
- Any audio playback through the browser.
- Touch input, keyboard input, mouse input.
- Any hardware buttons beyond the single rotary encoder.

---

## 3. Hardware

- Raspberry Pi 4 (any RAM tier — 2GB sufficient).
- 7" HDMI display, target resolution 1024×600.
- One rotary encoder with integrated push-switch (e.g. KY-040 or similar). Three GPIO pins used: A, B, switch.
- Audio output via the Pi's 3.5mm jack or HDMI audio (whichever the display supports).

No other input hardware. No buttons.

---

## 4. Architecture

Three cooperating processes on the Pi:

```
  ┌─────────────────────────────────────────┐
  │  Chromium (kiosk mode, fullscreen)      │   ← display
  │  ── renders HTML/CSS/JS UI              │
  └────────────────┬────────────────────────┘
                   │  HTTP + WebSocket (localhost)
  ┌────────────────▼────────────────────────┐
  │  Python backend (FastAPI + uvicorn)     │   ← brain
  │  ── serves UI + JSON menu data          │
  │  ── proxies & caches NTS API calls      │
  │  ── reads rotary encoder via GPIO       │
  │  ── pushes scroll/click events to UI    │
  │  ── invokes yt-dlp to resolve URLs      │
  │  ── controls mpv via JSON IPC socket    │
  │  ── manages playback queue              │
  └────────────────┬────────────────────────┘
                   │  JSON-IPC over unix socket
  ┌────────────────▼────────────────────────┐
  │  mpv (--idle --no-video)                │   ← audio
  │  ── plays HLS / MP3 / Icecast streams   │
  └─────────────────────────────────────────┘
```

Key principle: **the browser is silent**. mpv owns all audio playback. The browser only renders the UI and forwards user intent (received via WebSocket) to the backend.

### Why each piece

- **Chromium kiosk** — gives polished, fluid UI from HTML/CSS for almost no effort. Avoids fighting with native Python GUI frameworks on the Pi.
- **mpv** — handles HLS playlists, network hiccups, format detection, and exposes a clean JSON IPC socket. Don't reinvent it.
- **Python backend** — only sensible language for GPIO on the Pi, fine for shelling out to yt-dlp, fine for proxying NTS calls.

### Dependencies

Python packages (install via `pip` or `apt`):

- `fastapi`
- `uvicorn[standard]` (includes websockets support)
- `gpiozero` (typically pre-installed on Raspberry Pi OS)

External binaries (install via `apt`):

- `mpv`
- `yt-dlp`
- `chromium-browser`

No other Python dependencies. HTTP calls to NTS use stdlib `urllib.request`.

---

## 5. NTS API Reference

NTS has no documented API. All endpoints below were discovered by reading the source of community projects and by browser DevTools inspection of nts.live. They are stable enough to build on, but unofficial.

Base URL: `https://www.nts.live/api/v2`

### 5.1 Endpoints used by this project

| Method | Path | Purpose |
|---|---|---|
| GET | `/live` | Now-playing on both live channels |
| GET | `/mixtapes` | List of all Infinite Mixtapes with stream URLs |
| GET | `/genres` | Full genre taxonomy (top-level + subgenres) |
| GET | `/moods` | Full mood taxonomy |
| GET | `/search/episodes` | Browse / filter episodes |
| GET | `/shows/{show-alias}` | Show metadata + recent episodes |
| GET | `/shows/{show-alias}/episodes/{episode-alias}` | Full episode detail |

### 5.2 Live stream URLs

Hardcode these. They are not exposed via the API; they are stable constants.

- Channel 1: `https://stream-relay-geo.ntslive.net/stream`
- Channel 2: `https://stream-relay-geo.ntslive.net/stream2`

Both are plain HTTP audio streams that mpv plays directly with no resolution step.

### 5.3 Mixtape stream URLs

Returned by `/api/v2/mixtapes` in each mixtape's `audio_stream_endpoint` field, e.g. `https://stream-mixtape-geo.ntslive.net/mixtape4` for Poolside. Plain HTTP streams; mpv plays them directly.

### 5.4 Genre / mood browse

Use `/api/v2/search/episodes` with the `genres[]` or `moods[]` query parameter:

```
GET /api/v2/search/episodes?genres[]=ambientnewage&offset=0&limit=20
GET /api/v2/search/episodes?genres[]=ambientnewage-ambient&offset=0&limit=20
GET /api/v2/search/episodes?moods[]=moods-the-healing-place&offset=0&limit=20
```

Both top-level genre IDs (e.g. `jazz`) and subgenre IDs (e.g. `jazz-ambientjazz`) work as filter values. Top-level filters return episodes tagged with any of that genre's subgenres.

**Important:** multi-value `genres[]` is **AND, not OR**. `genres[]=jazz&genres[]=avantgarde` returns episodes tagged with *both* genres simultaneously. We only ever pass a single value — multi-genre selection is a non-goal.

`moods[]` works identically.

### 5.5 Past episode audio

Each search/episode response returns an `audio_sources` array. Each entry has a `url` (a SoundCloud page URL, **not** a direct audio file) and `source` (always `"soundcloud"` in practice).

To get a playable URL, shell out to yt-dlp:

```bash
yt-dlp -g --no-warnings --no-playlist <soundcloud-page-url>
```

yt-dlp returns one or more lines on stdout. Each is a signed HLS playlist URL on `playback.media-streaming.soundcloud.cloud` (AAC 160k). Hand the first line to mpv via `loadfile`.

**TTL warning:** resolved URLs are valid for approximately 2 hours (signed by SoundCloud's CloudFront with `expires=` timestamps). Resolve on demand when the user hits play. Never pre-resolve and cache long-term.

Some episodes have empty `audio_sources` (rights restrictions). The UI must handle this — show "Not available" and skip on auto-advance.

### 5.6 Response shapes (key ones)

Search response:

```json
{
  "metadata": {
    "popular_terms": ["..."],
    "resultset": { "count": 12503, "offset": 0, "limit": 10 }
  },
  "results": [
    {
      "title": "Episode Title",
      "article_type": "episode",
      "article": { "path": "/shows/show-alias/episodes/episode-alias" },
      "audio_sources": [{ "url": "https://soundcloud.com/...", "source": "soundcloud" }],
      "image": { "large": "...", "medium_large": "...", "medium": "...", "small": "...", "thumb": "..." },
      "local_date": "29 Oct 2022",
      "location": "London",
      "genres": [{ "id": "ambientnewage-ambient", "name": "Ambient" }]
    }
  ]
}
```

Live response (per channel):

```json
{
  "results": [
    {
      "channel_name": "1",
      "now": {
        "broadcast_title": "Show Name",
        "start_timestamp": "2026-05-04T13:00:00Z",
        "end_timestamp":   "2026-05-04T15:00:00Z",
        "embeds": { "details": { "name": "...", "description": "...", "media": { "picture_large": "..." } } }
      },
      "next": { "broadcast_title": "Next Show", "...": "..." }
    }
  ]
}
```

Genre taxonomy (fetched once on first run, cached to disk under `~/.nts-pi-player/`, refreshed weekly):

```json
{
  "results": [
    {
      "id": "ambientnewage",
      "name": "ambient / new age",
      "subgenres": [
        { "id": "ambientnewage-ambient", "name": "Ambient" },
        { "id": "ambientnewage-newage",  "name": "New Age" }
      ]
    }
  ]
}
```

20 top-level genres, 432 subgenres total, ~84,907 episodes in the archive.

### 5.7 Show pagination

`/shows/{alias}` embeds `embeds.episodes.results` (default ~12 episodes) with a `metadata.resultset.count` for the total. For shows with longer back-catalogues, follow the `episodes` link with `offset=`/`limit=` to paginate. Not critical for v1 — most users will browse via genre rather than show.

### 5.8 Etiquette

NTS is a small, supporter-funded operation. Be a polite client:

- Set a recognisable `User-Agent` on every request (e.g. `nts-pi-player/0.1`).
- Cache aggressively where data is stable: genre taxonomy, mood taxonomy, mixtape list.
- Don't poll the live endpoint faster than once every 30 seconds.

---

## 6. UI specification

### 6.1 The carousel model

The entire viewport shows **one card at a time**. Rotating the encoder swaps the whole screen to the next card with a transition. Big, bold, immediately clear what you're looking at. NTS' own response data includes large square artwork (`picture_large`, `image.large`) per show / episode / mixtape — use it as the card background.

The screen never shows a list. Only ever one card.

### 6.2 Decks

A "deck" is an ordered list of cards. Decks are nested.

**Root deck:**

```
[Now Playing] [Live] [Mixtapes] [Genres] [Moods] [Back to Top]
```

**Live deck:**

```
[Back] [Channel 1] [Channel 2] [Back to Top]
```

**Mixtapes deck:**

```
[Back] [Poolside] [Slow Focus] [Low Key] ... (~33 mixtapes) [Back to Top]
```

**Genres deck:**

```
[Back] [Ambient / New Age] [Electronica / Downtempo] ... (20 entries) [Back to Top]
```

**Genre detail deck** (e.g. after clicking "Ambient / New Age"):

```
[Back] [All Ambient / New Age] [Subgenre: Ambient] [Subgenre: Fourth World] ... [Episode list] [Back to Top]
```

Selecting "All …" or any subgenre row enters an **episode deck**: a paginated list of NTS episodes for that filter, with `[Back]` prepended and `[Back to Top]` appended.

**Moods deck:** structurally identical to Genres deck.

### 6.3 Mandatory rows

Every deck — **including root** — ends with a `[Back to Top]` row. Every non-root deck **also** starts with a `[Back]` row.

- `[Back]` → unwinds one deck level (e.g. genre detail → genres list). Reachable by scrolling counter-clockwise from the default cursor, or via long-press anywhere.
- `[Back to Top]` → scrolls the cursor to the first content row of the **current deck**. It does **not** navigate up a level — that's what `[Back]` and long-press are for. The intended use is jumping back to the top of a long list (e.g. an episode deck) without abandoning the deck.

**Default cursor on deck entry.** When a deck is freshly pushed onto the stack, the cursor lands on the **first real content row**, not on `[Back]`:

- On root (initial state): cursor on `[Now Playing]` (index 0).
- On any non-root deck: cursor on the row immediately after `[Back]` (index 1).

This means `Click` on entry never triggers Back — the user came to do something, and the default action should be the most likely intent. `[Back]` is therefore mostly a discoverability fallback; long-press is the primary back gesture.

### 6.4 Now Playing card

Now Playing is a card in the root deck like any other, but its content is dynamic and its gesture handlers are different.

Content:
- Large artwork of currently playing item.
- Track / show title.
- Subtitle (e.g. show name, mixtape name, "LIVE — Channel 1").
- Elapsed / total time (where applicable — live streams have no total).
- Visual indicator of current mode (volume mode by default; scroll mode when toggled in).

When nothing is playing: show an idle state ("Nothing playing"), but the card is still selectable and the gestures still apply (click does nothing, long-press toggles to scroll mode).

### 6.5 Visual transitions

Card-to-card transition on rotate: short slide animation (~150-200ms), in the rotation direction. Long enough to read as motion, short enough not to delay rapid scrolling. Disable transitions during velocity-accelerated scrolling (see 7.2).

---

## 7. Gesture specification

The complete gesture set:

| Where | Gesture | Action |
|---|---|---|
| Any non-Now-Playing card | Rotate | Move carousel to next/previous card |
| Any non-Now-Playing card | Click | Select / drill into card |
| Any non-Now-Playing card, in a sub-deck | Long-press | Equivalent to selecting `[Back]` row (unwind one deck level) |
| Any non-Now-Playing card, on the root deck | Long-press | Cursor returns to Now Playing |
| Now Playing (in volume mode) | Rotate | Volume up / down |
| Now Playing (in volume mode) | Click | Play / Pause |
| Now Playing (in volume mode) | Long-press | Switch to scroll mode |
| Now Playing (in scroll mode) | Rotate | Move carousel (root deck) |
| Now Playing (in scroll mode) | Click | Drill into selected card |
| Now Playing (in scroll mode) | Long-press | Switch back to volume mode |

### 7.1 Long-press timing

Threshold: **500ms**. Make this a constant in the backend so it can be tuned.

Provide visual feedback during the press — a subtle progress ring or fade overlay confirms the gesture is being recognised, and the user knows when to release.

### 7.2 Velocity acceleration

Long decks (episode lists with 10,000+ entries) are unusable at one-card-per-tick. Implement velocity acceleration:

- Track time between rotation ticks.
- If two ticks arrive within (say) 80ms, scale up the step: 1 card → 5 cards → 10 cards.
- Reset to 1 card per tick after 200ms of no rotation.

During fast scrolling, suppress card transitions and just snap.

Tune thresholds once running on real hardware.

---

## 8. Playback behaviour

### 8.1 Play flow

1. User clicks a playable card (channel, mixtape, episode).
2. Frontend sends `POST /play` with the card's identifier.
3. Backend resolves the URL:
   - **Live channel** → use the hardcoded stream URL.
   - **Mixtape** → use `audio_stream_endpoint` from the cached mixtape list.
   - **Episode** → call `yt-dlp -g <soundcloud-url>` to get the HLS playlist.
4. Backend sends `{"command": ["loadfile", "<url>"]}` to mpv via JSON IPC.
5. Backend records the **queue context** (see 8.3).
6. Frontend auto-navigates to Now Playing card.
7. Backend pushes `now_playing` updates to frontend via WebSocket.

### 8.2 mpv IPC

Start mpv once at backend startup:

```bash
mpv --idle --no-video --input-ipc-server=/tmp/mpv-socket
```

Talk to it by writing line-delimited JSON to `/tmp/mpv-socket`. Read replies from the same socket.

Key commands:

- `{"command": ["loadfile", "<url>"]}` — start playback
- `{"command": ["set_property", "pause", true]}` / `false` — pause/resume
- `{"command": ["set_property", "volume", 75]}` — volume 0–100
- `{"command": ["get_property", "time-pos"]}` — current position
- `{"command": ["get_property", "duration"]}` — total length

Subscribe to property changes for `time-pos` and `eof-reached` rather than polling.

### 8.3 Auto-advance

When playback ends (mpv signals `eof-reached`), play the next item in the **queue context** — the list the current item was selected from.

Queue contexts:
- Selected from "Latest Episodes" (root → Latest if you add it later, or the genre-filtered episode list) → next item in that paginated list.
- Selected from a genre/subgenre's episode list → next episode in that filtered list.
- Selected from a mixtape → mixtapes are infinite streams, no auto-advance needed.
- Selected as a live channel → no auto-advance (live is always live).
- Cold start (first play after boot, no context) → fall back to fetching `/api/v2/search/episodes` (latest episodes) and play the next.

The backend records `(deck_id, position)` when each playable card is selected. On `eof-reached`, it advances `position` by 1 and plays that item. Pages forward in the underlying API call as needed.

If the next item has no `audio_sources`, skip it and try the one after.

### 8.4 Volume

Volume is mpv state, set via the `volume` property. Persist last-set volume to a small file (`~/.nts-pi-player/state.json`) so it survives reboots.

Default volume on first boot: 60.

---

## 9. WebSocket protocol

Single WebSocket between browser and backend. JSON messages.

### 9.1 Backend → Frontend

```json
{ "type": "encoder", "event": "rotate", "direction": "cw",  "velocity": 1 }
{ "type": "encoder", "event": "rotate", "direction": "ccw", "velocity": 5 }
{ "type": "encoder", "event": "click" }
{ "type": "encoder", "event": "long_press" }

{ "type": "now_playing", "title": "...", "subtitle": "...", "artwork": "...",
  "elapsed": 124, "duration": 3600, "paused": false, "volume": 60 }

{ "type": "deck_data", "deck_id": "genres",
  "cards": [ { "id": "back", "label": "Back" }, { "id": "ambientnewage", "label": "Ambient / New Age", "artwork": "..." }, ... ] }
```

### 9.2 Frontend → Backend

The frontend doesn't need to push much — encoder events come from the backend, not from the browser. The frontend mostly *requests* data:

```json
{ "type": "request_deck", "deck_id": "genres" }
{ "type": "request_deck", "deck_id": "genre:ambientnewage" }
{ "type": "request_deck", "deck_id": "episodes:ambientnewage-ambient", "offset": 0, "limit": 30 }

{ "type": "play", "card_id": "channel-1" }
{ "type": "play", "card_id": "episode:show-alias/episode-alias", "deck_context": "episodes:ambientnewage-ambient" }

{ "type": "pause" }
{ "type": "resume" }
{ "type": "set_volume", "value": 70 }
```

The backend is the single source of truth for app state. The frontend is a renderer that reacts to backend messages.

---

## 10. Suggested file layout

```
nts-pi-player/
├── README.md
├── pyproject.toml              # or requirements.txt
├── backend/
│   ├── __init__.py
│   ├── app.py                  # FastAPI app, WebSocket handler, HTTP routes
│   ├── nts.py                  # NTS API client (urllib-based, no requests dep)
│   ├── player.py               # mpv IPC wrapper
│   ├── queue.py                # auto-advance queue + deck context tracking
│   ├── encoder.py              # rotary encoder reader (gpiozero)
│   ├── resolver.py             # yt-dlp subprocess wrapper
│   └── state.py                # persistent state (volume, cached taxonomies)
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── carousel.js             # carousel rendering, WebSocket client
└── scripts/
    ├── start.sh                # launches mpv, backend, chromium
    └── nts-pi-player.service   # systemd unit for autostart
```

Runtime state (cached taxonomies, persistent volume) lives under `~/.nts-pi-player/`, created on first run. Nothing needs to be checked in.

---

## 11. Implementation order

Build in slices. Each slice should produce something demonstrably working before the next is started.

### Slice 1 — Audible hello world

- FastAPI backend serving a single hardcoded HTML page.
- Page has two buttons: "Channel 1", "Channel 2".
- Backend launches mpv on click, plays the live stream.
- No encoder, no menu, no carousel, no API calls beyond the hardcoded URLs.
- Run from a normal terminal on the Pi (not kiosk yet).

**Done when:** clicking either button produces audio from the Pi.

### Slice 2 — Encoder integration

- Add `encoder.py` reading the rotary encoder via gpiozero.
- WebSocket from backend pushes rotate/click/long-press events to the page.
- The page logs them to the console.

**Done when:** rotating the physical encoder produces JS console events in the browser.

### Slice 3 — Carousel UI

- Replace the two-button page with a carousel renderer.
- Hardcode the root deck for now: `[Now Playing] [Live]`.
- Live deck contains `[Back] [Back to Top] [Channel 1] [Channel 2]`.
- Encoder rotate moves cards. Click selects. Long-press goes back.
- Now Playing card is static placeholder text.
- Selecting a channel still plays via the existing mpv pipeline.

**Done when:** you can navigate to a live channel and play it using only the encoder.

### Slice 4 — NTS API integration (live + mixtapes)

- Add `nts.py`. Implement `/live` and `/mixtapes` fetchers, with caching.
- Live cards now show real now-playing info from the API.
- Add Mixtapes deck, populated from the API.
- Cache live data for 30s, mixtapes for 1 hour.

**Done when:** the Live and Mixtapes decks reflect real NTS data and play real audio.

### Slice 5 — Genres + moods + episodes

- On first run, fetch `/api/v2/genres` and `/api/v2/moods`; cache to `~/.nts-pi-player/`. Refresh weekly.
- Build Genres deck from cached taxonomy.
- Genre detail deck shows `[All <genre>] + subgenres`.
- Episode deck loads from `/api/v2/search/episodes?genres[]=...`.
- Implement pagination ("Load more" or transparent fetch as cursor approaches end).
- Implement yt-dlp resolution for episode play.
- Implement Moods deck the same way.

**Done when:** you can browse to and play any past NTS episode.

### Slice 6 — Now Playing screen + auto-advance

- Real Now Playing card with artwork, title, elapsed/duration.
- Volume mode + scroll mode toggle.
- mpv property subscriptions for `time-pos` and `eof-reached`.
- Implement queue context tracking.
- Auto-advance on episode end.

**Done when:** an episode finishes and the next one in the same list starts automatically.

### Slice 7 — Velocity acceleration + polish

- Velocity-based rotation acceleration in `encoder.py`.
- Card transitions / animations.
- Visual feedback for long-press in progress.
- Long-press exit gesture.

### Slice 8 — Boot integration

- `scripts/start.sh` launches mpv, backend, and Chromium in kiosk mode.
- `nts-pi-player.service` systemd unit for boot autostart.
- Hide cursor, disable screen blanking.

---

## 12. Recon notes worth keeping

- Live and mixtape stream URLs are hardcoded constants — they're not in the API.
- Genre and mood taxonomies are stable. Fetch once on first run, cache to disk, refresh weekly.
- The taxonomy IDs are flat strings (e.g. `ambientnewage-ambient`), no `genres-` prefix despite some older docs.
- `genres[]` filter values accept both top-level (`jazz`) and subgenre (`jazz-ambientjazz`) IDs.
- yt-dlp resolved URLs expire in ~2 hours. Resolve on play, not in advance.
- Auto-advance must skip episodes with empty `audio_sources`.
- Total NTS archive is ~84,907 episodes across 20 top-level genres / 432 subgenres.
- Don't poll `/live` faster than every 30 seconds.
- Set a `User-Agent` header identifying this app on every NTS request.

---

## Appendix A: Development on a non-Pi machine

Everything except the rotary encoder works on a Mac (or any non-Pi machine) with no changes. Build the app there first and swap in the real encoder when the Pi arrives.

### A.1 Setup

Mac:

```
brew install mpv yt-dlp
python3 -m pip install fastapi 'uvicorn[standard]'
```

Linux equivalent: `apt install mpv yt-dlp` then the same pip install.

No Chromium needed during development — open the app in any browser at `http://localhost:8000`. No kiosk mode, no systemd. Run `uvicorn backend.app:app --reload` from a terminal.

### A.2 Encoder abstraction

The encoder must sit behind an interface so the same backend code runs on both Mac (no GPIO) and Pi (real encoder). Suggested shape:

```python
# backend/encoder.py
from typing import Callable

EncoderEvent = dict   # {"event": "rotate"|"click"|"long_press", "direction"?: "cw"|"ccw", "velocity"?: int}

class EncoderInput:
    def start(self, on_event: Callable[[EncoderEvent], None]) -> None: ...

class GPIOEncoder(EncoderInput):
    """Real encoder via gpiozero.RotaryEncoder + gpiozero.Button. Pi only."""
    ...

class WebSocketEncoder(EncoderInput):
    """Dev stub. Receives encoder-shaped events from the frontend over
    the WebSocket and forwards them to the same on_event callback
    GPIOEncoder uses. No downstream code differs between modes."""
    ...
```

Pick the implementation at startup:

```python
def make_encoder() -> EncoderInput:
    try:
        import gpiozero  # noqa
        return GPIOEncoder(...)
    except (ImportError, OSError):
        return WebSocketEncoder()
```

`OSError` catches the case where `gpiozero` is importable but no GPIO is present.

### A.3 Keyboard stub in the frontend

When `WebSocketEncoder` is active, the frontend captures keyboard events and sends them to the backend over the WebSocket using the same `{"type": "encoder", ...}` message shape the backend would normally push the other direction. The backend receives them and processes them identically to GPIO events.

Key bindings:

| Key | Encoder action |
|---|---|
| `ArrowLeft`  | Rotate counter-clockwise |
| `ArrowRight` | Rotate clockwise |
| `Enter` (tap)  | Click |
| `Enter` (hold ≥500ms) | Long-press |

Browser auto-repeat handles "keep rotating while held" for free — each repeated keydown fires another rotate event.

Long-press detection in JS:

```javascript
let pressTimer = null;
let longPressed = false;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !pressTimer) {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      sendEncoderEvent('long_press');
    }, 500);
  }
  if (e.key === 'ArrowLeft')  sendEncoderEvent('rotate', { direction: 'ccw', velocity: 1 });
  if (e.key === 'ArrowRight') sendEncoderEvent('rotate', { direction: 'cw',  velocity: 1 });
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(pressTimer);
    pressTimer = null;
    if (!longPressed) sendEncoderEvent('click');
  }
});
```

Velocity acceleration (spec 7.2) is hard to test meaningfully with keyboard auto-repeat. Send `velocity: 1` from the keyboard stub and defer acceleration tuning until the Pi has real hardware.

### A.4 Differences between Mac and Pi

| Concern | Mac dev | Pi production |
|---|---|---|
| Encoder source | `WebSocketEncoder` + keyboard | `GPIOEncoder` + real rotary encoder |
| Browser | Any tab on `localhost:8000` | Chromium in `--kiosk` mode |
| Audio out | Mac audio device | Pi 3.5mm or HDMI |
| Autostart | Manual `uvicorn` command | systemd unit |
| Display | Whatever monitor | 1024×600 7" panel |

Nothing else differs. Application code is identical.

### A.5 Keep the keyboard stub permanently

Once the Pi has the real encoder wired up, do **not** delete `WebSocketEncoder` or the keyboard listener. Keep both selectable so you can develop against the running app from a browser tab on your laptop pointed at the Pi's IP. Iteration speed in a regular browser dwarfs reaching across to twist a physical knob.

### A.6 Suggested build order on Mac

Slices 1, 3, 4, 5, 6 from section 11 — in that order. Skip slice 2 (real encoder) until the hardware arrives; replace it with the keyboard stub. By the time the Pi shows up, you have a complete working app, and porting it consists of:

1. Copy code to the Pi.
2. Install `mpv`, `yt-dlp`, `chromium-browser` via apt.
3. Implement `GPIOEncoder` (~30 lines wrapping `gpiozero.RotaryEncoder` + `gpiozero.Button`).
4. Slices 7 and 8 (velocity acceleration tuning, kiosk + systemd boot integration).
