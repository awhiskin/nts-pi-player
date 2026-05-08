const LONG_PRESS_MS = 300;
const PAGE_PREFETCH_THRESHOLD = 5;
const VOLUME_STEP = 5;
const IDLE_RETURN_PLAYING_MS = 20000;
const IDLE_RETURN_OTHERWISE_MS = 60000;
const VOLUME_PEEK_MS = 750;

const TOP_PAGES = [
  { id: "now-playing", kind: "now-playing", label: "NOW PLAYING" },
  { id: "live",        kind: "live",        label: "LIVE",     deck: "live" },
  { id: "mixtapes",    kind: "list",        label: "MIXTAPES", deck: "mixtapes" },
  { id: "moods",       kind: "list",        label: "MOODS",    deck: "moods" },
  { id: "genres",      kind: "list",        label: "GENRES",   deck: "genres" },
];

const DECK_LABELS = {
  live: "LIVE",
  mixtapes: "MIXTAPES",
  moods: "MOODS",
  genres: "GENRES",
};

const stageEl = document.getElementById("stage");
const screenEl = document.getElementById("screen");
const chromeLabelEl = document.getElementById("chrome-label");
const chromeTimeEl = document.getElementById("chrome-time");
const sideDotsEl = document.getElementById("side-dots");
const volumePeekEl = document.getElementById("volume-peek");
const volumePeekFillEl = volumePeekEl?.querySelector(".volume-peek-fill");
const volumePeekLabelEl = volumePeekEl?.querySelector(".volume-peek-label");

const decks = {};
const deckMeta = {};
const deckTitles = {}; // deck_id -> human label (for sub-decks like genre:ambient)

const stack = [{
  level: "top",
  pageIndex: 0,
  itemCursors: {}, // top-page id -> focused item index within that page's deck
}];

let nowPlaying = {
  state: "idle",
  title: "",
  subtitle: "",
  artwork: null,
  elapsed: null,
  duration: null,
  volume: 60,
  paused: false,
};
let nowPlayingMode = "volume"; // "volume" | "scroll"

let topMode = false; // true if the current DOM is the top-level carousel

// ── helpers ─────────────────────────────────────────────────────
function currentEntry() {
  return stack[stack.length - 1];
}

function visibleCards(deckId) {
  const cards = decks[deckId];
  if (!cards) return null;
  return cards.filter((c) => c.kind !== "back" && c.kind !== "back-to-top");
}

function deckLabel(deckId) {
  if (DECK_LABELS[deckId]) return DECK_LABELS[deckId];
  if (deckTitles[deckId]) return deckTitles[deckId].toUpperCase();
  return deckId.toUpperCase();
}

