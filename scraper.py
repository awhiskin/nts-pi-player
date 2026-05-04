#!/usr/bin/env python3
"""NTS Radio past-episode reconnaissance.

Searches NTS for past episodes matching a query, pulls every SoundCloud /
Mixcloud URL the API exposes, then uses yt-dlp to resolve those into real
playable audio URLs. Also collects the genre/mood taxonomy seen across the
results, picks one show and dumps its full episode history, and probes a
couple of undocumented search filters to see what the API quietly accepts.

Usage:
    python3 nts_recon.py                      # default query: "ambient"
    python3 nts_recon.py "drum and bass"
    python3 nts_recon.py jazz --limit 20 --out my_report.txt

Requires Python 3.8+ and yt-dlp on PATH.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

API = "https://www.nts.live/api/v2"
UA = "nts-recon/0.1 (personal research script)"


# ---------- HTTP helper ----------

def fetch(path: str, **params: Any) -> dict:
    """GET a JSON endpoint. Lists in params become repeated keys (?k=a&k=b)."""
    url = f"{API}/{path.lstrip('/')}"
    if params:
        flat: list[tuple[str, str]] = []
        for k, v in params.items():
            if isinstance(v, (list, tuple)):
                flat.extend((k, str(item)) for item in v)
            else:
                flat.append((k, str(v)))
        url += "?" + urllib.parse.urlencode(flat, safe="[]")
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


# ---------- Output buffer (prints + collects) ----------

class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, msg: str = "") -> None:
        print(msg)
        self.lines.append(msg)

    def section(self, title: str) -> None:
        self("")
        self("=" * 72)
        self(title)
        self("=" * 72)


# ---------- yt-dlp ----------

def yt_dlp_resolve(url: str, timeout: int = 30) -> tuple[bool, list[str]]:
    """Return (success, lines). lines = resolved URLs on success, or error
    output on failure. yt-dlp -g prints one URL per line (audio + video for
    HLS, just audio for SoundCloud progressive)."""
    try:
        result = subprocess.run(
            ["yt-dlp", "-g", "--no-warnings", "--no-playlist", url],
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError:
        return False, ["yt-dlp not found on PATH"]
    except subprocess.TimeoutExpired:
        return False, [f"timed out after {timeout}s"]
    if result.returncode != 0:
        # yt-dlp errors land in stderr, take the last informative line
        err = result.stderr.strip().splitlines() or ["unknown error"]
        return False, [err[-1]]
    return True, [ln for ln in result.stdout.strip().splitlines() if ln]


# ---------- Recon steps ----------

def search_past_episodes(out: Report, query: str, limit: int) -> list[dict]:
    out.section(f"SEARCH — past episodes matching {query!r} (limit {limit})")
    data = fetch(
        "search", q=query, version=2, offset=0, limit=limit,
        **{"types[]": ["episode"]},
    )
    rs = data.get("metadata", {}).get("resultset", {})
    out(f"total matches in NTS archive: {rs.get('count', '?')}")
    out(f"returned: {len(data.get('results', []))}")
    popular = data.get("metadata", {}).get("popular_terms") or []
    if popular:
        out(f"popular_terms (free intel from the API): {', '.join(popular)}")
    return data.get("results", [])


def hydrate_episode(result: dict) -> dict:
    """Search results sometimes have empty audio_sources. Fetch the full
    episode via its article.path to be sure we've got the audio URLs."""
    if result.get("audio_sources"):
        return result
    path = (result.get("article") or {}).get("path", "")
    if not path:
        return result
    try:
        full = fetch(path)
        # Merge: keep search-level fields, overlay full episode payload
        merged = dict(result)
        merged["audio_sources"] = full.get("audio_sources") or []
        merged["mixcloud"] = full.get("mixcloud")
        merged["genres"] = full.get("genres") or result.get("genres") or []
        merged["moods"] = full.get("moods") or []
        merged["broadcast"] = full.get("broadcast")
        merged["show_alias"] = full.get("show_alias")
        merged["episode_alias"] = full.get("episode_alias")
        return merged
    except Exception as e:
        result["_hydrate_error"] = str(e)
        return result


