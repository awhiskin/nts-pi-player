import asyncio
import json
from contextlib import asynccontextmanager
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

now_playing: dict = {
    "state": "idle",
    "title": "",
    "subtitle": "",
    "artwork": None,
    "elapsed": None,
    "duration": None,
    "paused": False,
    "is_live": False,
    "card_kind": "",
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
            old = now_playing["elapsed"]
            now_playing["elapsed"] = data
            old_int = int(old) if old is not None else None
            new_int = int(data) if data is not None else None
            if new_int != old_int:
                await push_now_playing()
        elif prop == "duration":
            old = now_playing["duration"]
            now_playing["duration"] = data
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
            # Phase D will auto-advance here; for now just go idle.
            _reset_now_playing()
            await push_now_playing()
        # Other reasons (stop, quit, redirect) are silent — they happen on
        # loadfile-replacing-loadfile and shouldn't flap the UI to idle.
        return


def _reset_now_playing() -> None:
    global _current_card_id
    now_playing.update({
        "state": "idle",
        "title": "",
        "subtitle": "",
        "artwork": None,
        "elapsed": None,
        "duration": None,
        "paused": False,
        "is_live": False,
        "card_kind": "",
    })
    now_playing.pop("error_message", None)
    _current_card_id = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    saved = state.load_volume()
    if saved is not None:
        now_playing["volume"] = saved
    await encoder.start(on_encoder_event)
    await player.start(on_mpv_event)
    await player.set_volume(now_playing["volume"])
    yield
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
        asyncio.create_task(_handle_play(card_id))
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
        return
    if msg_type == "resume":
        if _is_live_card(_current_card_id) and now_playing.get("paused"):
            asyncio.create_task(_handle_play(_current_card_id))
        else:
            await player.resume()
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


async def _handle_play(card_id: Optional[str]) -> None:
    global _current_card_id
    _current_card_id = card_id
    meta = _card_meta.get(card_id or "", {})
    now_playing["state"] = "loading"
    now_playing["title"] = meta.get("title") or ""
    now_playing["subtitle"] = meta.get("subtitle") or ""
    now_playing["artwork"] = meta.get("artwork")
    now_playing["elapsed"] = None
    now_playing["duration"] = None
    now_playing["paused"] = False
    now_playing["is_live"] = _is_live_card(card_id)
    now_playing["card_kind"] = _card_kind(card_id)
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
    cards: list[dict] = [_back_card()]
    try:
        data = nts.live()
    except Exception:
        data = {"results": []}
    for r in data.get("results", []):
        chan = r.get("channel_name") or "?"
        now = r.get("now") or {}
        details = (now.get("embeds") or {}).get("details") or {}
        card = {
            "id": f"channel-{chan}",
            "label": f"Channel {chan}",
            "subtitle": now.get("broadcast_title") or details.get("name") or "",
            "artwork": _artwork(details.get("media") or {}),
            "kind": "play",
        }
        _remember_meta(card)
        cards.append(card)
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