function formatTimeOfDay(d) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatElapsed(s) {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

// ── Cursor / encoder ────────────────────────────────────────────
function moveCursor(direction) {
  // direction: "next" or "prev"
  const entry = currentEntry();
  if (entry.level === "top") {
    moveTopCursor(direction);
  } else {
    moveDeckCursor(direction, entry);
  }
}

function moveTopCursor(direction) {
  const entry = currentEntry();
  const page = TOP_PAGES[entry.pageIndex];
  const delta = direction === "next" ? 1 : -1;

  // Now-playing: in volume mode, encoder = volume. CW = louder, matching
  // a physical volume knob.
  if (page.kind === "now-playing" && nowPlayingMode === "volume") {
    adjustVolume(delta * VOLUME_STEP);
    return;
  }

  // For pages with internal items, try to move within first.
  if (page.kind === "list" || page.kind === "live") {
    const items = visibleCards(page.deck);
    if (items && items.length) {
      const cur = entry.itemCursors[page.id] ?? 0;
      const next = cur + delta;
      if (next >= 0 && next < items.length) {
        entry.itemCursors[page.id] = next;
        maybePrefetchTopPage(page);
        renderTopActivePage();
        return;
      }
    }
  }

  // Edge — bounce to next/prev top page.
  const newPage = entry.pageIndex + delta;
  if (newPage >= 0 && newPage < TOP_PAGES.length) {
    entry.pageIndex = newPage;
    updateTopTransform();
    updateChrome();
    // Render the new active page + its neighbours so the slide reveals
    // already-populated content (the next page over may have been
    // outside the previous neighbourhood and still empty).
    renderTopNeighborhood();
  }
}

function moveDeckCursor(direction, entry) {
  const cards = visibleCards(entry.deck);
  if (!cards || !cards.length) return;
  const delta = direction === "next" ? 1 : -1;
  const next = Math.max(0, Math.min(cards.length - 1, entry.cursor + delta));
  if (next === entry.cursor) return;
  entry.cursor = next;
  maybePrefetchDeck(entry);
  updateDeckPageFocus();
}

// ── Click / long-press ─────────────────────────────────────────
function click() {
  const entry = currentEntry();
  if (entry.level === "top") {
    clickTop();
  } else {
    clickDeck(entry);
  }
}

function clickTop() {
  const entry = currentEntry();
  const page = TOP_PAGES[entry.pageIndex];

  if (page.kind === "now-playing") {
    if (nowPlayingMode === "volume") {
      if (nowPlaying.state === "playing") {
        send({ type: nowPlaying.paused ? "resume" : "pause" });
      }
    } else if (nowPlaying.state !== "idle") {
      // Stopping playback from scroll mode is a "we're done here" signal —
      // drop back to volume mode (PASSIVE) so the UI returns to its
      // resting state alongside the audio stop.
      send({ type: "stop" });
      nowPlayingMode = "volume";
      renderTopActivePage();
      updateInteractiveState();
    }
    return;
  }

  const items = visibleCards(page.deck);
  if (!items || !items.length) return;
  const cur = entry.itemCursors[page.id] ?? 0;
  triggerCard(items[cur]);
}

function clickDeck(entry) {
  const cards = visibleCards(entry.deck);
  if (!cards || !cards.length) return;
  triggerCard(cards[entry.cursor]);
}

function triggerCard(card) {
  if (!card) return;
  if (card.kind === "enter-deck") {
    enterDeck(card.deck, card.label);
  } else if (card.kind === "play") {
    // If this exact item is already playing or about to play, don't
    // re-issue the play (which would reload the stream / restart the
    // episode). Just snap to Now Playing so the user sees what's on.
    const sameAsCurrent =
      card.id === nowPlaying.card_id &&
      (nowPlaying.state === "playing" || nowPlaying.state === "loading");
    if (!sameAsCurrent) {
      send({ type: "play", card_id: card.id, queue: queueForCurrentContext() });
    }
    goToTopLevel();
  }
  // unplayable: no-op
}

// The list of playable card_ids (in order) in the user's current viewing
// context — used by the backend for auto-advance on episode end. Live
// channels and mixtapes are continuous, so their queues never advance,
// but it's harmless to send them anyway.
function queueForCurrentContext() {
  const entry = currentEntry();
  let cards;
  if (entry.level === "top") {
    const page = TOP_PAGES[entry.pageIndex];
    if (!page.deck) return [];
    cards = visibleCards(page.deck);
  } else {
    cards = visibleCards(entry.deck);
  }
  if (!cards) return [];
  return cards.filter((c) => c.kind === "play").map((c) => c.id);
}

function longPress() {
  const entry = currentEntry();
  if (entry.level === "top") {
    const page = TOP_PAGES[entry.pageIndex];
    if (page.kind === "now-playing") {
      nowPlayingMode = nowPlayingMode === "volume" ? "scroll" : "volume";
      // Entering scroll mode is a strong signal of fresh user attention —
      // ask the backend to re-fetch the live schedule so subsequent pages
      // reflect any upstream changes.
      if (nowPlayingMode === "scroll") send({ type: "refresh_live" });
      renderTopActivePage();
      updateInteractiveState();
      return;
    }
    // On any other top-level page: returning to Now Playing implies
    // exiting INTERACTIVE mode too — same code path the idle timeout
    // uses, so user-initiated and timed returns behave identically.
    goToTopLevel();
    return;
  }
  // Drilled in: pop to parent. Preserve cursors so the user can quickly
  // back out of an accidental drill-in and resume where they were.
  stack.pop();
  render();
}

function enterDeck(deckId, label) {
  if (label) deckTitles[deckId] = label;
  stack.push({ level: "deck", deck: deckId, cursor: 0 });
  if (!decks[deckId]) {
    send({ type: "request_deck", deck_id: deckId, offset: 0 });
  }
  render();
}

function goToTopLevel() {
  const wasOnNp = stack.length === 1 && stack[0].pageIndex === 0;
  stack.length = 1;
  stack[0].pageIndex = 0;
  nowPlayingMode = "volume";
  resetTopCursors(0);
  // When jumping home from another top page, snap the carousel directly
  // to NP rather than sliding through the intermediate pages. The slide
  // covers multiple page heights in 180ms while flashing through whatever
  // sits between, which competes with the 320ms screen-grow transition
  // and reads as laggy. Snapping leaves the screen un-insetting as the
  // single dominant motion.
  if (!wasOnNp) snapCarouselToActive();
  render();
}

// Fade-out → snap → fade-in. Total duration (80 + 240) lines up with the
// 320ms #screen un-inset transition so both motions resolve together.
// The fade-out hides the cross-page swap so the user doesn't see a hard
// cut between artworks.
const FADE_OUT_MS = 80 * 2;
const FADE_IN_MS = 240 * 2;

function snapCarouselToActive() {
  const carousel = screenEl.querySelector(".carousel");
  if (!carousel) return;
  const targetTransform = `translateY(-${stack[0].pageIndex * 100}%)`;
  const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";

  carousel.style.transition = `opacity ${FADE_OUT_MS}ms ${ease}`;
  carousel.style.opacity = "0";

  setTimeout(() => {
    // Snap transform while the carousel is invisible.
    carousel.style.transition = "none";
    carousel.style.transform = targetTransform;
    void carousel.offsetHeight;

    carousel.style.transition = `opacity ${FADE_IN_MS}ms ${ease}`;
    carousel.style.opacity = "1";

    setTimeout(() => {
      // Restore the CSS-default transition (transform 180ms) so future
      // user-driven page swaps slide normally.
      carousel.style.transition = "";
      carousel.style.opacity = "";
    }, FADE_IN_MS);
  }, FADE_OUT_MS);
}

// Cursor reset rule: pages "ahead" of the focused page snap to first item;
// pages "behind" snap to last item, so the next bounce in either direction
// lands at the boundary of the neighbouring page rather than mid-list.
function resetTopCursors(focusedPageIndex) {
  for (let i = 0; i < TOP_PAGES.length; i++) {
    const page = TOP_PAGES[i];
    if (!page.deck) continue; // Now Playing has no items
    const items = visibleCards(page.deck);
    const lastIdx = items && items.length ? items.length - 1 : 0;
    stack[0].itemCursors[page.id] = i < focusedPageIndex ? lastIdx : 0;
  }
}

function adjustVolume(delta) {
  const cur = nowPlaying.volume ?? 60;
  const next = Math.max(0, Math.min(100, cur + delta));
  if (next !== cur) {
    nowPlaying.volume = next; // optimistic; backend will echo back
    send({ type: "set_volume", value: next });
  }
  // Always peek — even at the rails (VOL 0 / VOL 100), the user still
  // wants visual confirmation that their input registered.
  peekVolumeHint();
}

// Briefly fade in a thin progress bar showing the current volume value,
// then fade out after a short delay. Re-arms on each rotation so the
// peek stays up for as long as the user keeps twisting.
let volumePeekTimer = null;

function peekVolumeHint() {
  if (!volumePeekEl || !volumePeekFillEl || !volumePeekLabelEl) return;
  if (isInteractive()) return; // chrome's already busy — leave the user be
  const vol = nowPlaying.volume ?? 60;
  volumePeekFillEl.style.width = `${vol}%`;
  volumePeekLabelEl.textContent = `VOL ${vol}`;
  volumePeekEl.classList.add("peek");
  if (volumePeekTimer !== null) clearTimeout(volumePeekTimer);
  volumePeekTimer = setTimeout(() => {
    if (volumePeekEl) volumePeekEl.classList.remove("peek");
    volumePeekTimer = null;
  }, VOLUME_PEEK_MS);
}

function clearVolumePeek() {
  if (volumePeekTimer !== null) {
    clearTimeout(volumePeekTimer);
    volumePeekTimer = null;
  }
  if (volumePeekEl) volumePeekEl.classList.remove("peek");
}

function decodeEntities(encodedString) {
  const textArea = document.createElement("textarea");
  textArea.innerHTML = encodedString;
  return textArea.value;
}

// NTS show titles often look like "Soup To Nuts w/ John Gómez". The "w/ Host"
// tail gets split off and rendered as the secondary line under the title;
// when the title doesn't split, `fallbackSub` is shown instead (description
// for mixtapes, date/location for episodes, …).
function setTitleAndSub(showEl, subEl, rawTitle, fallbackSub) {
  const split = splitTitleOnWith(decodeEntities(rawTitle || ""));
  const main = split.main.toUpperCase();
  const sub =
    split.with.toUpperCase() ||
    decodeEntities(fallbackSub || "").toUpperCase();
  if (showEl.textContent !== main) showEl.textContent = main;
  // Reserve the secondary line's space even when empty, so the bottom-
  // anchored content block doesn't shift between states (e.g. standby
  // → playing).
  const text = sub || " ";
  if (subEl.textContent !== text) subEl.textContent = text;
  subEl.hidden = false;
}

function splitTitleOnWith(raw) {
  if (!raw) return { main: "", with: "" };
  const m = raw.match(/^(.+?)\s+(w\/.*)$/i);
  if (!m) return { main: raw, with: "" };
  return { main: m[1].trim(), with: m[2].trim() };
}

// List rows render as two stacked lines: the show name on top, then a
// meta line combining the "w/ Host" tail (when present) with the card's
// subtitle (date/location for episodes, description for mixtapes…).
// Top-level mood/genre rows have no subtitle and no host, so meta is
// empty and the row collapses to a single title line.
function listRowParts(card) {
  const split = splitTitleOnWith(decodeEntities(card.label || ""));
  const subtitle = decodeEntities(card.subtitle || "").trim();
  const segments = [];
  if (split.with) segments.push(split.with);
  if (subtitle) segments.push(subtitle);
  return {
    main: split.main.toUpperCase(),
    meta: segments.join(" · ").toUpperCase(),
  };
}

// Show / hide the time-range and location segments in the eyebrow row,
// each paired with its preceding 1px divider. Used by Now Playing (live
// channels) and the Live page cards.
function setEyebrowMeta(eyebrowEl, timeRange, location) {
  const tEl = eyebrowEl.querySelector(".np-eyebrow-time");
  const tPipe = eyebrowEl.querySelector(".time-pipe");
  const lEl = eyebrowEl.querySelector(".np-eyebrow-loc");
  const lPipe = eyebrowEl.querySelector(".loc-pipe");

  const t = (timeRange || "").toUpperCase();
  const l = (location || "").toUpperCase();

  tEl.hidden = !t;
  tPipe.hidden = !t;
  if (t && tEl.textContent !== t) tEl.textContent = t;

  lEl.hidden = !l;
  lPipe.hidden = !l;
  if (l && lEl.textContent !== l) lEl.textContent = l;
}

// ── Prefetch ───────────────────────────────────────────────────
function maybePrefetchTopPage(page) {
  const meta = deckMeta[page.deck];
  if (!meta || !meta.hasMore || meta.pending) return;
  const cards = visibleCards(page.deck);
  if (!cards) return;
  const entry = currentEntry();
  const cur = entry.itemCursors[page.id] ?? 0;
  if (cur >= cards.length - PAGE_PREFETCH_THRESHOLD) {
    meta.pending = true;
    send({ type: "request_deck", deck_id: page.deck, offset: meta.nextOffset });
  }
}

function maybePrefetchDeck(entry) {
  const meta = deckMeta[entry.deck];
  if (!meta || !meta.hasMore || meta.pending) return;
  const cards = visibleCards(entry.deck);
  if (!cards) return;
  if (entry.cursor >= cards.length - PAGE_PREFETCH_THRESHOLD) {
    meta.pending = true;
    send({ type: "request_deck", deck_id: entry.deck, offset: meta.nextOffset });
  }
}

// ── Rendering ──────────────────────────────────────────────────
// Off-screen pages further than 1 step away are never visible during a
// 180ms carousel slide, so we skip rendering them. Their data still
// flows into the in-memory deck cache and is picked up the next time
// they fall within the active page's neighbourhood.
const RENDER_NEIGHBOR_RADIUS = 1;

function render() {
  const entry = currentEntry();
  if (entry.level === "top") {
    if (!topMode) {
      buildTopCarousel();
      topMode = true;
    }
    updateTopTransform();
    renderTopNeighborhood();
  } else {
    topMode = false;
    renderDeckPage(entry);
  }
  updateChrome();
}

function renderTopNeighborhood() {
  if (!topMode) return;
  const entry = currentEntry();
  TOP_PAGES.forEach((p, i) => {
    if (Math.abs(i - entry.pageIndex) <= RENDER_NEIGHBOR_RADIUS) {
      renderTopPageContent(p, i === entry.pageIndex);
    }
  });
}

function renderTopActivePage() {
  if (!topMode) return;
  const entry = currentEntry();
  const page = TOP_PAGES[entry.pageIndex];
  renderTopPageContent(page, true);
}

function updateChrome() {
  const entry = currentEntry();
  let label;
  let topIndex;
  if (entry.level === "top") {
    topIndex = entry.pageIndex;
    label = TOP_PAGES[topIndex].label;
  } else {
    // Keep the parent top-level page lit so the user retains spatial context
    // while drilled into a sub-deck.
    topIndex = stack[0].pageIndex;
    label = deckLabel(entry.deck);
  }
  if (chromeLabelEl) chromeLabelEl.textContent = label;
  updateSideDots(topIndex);
  updateInteractiveState();
}

function updateSideDots(activeIndex) {
  if (!sideDotsEl) return;
  if (sideDotsEl.children.length !== TOP_PAGES.length) {
    sideDotsEl.innerHTML = "";
    for (let i = 0; i < TOP_PAGES.length; i++) {
      const dot = document.createElement("span");
      dot.className = "dot";
      sideDotsEl.appendChild(dot);
    }
  }
  for (let i = 0; i < sideDotsEl.children.length; i++) {
    sideDotsEl.children[i].classList.toggle("on", i === activeIndex);
  }
}

// PASSIVE = Now Playing in volume mode (the resting state). INTERACTIVE
// covers everything else: NP scroll mode, any other top-level page, and
// any drilled-in deck. Toggles a single class on #stage; CSS handles the
// inset gutter + side-dots fade.
function isInteractive() {
  if (stack.length > 1) return true;
  const top = TOP_PAGES[stack[0].pageIndex];
  if (top.kind !== "now-playing") return true;
  return nowPlayingMode !== "volume";
}

function updateInteractiveState() {
  const interactive = isInteractive();
  stageEl.classList.toggle("interactive", interactive);
  if (interactive) armIdleTimer();
  else clearIdleTimer();
  // Any in-flight volume peek is bound to the previous state — discard
  // on transition so the peek doesn't bleed across mode changes.
  clearVolumePeek();
}

function updateTopTransform() {
  const carousel = screenEl.querySelector(".carousel");
  if (!carousel) return;
  const entry = currentEntry();
  carousel.style.transform = `translateY(-${entry.pageIndex * 100}%)`;
}

function buildTopCarousel() {
  screenEl.innerHTML = "";
  const carousel = document.createElement("div");
  carousel.className = "carousel";
  for (const page of TOP_PAGES) {
    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.dataset.pageId = page.id;
    carousel.appendChild(pageEl);
  }
  screenEl.appendChild(carousel);
}

function renderTopPageContent(page, isActive) {
  const pageEl = screenEl.querySelector(`.page[data-page-id="${page.id}"]`);
  if (!pageEl) return;
  if (page.kind === "now-playing") {
    renderNowPlayingPage(pageEl);
  } else if (page.kind === "live") {
    renderLivePage(pageEl, isActive);
  } else if (page.kind === "list") {
    renderListPage(pageEl, page);
  }
}

// ── Now Playing ────────────────────────────────────────────────
// Build the scaffold once; every subsequent render mutates the existing
// nodes in place. No DOM churn on time-pos ticks, no animation flicker.
function ensureNowPlayingScaffold(pageEl) {
  if (pageEl.dataset.npBuilt === "1") return;
  pageEl.dataset.npBuilt = "1";
  pageEl.innerHTML = `
    <div class="page-bg-idle" hidden></div>
    <div class="page-bg-image" hidden></div>
    <div class="page-bg-overlay"></div>
    <div class="np-content">
      <div class="np-eyebrow">
        <span class="live-pip"></span>
        <span class="eyebrow-spinner" hidden></span>
        <span class="np-status"></span>
        <span class="np-eyebrow-pipe time-pipe" hidden></span>
        <span class="np-eyebrow-time" hidden></span>
        <span class="np-eyebrow-pipe loc-pipe" hidden></span>
        <span class="np-eyebrow-loc" hidden></span>
      </div>
      <h1 class="np-show"></h1>
      <div class="np-sub" hidden></div>
      <div class="np-progress" hidden>
        <div class="np-progress-bar"><div class="np-progress-fill"></div></div>
        <div class="np-progress-times">
          <span class="np-time-elapsed"></span>
          <span class="np-time-duration"></span>
        </div>
      </div>
    </div>
  `;
}

function renderNowPlayingPage(pageEl) {
  if (!pageEl) return;
  ensureNowPlayingScaffold(pageEl);
  const np = nowPlaying;

  // Background image (hidden when idle/error or no artwork). Idle state
  // gets a tiled NTS wordmark instead so the screen isn't a flat void.
  const bg = pageEl.querySelector(".page-bg-image");
  const idleBg = pageEl.querySelector(".page-bg-idle");
  const showImg = np.state !== "idle" && np.state !== "error" && !!np.artwork;
  bg.hidden = !showImg;
  idleBg.hidden = np.state !== "idle";
  if (showImg) {
    const url = `url("${np.artwork}")`;
    if (bg.style.backgroundImage !== url) bg.style.backgroundImage = url;
  } else {
    bg.style.backgroundImage = "";
  }

  // Eyebrow: pip + status text on the left; for live channels the row
  // continues with time-range + location segments, each preceded by a thin
  // pipe divider. The pip pulses when actively playing live, sits dim
  // while paused/error, and is hidden for mixtapes / episodes / idle.
  // While loading, the pip is replaced by a small inline spinner so the
  // marker keeps its position next to the status word.
  const eyebrow = pageEl.querySelector(".np-eyebrow");
  const eyebrowStr = eyebrowText(np);
  pageEl.querySelector(".np-status").textContent = eyebrowStr;
  const isLive = np.card_kind === "live";
  const isLoading = np.state === "loading";
  const pulsing = isLive && np.state === "playing" && !np.paused;
  const pip = pageEl.querySelector(".live-pip");
  pip.hidden = isLoading || !isLive;
  pip.classList.toggle("idle", !pulsing);
  pageEl.querySelector(".eyebrow-spinner").hidden = !isLoading;
  setEyebrowMeta(
    eyebrow,
    isLive ? np.time_range : "",
    isLive ? np.location : "",
  );
  const hasMeta = isLive && (np.time_range || np.location);
  eyebrow.hidden = !eyebrowStr && !hasMeta;

  // Title + secondary line. The secondary line is the "w/ Host" tail when
  // the title splits, otherwise it falls back to np.subtitle (mixtape
  // description, episode date/location, …). Live channels carry no
  // subtitle now — their time/location is in the eyebrow above.
  const show = pageEl.querySelector(".np-show");
  const sub = pageEl.querySelector(".np-sub");
  if (np.state === "idle") {
    setTitleAndSub(show, sub, "Nothing playing", "");
  } else if (np.state === "error") {
    setTitleAndSub(show, sub, np.error_message || "Error", "");
  } else {
    setTitleAndSub(show, sub, np.title || "Loading…", np.subtitle);
  }

  // Progress block — non-live content with a known duration only.
  const showProgress =
    np.state === "playing" &&
    !np.is_live &&
    !!np.duration &&
    np.duration > 0 &&
    np.elapsed != null;
  const prog = pageEl.querySelector(".np-progress");
  prog.hidden = !showProgress;
  if (showProgress) {
    const pct = Math.min(100, (np.elapsed / np.duration) * 100);
    pageEl.querySelector(".np-progress-fill").style.width = `${pct}%`;
    pageEl.querySelector(".np-time-elapsed").textContent = formatElapsed(np.elapsed);
    pageEl.querySelector(".np-time-duration").textContent = formatElapsed(np.duration);
  }
}

function eyebrowText(np) {
  if (np.state === "idle") return "STANDBY";
  if (np.state === "loading") return "LOADING";
  if (np.state === "error") return "ERROR";
  if (np.state === "playing") {
    if (np.paused) return "PAUSED";
    if (np.card_kind === "live") return "ON AIR";
    if (np.card_kind === "mixtape") return "INFINITE MIXTAPE";
    // Episodes (and unknown kinds): no eyebrow text — the title carries it.
    return "";
  }
  return np.state.toUpperCase();
}

// ── Live page (2 channels) ─────────────────────────────────────
function ensureLiveScaffold(pageEl) {
  if (pageEl.dataset.liveBuilt === "1") return;
  pageEl.dataset.liveBuilt = "1";
  pageEl.innerHTML = `<div class="live-grid"></div>`;
}

// Live cards mirror the Now Playing scaffold (eyebrow + show + sub),
// scaled down and bottom-left aligned via CSS — same vocabulary, same
// classes. Build the empty shell once per channel, then update content
// idempotently on every render so backend deck broadcasts (episode
// rollovers) repaint in place.
function buildLiveCardScaffold(index) {
  const cardEl = document.createElement("div");
  cardEl.className = "live-card";
  cardEl.dataset.i = String(index);
  cardEl.innerHTML = `
    <div class="bg-image"></div>
    <div class="bg-overlay"></div>
    <div class="live-card-inner">
      <div class="np-eyebrow">
        <span class="live-pip"></span>
        <span class="np-status"></span>
        <span class="np-eyebrow-pipe time-pipe" hidden></span>
        <span class="np-eyebrow-time" hidden></span>
        <span class="np-eyebrow-pipe loc-pipe" hidden></span>
        <span class="np-eyebrow-loc" hidden></span>
      </div>
      <div class="np-show"></div>
      <div class="np-sub" hidden></div>
    </div>
  `;
  return cardEl;
}

function updateLiveCard(cardEl, card) {
  const bg = cardEl.querySelector(".bg-image");
  const desired = card.artwork ? `url("${card.artwork}")` : "";
  if (bg.style.backgroundImage !== desired) bg.style.backgroundImage = desired;

  const status = cardEl.querySelector(".np-status");
  const label = (card.label || "").toUpperCase();
  if (status.textContent !== label) status.textContent = label;

  setEyebrowMeta(cardEl.querySelector(".np-eyebrow"), card.time_range, card.location);
  setTitleAndSub(
    cardEl.querySelector(".np-show"),
    cardEl.querySelector(".np-sub"),
    card.subtitle || "Loading…",
    "",
  );
}

function renderLivePage(pageEl, isActive) {
  ensureLiveScaffold(pageEl);
  const grid = pageEl.querySelector(".live-grid");
  const cards = visibleCards("live");

  if (!cards) {
    if (grid.dataset.liveSig !== "loading") {
      grid.dataset.liveSig = "loading";
      grid.innerHTML = "";
      const loader = document.createElement("div");
      loader.className = "loading-state";
      loader.innerHTML = `<div class="spinner"></div><div class="loading-label">LOADING LIVE</div>`;
      grid.appendChild(loader);
    }
    return;
  }

  // Build scaffolds only when the channel set changes; thereafter just
  // update content. Keeps DOM stable across episode-rollover broadcasts.
  const sig = cards.map((c) => c.id).join("|");
  if (grid.dataset.liveSig !== sig) {
    grid.dataset.liveSig = sig;
    grid.innerHTML = "";
    cards.forEach((_, i) => grid.appendChild(buildLiveCardScaffold(i)));
  }
  cards.forEach((card, i) => updateLiveCard(grid.children[i], card));

  // Update focus highlighting in place.
  const entry = currentEntry();
  const focused = entry.level === "top" ? (entry.itemCursors.live ?? 0) : 0;
  grid.querySelectorAll(".live-card").forEach((cardEl) => {
    const i = parseInt(cardEl.dataset.i, 10);
    cardEl.classList.toggle("on", i === focused && isActive);
  });
}

// ── List page (top-level Moods/Mixtapes/Genres OR drilled deck) ─
function renderListPage(pageEl, page) {
  const cards = visibleCards(page.deck);
  if (!cards) {
    renderLoading(pageEl, `LOADING ${page.label}`);
    return;
  }
  const entry = currentEntry();
  const focused = entry.level === "top" ? (entry.itemCursors[page.id] ?? 0) : 0;
  buildOrUpdateList(pageEl, {
    title: page.label,
    subtitle: subtitleForPage(page, cards),
    cards,
    focused,
  });
}

function renderDeckPage(entry) {
  // Clear top-level DOM
  screenEl.innerHTML = "";
  const pageEl = document.createElement("div");
  pageEl.className = "list-page";
  screenEl.appendChild(pageEl);

  const cards = visibleCards(entry.deck);
  if (!cards) {
    renderLoading(pageEl, `LOADING ${deckLabel(entry.deck)}`);
    return;
  }
  const focused = Math.max(0, Math.min(cards.length - 1, entry.cursor));
  entry.cursor = focused;
  buildOrUpdateList(pageEl, {
    title: deckLabel(entry.deck),
    subtitle: subtitleForCount(cards),
    cards,
    focused,
  });
}

function updateDeckPageFocus() {
  const entry = currentEntry();
  if (entry.level === "top") return;
  const cards = visibleCards(entry.deck);
  if (!cards) return;
  const pageEl = screenEl.querySelector(".list-page");
  if (!pageEl) {
    renderDeckPage(entry);
    return;
  }
  buildOrUpdateList(pageEl, {
    title: deckLabel(entry.deck),
    subtitle: subtitleForCount(cards),
    cards,
    focused: entry.cursor,
  });
}

function subtitleForPage(page, cards) {
  if (page.id === "moods") return "SELECT A MOOD";
  if (page.id === "mixtapes") return "ALWAYS ON, ALWAYS DIFFERENT";
  if (page.id === "genres") return "SELECT A GENRE";
  return subtitleForCount(cards);
}

function subtitleForCount(cards) {
  return `${cards.length} ITEM${cards.length === 1 ? "" : "S"}`;
}

function buildOrUpdateList(pageEl, { title, subtitle, cards, focused }) {
  const sig = `${title}|${cards.length}|${cards.map((c) => c.id).join(",")}`;
  const existingSig = pageEl.dataset.listSig;

  if (existingSig !== sig) {
    pageEl.dataset.listSig = sig;
    pageEl.innerHTML = "";

    const bg = document.createElement("div");
    bg.className = "bg-image list-bg-image";
    pageEl.appendChild(bg);

    const overlay = document.createElement("div");
    overlay.className = "bg-overlay list-overlay";
    pageEl.appendChild(overlay);

    const header = document.createElement("div");
    header.className = "list-header";
    const titleEl = document.createElement("div");
    titleEl.className = "list-title";
    titleEl.textContent = title;
    header.appendChild(titleEl);
    if (subtitle) {
      const subEl = document.createElement("div");
      subEl.className = "list-sub";
      subEl.textContent = subtitle;
      header.appendChild(subEl);
    }
    pageEl.appendChild(header);

    const scroll = document.createElement("div");
    scroll.className = "list-scroll";
    scroll.appendChild(spacer());

    cards.forEach((card, i) => {
      const row = document.createElement("div");
      row.className = "list-row" + (card.kind === "unplayable" ? " unplayable" : "");
      row.dataset.i = String(i);

      const { main, meta } = listRowParts(card);

      const num = document.createElement("span");
      num.className = "list-num";
      num.textContent = String(i + 1).padStart(2, "0");
      row.appendChild(num);

      const name = document.createElement("span");
      name.className = "list-name";
      name.textContent = main;
      row.appendChild(name);

      if (meta) {
        const metaEl = document.createElement("span");
        metaEl.className = "list-row-meta";
        metaEl.textContent = meta;
        row.appendChild(metaEl);
      }

      const marker = document.createElement("span");
      marker.className = "list-marker";
      row.appendChild(marker);

      scroll.appendChild(row);
    });

    scroll.appendChild(spacer());
    pageEl.appendChild(scroll);
  }

  // Update focus highlighting + bg image
  applyListFocus(pageEl, cards, focused);
}

function applyListFocus(pageEl, cards, focused) {
  const focusedCard = cards[focused];
  const bg = pageEl.querySelector(".list-bg-image");
  if (bg) {
    bg.style.backgroundImage = focusedCard?.artwork
      ? `url("${focusedCard.artwork}")`
      : "";
  }

  const rows = pageEl.querySelectorAll(".list-row");
  rows.forEach((row) => {
    const i = parseInt(row.dataset.i, 10);
    const dist = Math.abs(i - focused);
    row.classList.toggle("on", i === focused);
    row.style.opacity = i === focused ? "1" : String(Math.max(0.18, 0.7 - dist * 0.15));
  });

  const focusedRow = pageEl.querySelector(`.list-row[data-i="${focused}"]`);
  const scroll = pageEl.querySelector(".list-scroll");
  if (focusedRow && scroll) {
    const elRect = scroll.getBoundingClientRect();
    const itemRect = focusedRow.getBoundingClientRect();
    const offset =
      itemRect.top - elRect.top - elRect.height / 2 + itemRect.height / 2;
    scroll.scrollBy({ top: offset, behavior: "smooth" });
  }
}

function spacer() {
  const s = document.createElement("div");
  s.className = "list-spacer";
  return s;
}

function renderLoading(el, label) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "loading-state";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  wrap.appendChild(spinner);
  const lab = document.createElement("div");
  lab.className = "loading-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  el.appendChild(wrap);
}

