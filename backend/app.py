import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend import nts
from backend.encoder import EncoderEvent, WebSocketEncoder, make_encoder
from backend.player import Player

LIVE_STREAMS = {
    "channel-1": "https://stream-relay-geo.ntslive.net/stream",
    "channel-2": "https://stream-relay-geo.ntslive.net/stream2",
}

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

connections: set[WebSocket] = set()
player = Player()
encoder = make_encoder()


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
        deck = await asyncio.to_thread(build_deck, deck_id)
        await ws.send_text(json.dumps({"type": "deck_data", **deck}))
        return
    if msg_type == "play":
        card_id = msg.get("card_id")
        url = await asyncio.to_thread(resolve_play_url, card_id)
        if url:
            await asyncio.to_thread(player.play, url)
        return
    if msg_type == "stop":
        await asyncio.to_thread(player.stop)
        return


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


def build_deck(deck_id: Optional[str]) -> dict:
    if deck_id == "root":
        return {
            "deck_id": "root",
            "cards": [
                {"id": "now-playing", "label": "Now Playing", "kind": "now-playing"},
                {"id": "enter:live", "label": "Live", "kind": "enter-deck", "deck": "live"},
                {"id": "enter:mixtapes", "label": "Mixtapes", "kind": "enter-deck", "deck": "mixtapes"},
                {"id": "back-to-top", "label": "Back to Top", "kind": "back-to-top"},
            ],
        }
    if deck_id == "live":
        return {"deck_id": "live", "cards": _build_live_cards()}
    if deck_id == "mixtapes":
        return {"deck_id": "mixtapes", "cards": _build_mixtape_cards()}
    return {"deck_id": deck_id, "cards": [], "error": "unknown deck"}


def _artwork(media: dict) -> Optional[str]:
    return media.get("picture_medium_large") or media.get("picture_large")


def _build_live_cards() -> list[dict]:
    cards: list[dict] = [{"id": "back", "label": "Back", "kind": "back"}]
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
    cards.append({"id": "back-to-top", "label": "Back to Top", "kind": "back-to-top"})
    return cards


def _build_mixtape_cards() -> list[dict]:
    cards: list[dict] = [{"id": "back", "label": "Back", "kind": "back"}]
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
    cards.append({"id": "back-to-top", "label": "Back to Top", "kind": "back-to-top"})
    return cards
