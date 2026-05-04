import json
import time
from pathlib import Path
from typing import Optional

STATE_DIR = Path.home() / ".nts-pi-player"
GENRES_PATH = STATE_DIR / "genres.json"
MOODS_PATH = STATE_DIR / "moods.json"

TAXONOMY_TTL = 7 * 24 * 3600  # 1 week


def _load_fresh(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    age = time.time() - path.stat().st_mtime
    if age >= TAXONOMY_TTL:
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _save(path: Path, data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def load_genres() -> Optional[dict]:
    return _load_fresh(GENRES_PATH)


def save_genres(data: dict) -> None:
    _save(GENRES_PATH, data)


def load_moods() -> Optional[dict]:
    return _load_fresh(MOODS_PATH)


def save_moods(data: dict) -> None:
    _save(MOODS_PATH, data)