// ── Deck data handling ─────────────────────────────────────────
function handleDeckData(msg) {
  const deckId = msg.deck_id;
  const offset = msg.offset || 0;
  const cards = msg.cards || [];

  if (offset === 0) {
    decks[deckId] = cards;
    deckMeta[deckId] = {
      hasMore: !!msg.has_more,
      nextOffset: countContent(cards),
      pending: false,
    };
  } else {
    const existing = decks[deckId];
    const meta = deckMeta[deckId];
    if (!existing || !meta || meta.nextOffset !== offset) return;
    // Append before the trailing back-to-top if it exists; otherwise append at end.
    const trailingIdx = existing.findIndex((c) => c.kind === "back-to-top");
    if (trailingIdx >= 0) {
      existing.splice(trailingIdx, 0, ...cards);
    } else {
      existing.push(...cards);
    }
    meta.hasMore = !!msg.has_more;
    meta.nextOffset += cards.length;
    meta.pending = false;
  }
  prefetchArtwork(cards);

  // Re-render whichever surface is showing this deck. Off-neighbourhood
  // top pages stay deferred — the next render-neighbourhood pass picks
  // them up from the deck cache when they come into range.
  const entry = currentEntry();
  if (entry.level === "top" && topMode) {
    const i = TOP_PAGES.findIndex((p) => p.deck === deckId);
    if (i !== -1 && Math.abs(i - entry.pageIndex) <= RENDER_NEIGHBOR_RADIUS) {
      renderTopPageContent(TOP_PAGES[i], i === entry.pageIndex);
    }
  } else if (entry.deck === deckId) {
    renderDeckPage(entry);
  }
}

