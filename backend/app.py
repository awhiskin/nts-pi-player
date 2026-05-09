import asyncio
import json
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend import nts, resolver, state
from backend.encoder import EncoderEvent, WebSocketEncoder, make_encoder
from backend.player import Player

LIVE_STREAMS = {
    "channel-1": "https://stream-relay-geo.ntslive.net/stream",
    "channel-2": "https://stream-relay-geo.ntslive.net/stream2",
}

PAGE_SIZE = 30
DEFAULT_VOLUME = 60
SCHEDULE_REFRESH_INTERVAL = 15 * 60.0  # idle re-fetch cadence (s)
SCHEDULE_RETRY_INTERVAL = 60.0          # re-fetch sooner after a failure
EPISODE_BOUNDARY_SLACK = 0.5            # wake just past start_timestamp so the new ep is current

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

connections: set[WebSocket] = set()
player = Player()
encoder = make_encoder()

# article path -> soundcloud url, populated as episode decks are built
_episode_audio: dict[str, str] = {}

# card_id -> {"title", "subtitle", "artwork"} for now_playing display.
_card_meta: dict[str, dict] = {}

# What's currently loaded in the player (drives live-aware pause/resume).
_current_card_id: Optional[str] = None

# Auto-advance queue: ordered list of playable card_ids in the deck the user
# initiated playback from, plus the index of the currently-playing item.
# The frontend supplies the list on each user-initiated play; the backend
# walks forward through it on each `end-file` (eof) event.
_queue: list[str] = []
_queue_index: int = -1

# In-memory live-channel schedule, derived from the NTS live API's now/next*
# blocks. Keys are card ids ("channel-1", "channel-2"); values are episodes
# sorted by start time. The schedule loop walks this against the server clock
# to flip episodes precisely at start_timestamp, independent of how quickly
# NTS updates their `now` field upstream.
_schedule: dict[str, list[dict]] = {}
_schedule_attempted_at: float = 0.0  # monotonic ts of last refresh attempt
_schedule_succeeded_at: float = 0.0  # monotonic ts of last successful refresh
_schedule_kick = asyncio.Event()      # set by triggers (play/pause, scroll mode)

now_playing: dict = {
    "state": "idle",
    "title": "",
    "subtitle": "",
    "time_range": "",
    "location": "",
    "artwork": None,
    "elapsed": None,
    "duration": None,
    "paused": False,
    "is_live": False,
    "card_kind": "",
    "card_id": None,
    "volume": DEFAULT_VOLUME,
}


def _is_live_card(card_id: Optional[str]) -> bool:
    """Live channels and Infinite Mixtapes are continuous streams: no
    meaningful duration, and pause/resume should re-join the live edge
    rather than play buffered audio."""
    if not card_id:
        return False
    return card_id in LIVE_STREAMS or card_id.startswith("mixtape:")


def _card_kind(card_id: Optional[str]) -> str:
    """One of "live" / "mixtape" / "episode" / "" — drives UI eyebrow
    styling on the Now Playing card."""
    if not card_id:
        return ""
    if card_id in LIVE_STREAMS:
        return "live"
    if card_id.startswith("mixtape:"):
        return "mixtape"
    if card_id.startswith("episode:"):
        return "episode"
    return ""


async def broadcast(message: dict) -> None:
    payload = json.dumps(message)
    dead: list[WebSocket] = []
    for ws in connections:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        connections.discard(ws)


async def push_now_playing() -> None:
    await broadcast({"type": "now_playing", **now_playing})


async def on_encoder_event(event: EncoderEvent) -> None:
    await broadcast({"type": "encoder", **event})