def list_episodes(out: Report, results: list[dict]) -> tuple[
    list[tuple[str, str, str]],   # (episode_title, source, url)
    dict[str, str],               # genre_id -> name
    dict[str, str],               # mood_id -> value
    list[str],                    # unique show_aliases seen
]:
    out.section("EPISODES + AUDIO SOURCES")
    audio_jobs: list[tuple[str, str, str]] = []
    genres: dict[str, str] = {}
    moods: dict[str, str] = {}
    show_aliases: list[str] = []

    for i, r in enumerate(results, 1):
        title = r.get("title") or r.get("name") or "?"
        date = r.get("local_date") or r.get("broadcast") or "?"
        path = (r.get("article") or {}).get("path", "")
        out(f"\n[{i}] {title}")
        out(f"    broadcast: {date}")
        out(f"    api path:  {path}")

        sources = r.get("audio_sources") or []
        mixcloud = r.get("mixcloud")
        if not sources and not mixcloud:
            out("    (no audio_sources in search payload — fetching full episode...)")
            r = hydrate_episode(r)
            sources = r.get("audio_sources") or []
            mixcloud = r.get("mixcloud")

        if not sources and not mixcloud:
            out("    !! no playable audio URL exposed (rights-restricted or unpublished)")
        for s in sources:
            out(f"    [{s.get('source')}] {s.get('url')}")
            audio_jobs.append((title, s.get("source", "?"), s.get("url", "")))
        if mixcloud and not any(j[1] == "mixcloud" for j in audio_jobs if j[0] == title):
            out(f"    [mixcloud-link] {mixcloud}")
            audio_jobs.append((title, "mixcloud", mixcloud))

        for g in r.get("genres") or []:
            gid = g.get("id", "")
            gname = g.get("name") or g.get("value") or ""
            if gid:
                genres[gid] = gname
        for m in r.get("moods") or []:
            mid = m.get("id", "")
            mname = m.get("value") or ""
            if mid:
                moods[mid] = mname

        sa = r.get("show_alias")
        if not sa and path:
            # path looks like "/shows/<show-alias>/episodes/<episode-alias>"
            parts = path.strip("/").split("/")
            if len(parts) >= 2 and parts[0] == "shows":
                sa = parts[1]
        if sa and sa not in show_aliases:
            show_aliases.append(sa)

    return audio_jobs, genres, moods, show_aliases


def show_taxonomy(out: Report, genres: dict[str, str], moods: dict[str, str]) -> None:
    out.section("TAXONOMY harvested from these results")
    out(f"genres ({len(genres)}):")
    for gid, name in sorted(genres.items()):
        out(f"  {gid:50s} {name}")
    out(f"\nmoods ({len(moods)}):")
    for mid, name in sorted(moods.items()):
        out(f"  {mid:50s} {name}")


def fetch_genres(out: Report, save_path: Path) -> dict:
    """Fetch the canonical genre taxonomy and save it to disk for later use."""
    out.section("GENRE TAXONOMY  (GET /api/v2/genres)")
    data = fetch("genres")
    results = data.get("results", [])
    total_subs = sum(len(g.get("subgenres", [])) for g in results)
    out(f"top-level genres: {len(results)}    total subgenres: {total_subs}")
    out("")
    for g in results:
        subs = g.get("subgenres", [])
        out(f"  {g['id']:25s}  {g['name']:30s}  ({len(subs)} subgenres)")
    save_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    out(f"\nfull taxonomy saved -> {save_path.name}")
    return data


def _episode_brief(out: Report, response: dict, max_shown: int = 5) -> None:
    """Print a 1-line brief of each episode in a search/episodes response."""
    rs = (response.get("metadata") or {}).get("resultset", {})
    out(f"  count={rs.get('count')}    returned={len(response.get('results', []))}")
    for r in (response.get("results") or [])[:max_shown]:
        title = r.get("title") or r.get("name") or "?"
        date = r.get("local_date") or r.get("broadcast", "?")
        out(f"    - {title}  ({date})")