function countContent(cards) {
  let n = 0;
  for (const c of cards) {
    if (c.kind !== "back" && c.kind !== "back-to-top") n++;
  }
  return n;
}

function prefetchArtwork(cards) {
  for (const c of cards) {
    if (c.artwork) {
      const img = new Image();
      img.src = c.artwork;
    }
    // Pre-warm the next live episode's artwork (live cards only) so the
    // bg-image swap at the hour rollover is a cache hit.
    if (c.next_artwork && c.next_artwork !== c.artwork) {
      const img = new Image();
      img.src = c.next_artwork;
    }
  }
}

// ── WebSocket ──────────────────────────────────────────────────
let ws;
let pressTimer = null;
let longPressed = false;

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener("open", () => {
    // Pre-fetch all top-level decks so the carousel pages have data on first scroll.
    for (const page of TOP_PAGES) {
      if (page.deck) {
        send({ type: "request_deck", deck_id: page.deck, offset: 0 });
      }
    }
  });
  ws.addEventListener("message", (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "encoder") handleEncoder(msg);
    else if (msg.type === "deck_data") handleDeckData(msg);
    else if (msg.type === "now_playing") {
      nowPlaying = msg;
      // Refresh NP only if it's the active page or one over — far-off
      // updates are wasted work; the next neighbourhood render reads the
      // latest nowPlaying state when NP comes back into range.
      const entry = currentEntry();
      if (entry.level === "top" && topMode) {
        const npIndex = TOP_PAGES.findIndex((p) => p.kind === "now-playing");
        if (Math.abs(entry.pageIndex - npIndex) <= RENDER_NEIGHBOR_RADIUS) {
          renderTopPageContent(TOP_PAGES[npIndex], entry.pageIndex === npIndex);
        }
      }
    }
  });
  ws.addEventListener("close", () => setTimeout(connect, 500));
}

