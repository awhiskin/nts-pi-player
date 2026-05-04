import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend import nts, resolver
from backend.encoder import EncoderEvent, WebSocketEncoder, make_encoder
from backend.player import Player

LIVE_STREAMS = {
    "channel-1": "https://stream-relay-geo.ntslive.net/stream",
    "channel-2": "https://stream-relay-geo.ntslive.net/stream2",
}

PAGE_SIZE = 30

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

connections: set[WebSocket] = set()
player = Player()
encoder = make_encoder()

# article path -> soundcloud url, populated as episode decks are built
_episode_audio: dict[str, str] = {}


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


async def on_encoder_event(event: EncoderEvent) -> None:
    await broadcast({"type": "encoder", **event})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await encoder.start(on_encoder_event)
    yield
    player.stop()


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
        await asyncio.to_thread(player.stop)
        return


async def _handle_play(card_id: Optional[str]) -> None:
    url = await asyncio.to_thread(resolve_play_url, card_id)
    if url:
        await asyncio.to_thread(player.play, url)


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
        cards.append({
            "id": f"channel-{chan}",
            "label": f"Channel {chan}",
            "subtitle": now.get("broadcast_title") or details.get("name") or "",
            "artwork": _artwork(details.get("media") or {}),
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
        cards.append({
            "id": f"mixtape:{alias}",
            "label": m.get("title") or alias,
            "subtitle": m.get("subtitle") or "",
            "artwork": _artwork(m.get("media") or {}),
            "kind": "play",
        })
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
        return {
            "id": f"episode:{path}",
            "label": title,
            "subtitle": subtitle,
            "artwork": artwork,
            "kind": "play",
        }
    return {
        "id": f"episode:{path}",
        "label": title,
        "subtitle": (subtitle + " · Not available").strip(" ·"),
        "artwork": artwork,
        "kind": "unplayable",
    }