async def on_mpv_event(event: dict) -> None:
    name = event.get("event")
    if name == "property-change":
        # Property-changes flow only matter while playing. While loading/idle/
        # error, mpv may still emit clears (time-pos→None, etc.) that would
        # spuriously overwrite a meaningful UI state.
        if now_playing["state"] != "playing":
            return
        prop = event.get("name")
        data = event.get("data")
        if prop == "time-pos":
            # Throttle: only push when elapsed second actually advances.
            # Skip the broadcast entirely for live-style streams — they
            # don't render a progress bar so the once-per-second update
            # is pure DOM churn on the client.
            old = now_playing["elapsed"]
            now_playing["elapsed"] = data
            if now_playing.get("is_live"):
                return
            old_int = int(old) if old is not None else None
            new_int = int(data) if data is not None else None
            if new_int != old_int:
                await push_now_playing()
        elif prop == "duration":
            old = now_playing["duration"]
            now_playing["duration"] = data
            if now_playing.get("is_live"):
                return
            old_int = int(old) if old is not None else None
            new_int = int(data) if data is not None else None
            if new_int != old_int:
                await push_now_playing()
        elif prop == "pause":
            new_paused = bool(data)
            if new_paused != now_playing["paused"]:
                now_playing["paused"] = new_paused
                await push_now_playing()
        return
    if name in ("file-loaded", "playback-restart"):
        if now_playing["state"] != "playing":
            now_playing["state"] = "playing"
            now_playing.pop("error_message", None)
            await push_now_playing()
        return
    if name == "end-file":
        reason = event.get("reason")
        if reason == "error":
            now_playing["state"] = "error"
            now_playing["error_message"] = "Stream failed"
            await push_now_playing()
        elif reason == "eof":
            # Auto-advance to the next item in the queue if there is one;
            # otherwise reset to idle.
            if not _advance_queue():
                _reset_now_playing()
                await push_now_playing()
        # Other reasons (stop, quit, redirect) are silent — they happen on
        # loadfile-replacing-loadfile and shouldn't flap the UI to idle.
        return


def _advance_queue() -> bool:
    """Spawn play of the next queued item if one exists. Returns True iff a
    next item was queued (caller should NOT reset now_playing in that case)."""
    if _queue_index < 0 or _queue_index >= len(_queue) - 1:
        return False
    next_id = _queue[_queue_index + 1]
    asyncio.create_task(_handle_play(next_id))
    return True


def _reset_now_playing() -> None:
    global _current_card_id, _queue, _queue_index
    now_playing.update({
        "state": "idle",
        "title": "",
        "subtitle": "",
        "time_range": "",
        "location": "",
        "artwork": None,
        "elapsed": None,
        "duration": None,
        "paused": False,
        "is_live": False,
        "card_kind": "",
        "card_id": None,
    })
    now_playing.pop("error_message", None)
    _current_card_id = None
    _queue = []
    _queue_index = -1