function handleEncoder(event) {
  if (event.event === "rotate") {
    moveCursor(event.direction === "cw" ? "next" : "prev");
  } else if (event.event === "click") {
    click();
  } else if (event.event === "long_press") {
    longPress();
  }
  // Re-arm idle timer on every input. updateInteractiveState() (called
  // from render paths) will clear it again if the input took us back to
  // PASSIVE; otherwise we tick the new threshold from now.
  if (isInteractive()) armIdleTimer();
}

// Auto-return to Now Playing in volume mode after a stretch of no input.
// Only ticks while INTERACTIVE — cleared on entering PASSIVE.
let idleTimer = null;

function armIdleTimer() {
  clearIdleTimer();
  const ms = nowPlaying.state === "playing"
    ? IDLE_RETURN_PLAYING_MS
    : IDLE_RETURN_OTHERWISE_MS;
  idleTimer = setTimeout(goToTopLevel, ms);
}

function clearIdleTimer() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// ── Keyboard simulation ────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.repeat && e.key === "Enter") return;
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    send({ type: "encoder", event: "rotate", direction: "ccw", velocity: 1 });
    e.preventDefault();
  } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    send({ type: "encoder", event: "rotate", direction: "cw", velocity: 1 });
    e.preventDefault();
  } else if (e.key === "Enter" && pressTimer === null) {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      send({ type: "encoder", event: "long_press" });
    }, LONG_PRESS_MS);
    e.preventDefault();
  } else if (e.key === "Escape") {
    send({ type: "encoder", event: "long_press" });
    e.preventDefault();
  }
});

// Trackpad / mouse wheel → rotary encoder rotate. Accumulates deltaY across
// fine-grained trackpad events so each discrete encoder tick fires after a
// reasonable amount of swipe travel.
const WHEEL_PER_TICK = 60;
let wheelAccum = 0;
document.addEventListener(
  "wheel",
  (e) => {
    wheelAccum += e.deltaY;
    while (Math.abs(wheelAccum) >= WHEEL_PER_TICK) {
      const direction = wheelAccum > 0 ? "cw" : "ccw";
      send({ type: "encoder", event: "rotate", direction, velocity: 1 });
      wheelAccum -= wheelAccum > 0 ? WHEEL_PER_TICK : -WHEEL_PER_TICK;
    }
    e.preventDefault();
  },
  { passive: false }
);

document.addEventListener("keyup", (e) => {
  if (e.key === "Enter") {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (!longPressed) send({ type: "encoder", event: "click" });
    longPressed = false;
  }
});

// ── Clock ──────────────────────────────────────────────────────
function tickClock() {
  const now = new Date();
  chromeTimeEl.textContent = formatTimeOfDay(now);
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(tickClock, msToNextMinute);
}
tickClock();

// ── Boot ───────────────────────────────────────────────────────
render();
connect();
