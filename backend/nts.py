import json
import time
import urllib.parse
import urllib.request
from typing import Any, Callable

from backend import state

API_BASE = "https://www.nts.live/api/v2"
USER_AGENT = "nts-pi-player/0.1"

LIVE_TTL = 30.0
MIXTAPES_TTL = 3600.0
SEARCH_TTL = 600.0  # 10 minutes — episode lists drift slowly
COLLECTION_TTL = 600.0  # collections (picks, recently-added) — same cadence

_cache: dict[str, tuple[float, Any]] = {}


def _fetch(path: str, **params: Any) -> dict:
    url = f"{API_BASE}/{path.lstrip('/')}"
    if params:
        flat: list[tuple[str, str]] = []
        for k, v in params.items():
            if isinstance(v, (list, tuple)):
                flat.extend((k, str(x)) for x in v)
            else:
                flat.append((k, str(v)))
        url += "?" + urllib.parse.urlencode(flat, safe="[]")
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _cached(key: str, ttl: float, fetcher: Callable[[], Any]) -> Any:
    now = time.monotonic()
    entry = _cache.get(key)
    if entry is not None and entry[0] > now:
        return entry[1]
    value = fetcher()
    _cache[key] = (now + ttl, value)
    return value


def live() -> dict:
    return _cached("live", LIVE_TTL, lambda: _fetch("live"))


def mixtapes() -> dict:
    return _cached("mixtapes", MIXTAPES_TTL, lambda: _fetch("mixtapes"))


def genres() -> dict:
    cached = state.load_genres()
    if cached is not None:
        return cached
    data = _fetch("genres")
    state.save_genres(data)
    return data


def moods() -> dict:
    cached = state.load_moods()
    if cached is not None:
        return cached
    data = _fetch("moods")
    state.save_moods(data)
    return data


def search_episodes(filter_key: str, filter_value: str, offset: int, limit: int) -> dict:
    """filter_key is 'genres[]' or 'moods[]'. Cached short-term per (key,value,offset,limit)."""
    cache_key = f"search:{filter_key}={filter_value}:{offset}:{limit}"
    return _cached(
        cache_key,
        SEARCH_TTL,
        lambda: _fetch("search/episodes", offset=offset, limit=limit, **{filter_key: [filter_value]}),
    )


def episode(path: str) -> dict:
    """Fetch a single episode by article path like 'shows/<alias>/episodes/<alias>'."""
    return _fetch(path.lstrip("/"))


def collection(slug: str, offset: int = 0) -> dict:
    """Fetch a curated collection (e.g. 'nts-picks', 'recently-added').
    Server-side page size is fixed at 12, so we don't pass limit."""
    cache_key = f"collection:{slug}:{offset}"
    return _cached(
        cache_key,
        COLLECTION_TTL,
        lambda: _fetch(f"collections/{slug}", offset=offset),
    )