def _parse_episode(entry: dict) -> Optional[dict]:
    """Flatten one of the live API's `now`/`next*` blocks into a single
    record. Returns None if the timestamps are missing/unparseable."""
    if not isinstance(entry, dict):
        return None
    starts = entry.get("start_timestamp") or ""
    ends = entry.get("end_timestamp") or ""
    try:
        start = datetime.fromisoformat(starts.replace("Z", "+00:00"))
        end = datetime.fromisoformat(ends.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    details = (entry.get("embeds") or {}).get("details") or {}
    return {
        "start": start,
        "end": end,
        "title": details.get("name") or entry.get("broadcast_title") or "",
        "artwork": _artwork(details.get("media") or {}),
        "location": _live_location(entry, details),
    }


async def _refresh_schedule() -> bool:
    """Fetch the live API and rebuild _schedule from now+next* per channel.
    Returns True on success."""
    global _schedule_attempted_at, _schedule_succeeded_at
    _schedule_attempted_at = time.monotonic()
    try:
        data = await asyncio.to_thread(nts.live)
    except Exception:
        return False
    new_schedule: dict[str, list[dict]] = {}
    for r in data.get("results", []):
        chan = r.get("channel_name")
        if not chan:
            continue
        episodes: list[dict] = []
        for key, entry in r.items():
            # `now` plus `next`, `next2`, `next3`, …
            if key == "now" or (isinstance(key, str) and key.startswith("next")):
                ep = _parse_episode(entry)
                if ep:
                    episodes.append(ep)
        episodes.sort(key=lambda e: e["start"])
        new_schedule[f"channel-{chan}"] = episodes
    if new_schedule:
        _schedule.clear()
        _schedule.update(new_schedule)
        _schedule_succeeded_at = time.monotonic()
        return True
    return False


def _current_episode(card_id: str, now_utc: datetime) -> Optional[dict]:
    for ep in _schedule.get(card_id, ()):  # already sorted by start
        if ep["start"] <= now_utc < ep["end"]:
            return ep
    return None


def _next_episode_boundary(now_utc: datetime) -> Optional[datetime]:
    """Soonest upcoming episode start across all channels."""
    upcoming = []
    for eps in _schedule.values():
        for ep in eps:
            if ep["start"] > now_utc:
                upcoming.append(ep["start"])
                break
    return min(upcoming) if upcoming else None


def _next_episode_for(card_id: str, now_utc: datetime) -> Optional[dict]:
    """Soonest upcoming episode for a single channel — used to surface the
    next show's artwork URL so the frontend can pre-warm the browser cache
    before the rollover."""
    for ep in _schedule.get(card_id, ()):
        if ep["start"] > now_utc:
            return ep
    return None


def _episode_time_range(ep: dict) -> str:
    return (
        f"{ep['start'].astimezone().strftime('%H:%M')}"
        f" - "
        f"{ep['end'].astimezone().strftime('%H:%M')}"
    )


def _apply_episodes() -> bool:
    """Sync _card_meta for every live channel against the current episode.
    Returns True if any meta or now_playing fields changed."""
    now_utc = datetime.now(timezone.utc)
    deck_changed = False
    for card_id in list(_schedule.keys()):
        ep = _current_episode(card_id, now_utc)
        if ep is None:
            continue
        chan_num = card_id.split("-", 1)[1] if "-" in card_id else ""
        new_title = ep["title"] or f"Channel {chan_num}"
        new_time_range = _episode_time_range(ep)
        new_location = ep["location"] or ""
        new_artwork = ep["artwork"]
        meta = _card_meta.setdefault(card_id, {})
        if (
            meta.get("title") != new_title
            or meta.get("time_range") != new_time_range
            or meta.get("location") != new_location
            or (new_artwork and meta.get("artwork") != new_artwork)
        ):
            meta["title"] = new_title
            meta["time_range"] = new_time_range
            meta["location"] = new_location
            if new_artwork:
                meta["artwork"] = new_artwork
            deck_changed = True
    return deck_changed


async def _sync_now_playing_from_meta() -> None:
    """If a live channel is the current playback, mirror its updated meta
    into now_playing so the Now Playing screen flips at the boundary."""
    cur_id = now_playing.get("card_id")
    if now_playing.get("card_kind") != "live" or not cur_id:
        return
    meta = _card_meta.get(cur_id) or {}
    changed = False
    for key in ("title", "time_range", "location"):
        val = meta.get(key, "")
        if val != now_playing.get(key):
            now_playing[key] = val
            changed = True
    art = meta.get("artwork")
    if art and art != now_playing.get("artwork"):
        now_playing["artwork"] = art
        changed = True
    if changed:
        await push_now_playing()


async def _refresh_and_apply() -> None:
    """Idempotent: refresh schedule (if missing or stale enough), reapply
    current-episode state, broadcast the live deck on change."""
    if not _schedule:
        await _refresh_schedule()
    if _apply_episodes():
        await broadcast_live_deck()
        await _sync_now_playing_from_meta()


async def broadcast_live_deck() -> None:
    cards = await asyncio.to_thread(_build_live_cards)
    await broadcast({
        "type": "deck_data",
        "deck_id": "live",
        "offset": 0,
        "cards": cards,
    })


def kick_schedule_refresh() -> None:
    """Wake the schedule loop now (e.g. after pause/resume or on scroll-mode
    entry). Safe to call from sync contexts."""
    _schedule_kick.set()


async def _live_schedule_loop() -> None:
    """Drive live-channel updates from the server clock, against an
    in-memory schedule periodically refreshed from the NTS API. Episodes
    flip exactly at start_timestamp — independent of NTS's own update
    lag."""
    while True:
        try:
            now_mono = time.monotonic()
            stale = (now_mono - _schedule_succeeded_at) > SCHEDULE_REFRESH_INTERVAL
            retry_due = (now_mono - _schedule_attempted_at) > SCHEDULE_RETRY_INTERVAL
            if stale and (_schedule_succeeded_at == 0 or retry_due):
                await _refresh_schedule()

            if _apply_episodes():
                await broadcast_live_deck()
                await _sync_now_playing_from_meta()

            # Sleep until the next event: episode boundary OR refresh
            # deadline OR an explicit kick.
            now_utc = datetime.now(timezone.utc)
            wait_secs = SCHEDULE_REFRESH_INTERVAL  # upper bound
            nb = _next_episode_boundary(now_utc)
            if nb is not None:
                wait_secs = min(
                    wait_secs,
                    (nb - now_utc).total_seconds() + EPISODE_BOUNDARY_SLACK,
                )
            if _schedule_succeeded_at:
                next_refresh_in = SCHEDULE_REFRESH_INTERVAL - (
                    time.monotonic() - _schedule_succeeded_at
                )
                wait_secs = min(wait_secs, next_refresh_in)
            wait_secs = max(1.0, wait_secs)

            try:
                await asyncio.wait_for(_schedule_kick.wait(), timeout=wait_secs)
                # Triggered: refresh forcefully on next iteration.
                _schedule_kick.clear()
                if await _refresh_schedule():
                    if _apply_episodes():
                        await broadcast_live_deck()
                        await _sync_now_playing_from_meta()
            except asyncio.TimeoutError:
                # Normal wakeup — boundary or refresh deadline.
                pass
        except asyncio.CancelledError:
            raise
        except Exception:
            await asyncio.sleep(SCHEDULE_RETRY_INTERVAL)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    saved = state.load_volume()
    if saved is not None:
        now_playing["volume"] = saved
    await encoder.start(on_encoder_event)
    await player.start(on_mpv_event)
    await player.set_volume(now_playing["volume"])
    # Populate the schedule before any websocket can connect, so the first
    # `request_deck` for `live` returns real data rather than an empty list.
    await _refresh_schedule()
    _apply_episodes()
    schedule_task = asyncio.create_task(_live_schedule_loop())
    try:
        yield
    finally:
        schedule_task.cancel()
        try:
            await schedule_task
        except asyncio.CancelledError:
            pass
        await player.shutdown()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    connections.add(ws)
    try:
        # Sync newly-connected clients to current state.
        await ws.send_text(json.dumps({"type": "now_playing", **now_playing}))
        if _schedule:
            await ws.send_text(json.dumps({
                "type": "deck_data",
                "deck_id": "live",
                "offset": 0,
                "cards": _build_live_cards(),
            }))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await handle_message(ws, msg)
    except WebSocketDisconnect:
        pass
    finally:
        connections.discard(ws)


async def handle_message(ws: WebSocket, msg: dict) -> None:
    msg_type = msg.get("type")
    if msg_type == "encoder":
        if isinstance(encoder, WebSocketEncoder):
            event = {k: v for k, v in msg.items() if k != "type"}
            await encoder.feed(event)
        return
    if msg_type == "request_deck":
        deck_id = msg.get("deck_id")
        offset = int(msg.get("offset") or 0)
        deck = await asyncio.to_thread(build_deck, deck_id, offset)
        await ws.send_text(json.dumps({"type": "deck_data", **deck}))
        return
    if msg_type == "play":
        # Fire-and-forget: yt-dlp resolution can take seconds; don't block the
        # message loop or encoder events would queue up behind it.
        card_id = msg.get("card_id")
        queue = msg.get("queue") if isinstance(msg.get("queue"), list) else None
        asyncio.create_task(_handle_play(card_id, queue))
        kick_schedule_refresh()
        return
    if msg_type == "stop":
        await player.stop()
        _reset_now_playing()
        await push_now_playing()
        return
    if msg_type == "pause":
        # Live-style streams (channels + mixtapes) can't be meaningfully
        # paused — buffered audio diverges from the live edge. Stop the
        # stream instead and surface as paused; resume re-issues play.
        if _is_live_card(_current_card_id):
            await player.stop()
            now_playing["paused"] = True
            await push_now_playing()
        else:
            await player.pause()
        kick_schedule_refresh()
        return
    if msg_type == "resume":
        if _is_live_card(_current_card_id) and now_playing.get("paused"):
            asyncio.create_task(_handle_play(_current_card_id))
        else:
            await player.resume()
        kick_schedule_refresh()
        return
    if msg_type == "refresh_live":
        # Frontend-side trigger (scroll-mode entry, etc.). The schedule
        # loop will re-fetch and broadcast on its next iteration.
        kick_schedule_refresh()
        return
    if msg_type == "set_volume":
        try:
            value = int(msg.get("value"))
        except (TypeError, ValueError):
            return
        value = max(0, min(100, value))
        now_playing["volume"] = value
        await player.set_volume(value)
        await asyncio.to_thread(state.save_volume, value)
        await push_now_playing()
        return


async def _handle_play(card_id: Optional[str], queue: Optional[list[str]] = None) -> None:
    global _current_card_id, _queue, _queue_index
    _current_card_id = card_id
    if queue is not None:
        # User-initiated play: queue context refreshed.
        _queue = list(queue)
    if card_id and card_id in _queue:
        _queue_index = _queue.index(card_id)
    else:
        _queue_index = -1
    meta = _card_meta.get(card_id or "", {})
    now_playing["state"] = "loading"
    now_playing["title"] = meta.get("title") or ""
    now_playing["subtitle"] = meta.get("subtitle") or ""
    now_playing["time_range"] = meta.get("time_range") or ""
    now_playing["location"] = meta.get("location") or ""
    now_playing["artwork"] = meta.get("artwork")
    now_playing["elapsed"] = None
    now_playing["duration"] = None
    now_playing["paused"] = False
    now_playing["is_live"] = _is_live_card(card_id)
    now_playing["card_kind"] = _card_kind(card_id)
    now_playing["card_id"] = card_id
    now_playing.pop("error_message", None)
    await push_now_playing()

    url = await asyncio.to_thread(resolve_play_url, card_id)
    if url is None:
        now_playing["state"] = "error"
        now_playing["error_message"] = "Not available"
        await push_now_playing()
        return
    try:
        await player.play(url)
    except Exception as exc:
        now_playing["state"] = "error"
        now_playing["error_message"] = f"Playback error: {exc}"
        await push_now_playing()


def resolve_play_url(card_id: Optional[str]) -> Optional[str]:
    if not card_id:
        return None
    if card_id in LIVE_STREAMS:
        return LIVE_STREAMS[card_id]
    if card_id.startswith("mixtape:"):
        alias = card_id.split(":", 1)[1]
        for m in nts.mixtapes().get("results", []):
            if m.get("mixtape_alias") == alias:
                return m.get("audio_stream_endpoint")
        return None
    if card_id.startswith("episode:"):
        path = card_id[len("episode:"):]
        soundcloud_url = _episode_audio.get(path)
        if soundcloud_url is None:
            try:
                data = nts.episode(path)
            except Exception:
                return None
            sources = data.get("audio_sources") or []
            if sources:
                soundcloud_url = sources[0].get("url")
                if soundcloud_url:
                    _episode_audio[path] = soundcloud_url
        if soundcloud_url:
            return resolver.resolve(soundcloud_url)
    return None


def build_deck(deck_id: Optional[str], offset: int = 0) -> dict:
    if deck_id == "root":
        return _build_root_deck()
    if deck_id == "live":
        return {"deck_id": "live", "cards": _build_live_cards()}
    if deck_id == "mixtapes":
        return {"deck_id": "mixtapes", "cards": _build_mixtape_cards()}
    if deck_id == "genres":
        return _build_genres_deck()
    if deck_id and deck_id.startswith("genre:"):
        return _build_genre_detail_deck(deck_id[len("genre:"):])
    if deck_id == "moods":
        return _build_moods_deck()
    if deck_id and (deck_id.startswith("episodes:genre:") or deck_id.startswith("episodes:mood:")):
        return _build_episodes_deck(deck_id, offset)
    return {"deck_id": deck_id, "cards": [], "error": "unknown deck"}


def _back_card() -> dict:
    return {"id": "back", "label": "Back", "kind": "back"}


def _back_to_top_card() -> dict:
    return {"id": "back-to-top", "label": "Back to Top", "kind": "back-to-top"}


def _artwork(media: dict) -> Optional[str]:
    return media.get("picture_medium_large") or media.get("picture_large")


def _episode_artwork(image: dict) -> Optional[str]:
    return image.get("medium_large") or image.get("large")


def _remember_meta(card: dict) -> None:
    _card_meta[card["id"]] = {
        "title": card.get("label") or "",
        "subtitle": card.get("subtitle") or "",
        "artwork": card.get("artwork"),
    }


def _format_time_range(starts: str, ends: str) -> str:
    """Convert NTS' ISO timestamps into a local 'HH:MM–HH:MM' string,
    or empty if either side is missing / unparseable."""
    try:
        s = datetime.fromisoformat(starts.replace("Z", "+00:00")) if starts else None
        e = datetime.fromisoformat(ends.replace("Z", "+00:00")) if ends else None
    except ValueError:
        return ""
    if not s or not e:
        return ""
    s_local = s.astimezone()
    e_local = e.astimezone()
    return f"{s_local.strftime('%H:%M')} - {e_local.strftime('%H:%M')}"


def _live_location(now: dict, details: dict) -> str:
    """Pull the location for a live broadcast, falling back through the
    plausible fields. NTS isn't fully consistent — short form is preferred."""
    return (
        details.get("location_long")
        or now.get("location_long")
        or details.get("location_short")
        or now.get("location_short")
        or ""
    )


def _build_root_deck() -> dict:
    return {
        "deck_id": "root",
        "cards": [
            {"id": "now-playing", "label": "Now Playing", "kind": "now-playing"},
            {"id": "enter:live", "label": "Live", "kind": "enter-deck", "deck": "live"},
            {"id": "enter:mixtapes", "label": "Mixtapes", "kind": "enter-deck", "deck": "mixtapes"},
            {"id": "enter:moods", "label": "Moods", "kind": "enter-deck", "deck": "moods"},
            {"id": "enter:genres", "label": "Genres", "kind": "enter-deck", "deck": "genres"},
            _back_to_top_card(),
        ],
    }


def _build_live_cards() -> list[dict]:
    """Render the Live deck from the in-memory schedule. The schedule loop
    owns refreshing _schedule; this is a pure read."""
    cards: list[dict] = [_back_card()]
    now_utc = datetime.now(timezone.utc)
    for card_id in sorted(_schedule.keys()):
        chan = card_id.split("-", 1)[1] if "-" in card_id else "?"
        ep = _current_episode(card_id, now_utc)
        nxt = _next_episode_for(card_id, now_utc)
        title = (ep["title"] if ep else "") or f"Channel {chan}"
        time_range = _episode_time_range(ep) if ep else ""
        location = (ep["location"] if ep else "") or ""
        artwork = ep["artwork"] if ep else None
        next_artwork = nxt["artwork"] if nxt else None
        cards.append({
            "id": card_id,
            "label": f"Channel {chan}",
            "subtitle": title if ep else "",
            "time_range": time_range,
            "location": location,
            "artwork": artwork,
            # Pre-warm hint: the artwork URL of the soonest upcoming
            # episode. Frontend Image()-preloads it so the bg-image swap
            # at the rollover boundary hits the browser cache.
            "next_artwork": next_artwork,
            "kind": "play",
        })
    cards.append(_back_to_top_card())
    return cards


def _build_mixtape_cards() -> list[dict]:
    cards: list[dict] = [_back_card()]
    try:
        data = nts.mixtapes()
    except Exception:
        data = {"results": []}
    for m in data.get("results", []):
        alias = m.get("mixtape_alias") or ""
        card = {
            "id": f"mixtape:{alias}",
            "label": m.get("title") or alias,
            "subtitle": m.get("subtitle") or "",
            "artwork": _artwork(m.get("media") or {}),
            "kind": "play",
        }
        _remember_meta(card)
        cards.append(card)
    cards.append(_back_to_top_card())
    return cards


def _build_genres_deck() -> dict:
    cards: list[dict] = [_back_card()]
    try:
        data = nts.genres()
    except Exception:
        data = {"results": []}
    for g in data.get("results", []):
        gid = g.get("id") or ""
        cards.append({
            "id": f"enter:genre:{gid}",
            "label": g.get("name") or gid,
            "kind": "enter-deck",
            "deck": f"genre:{gid}",
        })
    cards.append(_back_to_top_card())
    return {"deck_id": "genres", "cards": cards}


def _build_genre_detail_deck(genre_id: str) -> dict:
    cards: list[dict] = [_back_card()]
    try:
        data = nts.genres()
    except Exception:
        data = {"results": []}
    genre = next((g for g in data.get("results", []) if g.get("id") == genre_id), None)
    if genre is not None:
        cards.append({
            "id": f"enter:episodes:genre:{genre_id}",
            "label": f"All {genre.get('name', genre_id)}",
            "kind": "enter-deck",
            "deck": f"episodes:genre:{genre_id}",
        })
        for sub in genre.get("subgenres") or []:
            sub_id = sub.get("id") or ""
            cards.append({
                "id": f"enter:episodes:genre:{sub_id}",
                "label": sub.get("name") or sub_id,
                "kind": "enter-deck",
                "deck": f"episodes:genre:{sub_id}",
            })
    cards.append(_back_to_top_card())
    return {"deck_id": f"genre:{genre_id}", "cards": cards}


def _build_moods_deck() -> dict:
    cards: list[dict] = [_back_card()]
    try:
        data = nts.moods()
    except Exception:
        data = {"results": []}
    for m in data.get("results", []):
        mid = m.get("id") or ""
        image = m.get("image") or {}
        cards.append({
            "id": f"enter:episodes:mood:{mid}",
            "label": m.get("name") or mid,
            "subtitle": m.get("description") or "",
            "artwork": image.get("medium_large") or image.get("large"),
            "kind": "enter-deck",
            "deck": f"episodes:mood:{mid}",
        })
    cards.append(_back_to_top_card())
    return {"deck_id": "moods", "cards": cards}


def _build_episodes_deck(deck_id: str, offset: int) -> dict:
    if deck_id.startswith("episodes:genre:"):
        filter_key = "genres[]"
        filter_value = deck_id[len("episodes:genre:"):]
    elif deck_id.startswith("episodes:mood:"):
        filter_key = "moods[]"
        filter_value = deck_id[len("episodes:mood:"):]
    else:
        return {"deck_id": deck_id, "cards": [], "error": "bad filter"}

    try:
        data = nts.search_episodes(filter_key, filter_value, offset, PAGE_SIZE)
    except Exception:
        data = {"results": [], "metadata": {"resultset": {"count": 0}}}

    rs = (data.get("metadata") or {}).get("resultset") or {}
    total = int(rs.get("count") or 0)
    has_more = (offset + PAGE_SIZE) < total

    content_cards = [_episode_card(r) for r in data.get("results", [])]

    if offset == 0:
        cards = [_back_card(), *content_cards, _back_to_top_card()]
    else:
        cards = content_cards

    return {
        "deck_id": deck_id,
        "offset": offset,
        "has_more": has_more,
        "cards": cards,
    }


def _episode_card(r: dict) -> dict:
    path = (r.get("article") or {}).get("path", "").lstrip("/")
    title = r.get("title") or "Episode"
    parts = [p for p in (r.get("local_date") or "", r.get("location") or "") if p]
    subtitle = " · ".join(parts)
    artwork = _episode_artwork(r.get("image") or {})
    sources = r.get("audio_sources") or []
    if sources:
        url = sources[0].get("url")
        if path and url:
            _episode_audio[path] = url
        card = {
            "id": f"episode:{path}",
            "label": title,
            "subtitle": subtitle,
            "artwork": artwork,
            "kind": "play",
        }
        _remember_meta(card)
        return card
    return {
        "id": f"episode:{path}",
        "label": title,
        "subtitle": (subtitle + " · Not available").strip(" ·"),
        "artwork": artwork,
        "kind": "unplayable",
    }