def browse_by_genre(out: Report, taxonomy: dict, limit: int = 5) -> None:
    """Demonstrate the actual working genre-browse endpoint with a few patterns."""
    out.section("GENRE BROWSE  (GET /api/v2/search/episodes?genres[]=...)")
    results = taxonomy.get("results") or []
    if not results:
        out("  (no taxonomy; skipping)")
        return

    # Pick a top-level genre and one of its subgenres for the demo.
    top = results[0]
    top_id = top["id"]
    sub_id = (top.get("subgenres") or [{}])[0].get("id")

    out(f"\n[A] single top-level genre: {top_id!r} ({top['name']})")
    r = fetch("search/episodes", offset=0, limit=limit, **{"genres[]": [top_id]})
    _episode_brief(out, r)

    if sub_id:
        out(f"\n[B] subgenre: {sub_id!r}")
        r = fetch("search/episodes", offset=0, limit=limit, **{"genres[]": [sub_id]})
        _episode_brief(out, r)

    if len(results) >= 2:
        second_id = results[1]["id"]
        out(f"\n[C] multiple genres (likely OR): {[top_id, second_id]!r}")
        r = fetch("search/episodes", offset=0, limit=limit,
                  **{"genres[]": [top_id, second_id]})
        _episode_brief(out, r)

    out(f"\n[D] genre + free-text query: q='live' + genres[]={top_id!r}")
    r = fetch("search/episodes", q="live", offset=0, limit=limit,
              **{"genres[]": [top_id]})
    _episode_brief(out, r)


def probe_other_filters(out: Report, taxonomy: dict) -> None:
    """Now that we know /search/episodes accepts genres[], probe for other
    plausible filter dimensions and sibling endpoints. Compare against an
    unfiltered baseline — if a param narrows the count, it's being honoured."""
    out.section("FILTER & ENDPOINT PROBE  (on /search/episodes and friends)")

    # Baseline: how many episodes are there in total according to the API?
    base = fetch("search/episodes", limit=1)
    base_count = (base.get("metadata") or {}).get("resultset", {}).get("count")
    out(f"baseline:  /search/episodes  ->  total count={base_count}")

    # Pick something we know works as a positive control.
    known_genre = (taxonomy.get("results") or [{}])[0].get("id", "jazz")

    out("")
    trials = [
        (f"genres[]={known_genre} (control)", {"genres[]": [known_genre]}),
        ("moods[]=moods-the-healing-place", {"moods[]": ["moods-the-healing-place"]}),
        ("locations[]=LDN",                 {"locations[]": ["LDN"]}),
        ("location=London",                 {"location": "London"}),
        ("from/to date range",              {"from": "2024-01-01", "to": "2024-06-30"}),
        ("year=2024",                       {"year": "2024"}),
        ("artists[]=four-tet",              {"artists[]": ["four-tet"]}),
        ("q=ambient + genres[]=jazz",       {"q": "ambient", "genres[]": ["jazz"]}),
    ]
    for label, params in trials:
        try:
            r = fetch("search/episodes", limit=1, **params)
            count = (r.get("metadata") or {}).get("resultset", {}).get("count")
            if count is None:
                verdict = "no metadata returned"
            elif count == base_count:
                verdict = "unchanged (param ignored)"
            else:
                verdict = f"NARROWED from {base_count} -> filter honoured!"
            out(f"  {label:38s}  count={count}  [{verdict}]")
        except Exception as e:
            out(f"  {label:38s}  ERROR {e}")

    # Sibling endpoints — does /search/shows or /api/v2/moods exist?
    out("")
    out("sibling endpoint probe:")
    for path in ["search/shows", "search/collections", "search/artists",
                 "moods", "locations", "artists"]:
        try:
            r = fetch(path, limit=1)
            keys = sorted(r.keys())
            count = (r.get("metadata") or {}).get("resultset", {}).get("count", "?")
            out(f"  GET /{path:22s}  HTTP 200   keys={keys}  count={count}")
        except urllib.error.HTTPError as e:
            out(f"  GET /{path:22s}  HTTP {e.code}")
        except Exception as e:
            out(f"  GET /{path:22s}  ERROR {str(e)[:60]}")


def show_history(out: Report, show_aliases: list[str]) -> None:
    """Demonstrate fetching the full episode list for one of the shows
    we found — this is how you'd 'browse a show' in your Pi app."""
    out.section("SHOW HISTORY — full episode list for one show")
    if not show_aliases:
        out("  (no show aliases collected; skipping)")
        return
    alias = show_aliases[0]
    out(f"GET /shows/{alias}")
    try:
        data = fetch(f"shows/{alias}")
    except Exception as e:
        out(f"  ERROR: {e}")
        return
    out(f"  name: {data.get('name')}")
    out(f"  description: {(data.get('description') or '')[:120]}...")
    out(f"  timeslot: {data.get('timeslot')}  frequency: {data.get('frequency')}")
    eps = ((data.get("embeds") or {}).get("episodes") or {}).get("results") or []
    out(f"  episodes returned: {len(eps)}")
    for ep in eps[:10]:
        has_audio = "audio" if ep.get("audio_sources") else "no-audio"
        out(f"    {ep.get('broadcast', '?')[:10]}  {ep.get('name', '?')}  [{has_audio}]")
    if len(eps) > 10:
        out(f"    ...and {len(eps) - 10} more")


def resolve_audio(out: Report, jobs: list[tuple[str, str, str]], max_resolve: int) -> None:
    out.section(f"YT-DLP RESOLUTION — first {max_resolve} of {len(jobs)} URLs")
    out("(these resolved URLs are time-limited; they're what you'd hand to ffmpeg/mpv)")
    for title, source, url in jobs[:max_resolve]:
        out(f"\n  {title}  [{source}]")
        out(f"  src: {url}")
        ok, lines = yt_dlp_resolve(url)
        if ok:
            for ln in lines:
                out(f"  ->  {ln}")
            # Hint for next-step download with ffmpeg
            out(f"  ffmpeg test: ffmpeg -i \"{lines[0]}\" -t 10 -c copy /tmp/nts_test.m4a")
        else:
            for ln in lines:
                out(f"  !!  {ln}")


# ---------- main ----------

def main() -> int:
    ap = argparse.ArgumentParser(description="NTS past-episode reconnaissance")
    ap.add_argument("query", nargs="?", default="ambient",
                    help="search term (default: ambient)")
    ap.add_argument("--limit", type=int, default=10,
                    help="max search results to inspect (default: 10)")
    ap.add_argument("--resolve", type=int, default=3,
                    help="how many audio URLs to resolve via yt-dlp (default: 3)")
    ap.add_argument("--out", type=Path, default=None,
                    help="path to TXT report (default: nts_recon_<query>_<ts>.txt)")
    args = ap.parse_args()

    out = Report()
    out(f"NTS recon  |  query={args.query!r}  |  {datetime.now().isoformat(timespec='seconds')}")
    out(f"API base: {API}")

    try:
        results = search_past_episodes(out, args.query, args.limit)
    except Exception as e:
        out(f"FATAL: search failed: {e}")
        return 1

    if not results:
        out("\nNo results. Try a different query.")
        return 0

    jobs, genres, moods, shows = list_episodes(out, results)
    show_taxonomy(out, genres, moods)

    # New: full canonical taxonomy + working genre browse + smarter probe
    if args.out is None:
        slug = "".join(c if c.isalnum() else "_" for c in args.query).strip("_") or "query"
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        args.out = Path(f"nts_recon_{slug}_{ts}.txt")
    genres_path = args.out.with_name("nts_genres.json")

    try:
        taxonomy = fetch_genres(out, genres_path)
    except Exception as e:
        out(f"genres fetch failed: {e}")
        taxonomy = {}

    try:
        browse_by_genre(out, taxonomy)
    except Exception as e:
        out(f"genre browse failed: {e}")

    try:
        probe_other_filters(out, taxonomy)
    except Exception as e:
        out(f"probe failed: {e}")

    show_history(out, shows)
    resolve_audio(out, jobs, args.resolve)

    args.out.write_text("\n".join(out.lines) + "\n", encoding="utf-8")
    print(f"\nReport saved -> {args.out.resolve()}")
    print(f"Genres saved -> {genres_path.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())