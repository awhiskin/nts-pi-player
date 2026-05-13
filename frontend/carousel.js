const PRESS_HOLD_MS = 500;
const PAGE_PREFETCH_THRESHOLD = 5;
const VOLUME_STEP = 5;
const VOLUME_PEEK_MS = 750;

// List-row geometry, sourced from the matching CSS custom properties.
// Read from a specific element so per-page overrides (e.g. the EXPLORE
// "hero list" treatment) cascade through and the .list-track translate
// math stays accurate without DOM measurement.
function listGeomFrom(el) {
  const cs = getComputedStyle(el);
  const px = (name) => parseFloat(cs.getPropertyValue(name));
  const padY = px("--list-row-pad-y");
  const padYOn = px("--list-row-pad-y-on");
  const gap = px("--list-row-gap");
  const titleH = px("--list-title-h");
  const titleHOn = px("--list-title-h-on");
  const metaH = px("--list-meta-h");
  return {
    rowHeightWithMeta: padY * 2 + titleH + gap + metaH,
    rowHeightNoMeta: padY * 2 + titleH,
    focusedTitleCentre: padYOn + titleHOn / 2,
  };
}
// Default :root geometry — used for the few places that don't have a
// pageEl context (e.g. one-off measurements at module load).
const LIST_GEOM = listGeomFrom(document.documentElement);

const TOP_PAGES = [
  { id: "now-playing", kind: "now-playing", label: "NOW PLAYING" },
  // CHANNEL 1 and CHANNEL 2 share the live deck; each renders just
  // its own channel full-page via channelId.
  { id: "channel-1",   kind: "channel",     label: "CHANNEL 1", deck: "live", channelId: "channel-1" },
  { id: "channel-2",   kind: "channel",     label: "CHANNEL 2", deck: "live", channelId: "channel-2" },
  // EXPLORE is split across two pages of two banner cards each.
  // Both read from the single backend "explore" deck and slice into
  // it via [start, end) so server-side stays simple.
  { id: "explore-1",   kind: "explore",     label: "EXPLORE",   deck: "explore", slice: [0, 2] },
  { id: "explore-2",   kind: "explore",     label: "EXPLORE",   deck: "explore", slice: [2, 4] },
  // GENRES at the top level is a flat list (drill-in to specific
  // genres). It paginates differently from a banner page would, and
  // 35+ genres can't fit as banners anyway.
  { id: "genres",      kind: "list",        label: "GENRES",    deck: "genres" },
];

const DECK_LABELS = {
  live: "LIVE",
  mixtapes: "MIXTAPES",
  moods: "MOODS",
  "nts-picks": "NTS PICKS",
  latest: "LATEST",
  genres: "GENRES",
  explore: "EXPLORE",
};

// Cards visible on a specific top page — applies any slice the page
// declares, so an "explore" page only sees its own two of the four
// shared explore-deck cards. Generic helper rather than per-call
// slicing to keep moveTopCursor / clickTop / render in sync.
function pageVisibleCards(page) {
  const cards = visibleCards(page.deck);
  if (!cards) return null;
  if (page.slice) return cards.slice(page.slice[0], page.slice[1]);
  return cards;
}

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

// Encoder press state — set true while the button is held past the
// 500ms threshold. While held, rotate events adjust volume instead of
// navigating; pressHeldTwisted records whether that happened so we can
// distinguish release-after-volume (no-op) from release-without-twist
// (back / return-to-NP).
let pressHeld = false;
let pressHeldTwisted = false;

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

  // For pages with internal items, try to move within first.
  // Channel pages don't scroll — single-card pages, rotation bounces
  // straight to the next/prev top page.
  if (page.kind === "list" || page.kind === "explore") {
    const items = pageVisibleCards(page);
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
    // Click on NP toggles pause/resume when a stream is loaded. Loading,
    // idle, and error are non-actionable from here — there's nothing to
    // pause, and stop is now handled by the 15-minute pause-auto-stop.
    if (nowPlaying.state === "playing" || nowPlaying.paused) {
      send({ type: nowPlaying.paused ? "resume" : "pause" });
    }
    return;
  }

  if (page.kind === "channel") {
    // Play the specific channel this page is bound to. The live
    // deck holds the data; we delegate to triggerCard so the
    // already-playing short-circuit (same-as-current) applies.
    const cards = visibleCards("live") || [];
    const target = cards.find((c) => c.id === page.channelId);
    if (target) triggerCard(target);
    return;
  }

  const items = pageVisibleCards(page);
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

// Universal "back" gesture: pop one stack level when drilled in, return
// to Now Playing from any other top page, no-op when already on NP.
// Fires from release-without-twist of the encoder press.
function backGesture() {
  const entry = currentEntry();
  if (entry.level === "top") {
    const page = TOP_PAGES[entry.pageIndex];
    if (page.kind === "now-playing") return; // already home
    goToTopLevel();
    return;
  }
  // Drilled in: pop to parent. Preserve cursors so the user can quickly
  // back out of an accidental drill-in and resume where they were.
  crossfadeRender(() => {
    stack.pop();
  });
}

function enterDeck(deckId, label) {
  if (label) deckTitles[deckId] = label;
  // Fire the network request immediately — don't wait for the
  // transition. If the deck is already cached the new render shows
  // real content during the crossfade; otherwise it'll show a loading
  // state which is fine.
  if (!decks[deckId]) {
    send({ type: "request_deck", deck_id: deckId, offset: 0 });
  }
  crossfadeRender(() => {
    stack.push({ level: "deck", deck: deckId, cursor: 0 });
  });
}

function goToTopLevel() {
  const wasOnNp = stack.length === 1 && stack[0].pageIndex === 0;
  stack.length = 1;
  stack[0].pageIndex = 0;
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

// Crossfade between renders: take a visual clone of the current
// screenEl contents, run the mutation + render normally (new content
// appears at full opacity from frame 0), then layer the clone on top
// and fade it out. The old content gracefully disappears while the new
// content fades in via its own per-element animation — both curves
// overlap, so there's never a frame where the screen is empty.
//
// Used for deck push/pop. Top-level page rotation doesn't need this —
// the .carousel slides via CSS transform and both source and target
// pages stay mounted.
const CROSSFADE_MS = 320;

function crossfadeRender(mutator) {
  const old = screenEl.firstElementChild;
  if (!old) {
    mutator();
    render();
    return;
  }
  // cloneNode copies the visual snapshot — no event handlers, no live
  // updates. Cheap enough even for a 100-row list (a few ms of deep
  // copy). The clone is overlay-positioned absolutely above the new
  // content via z-index. pointer-events:none so it doesn't intercept
  // any input during the fade.
  const overlay = old.cloneNode(true);
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "10";

  mutator();
  render();

  screenEl.appendChild(overlay);
  // Force a layout pass before flipping opacity so the transition has
  // an initial state to interpolate from.
  void overlay.offsetHeight;
  overlay.style.transition = `opacity ${CROSSFADE_MS}ms var(--ease-out)`;
  overlay.style.opacity = "0";
  setTimeout(() => overlay.remove(), CROSSFADE_MS + 40);
}

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
  const tDot = eyebrowEl.querySelector(".time-dot");
  const lEl = eyebrowEl.querySelector(".np-eyebrow-loc");
  const lDot = eyebrowEl.querySelector(".loc-dot");

  const t = (timeRange || "").toUpperCase();
  const l = (location || "").toUpperCase();

  tEl.hidden = !t;
  tDot.hidden = !t;
  if (t && tEl.textContent !== t) tEl.textContent = t;

  lEl.hidden = !l;
  lDot.hidden = !l;
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
  } else if (page.kind === "channel") {
    renderChannelPage(pageEl, page);
  } else if (page.kind === "explore") {
    renderExplorePage(pageEl, page);
  } else if (page.kind === "list") {
    renderListPage(pageEl, page);
  }
}

// ── Channel page (single live channel, full-bleed) ─────────────
// Each CHANNEL N top page binds to one card in the shared live
// deck and renders just that card full-page. Reuses the live-card
// scaffold/update helpers below so episode rollovers repaint in
// place.
function renderChannelPage(pageEl, page) {
  if (pageEl.dataset.channelBuilt !== "1") {
    pageEl.dataset.channelBuilt = "1";
    pageEl.innerHTML = "";
    const card = buildLiveCardScaffold(0);
    card.classList.add("standalone", "on");
    pageEl.appendChild(card);
  }
  const cards = visibleCards("live") || [];
  const data = cards.find((c) => c.id === page.channelId);
  if (data) updateLiveCard(pageEl.querySelector(".live-card"), data);
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
      <div class="np-eyebrow meta-label">
        <span class="live-pip"></span>
        <span class="eyebrow-spinner" hidden></span>
        <span class="np-status"></span>
        <span class="np-eyebrow-dot time-dot" hidden>&nbsp;·&nbsp;</span>
        <span class="np-eyebrow-time" hidden></span>
        <span class="np-eyebrow-dot loc-dot" hidden>&nbsp;·&nbsp;</span>
        <span class="np-eyebrow-loc" hidden></span>
      </div>
      <h1 class="np-show"></h1>
      <div class="np-sub" hidden></div>
      <div class="np-progress" hidden>
        <div class="np-progress-bar"><div class="np-progress-fill"></div></div>
        <div class="np-progress-times meta-label">
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
  // continues with time-range + location segments, each preceded by a
  // middle-dot. The pip pulses when actively playing live, sits dim
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

// ── Live-card primitives ──────────────────────────────────────
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
      <div class="np-eyebrow meta-label">
        <span class="live-pip"></span>
        <span class="np-status"></span>
        <span class="np-eyebrow-dot time-dot" hidden>&nbsp;·&nbsp;</span>
        <span class="np-eyebrow-time" hidden></span>
        <span class="np-eyebrow-dot loc-dot" hidden>&nbsp;·&nbsp;</span>
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

// ── List page (top-level GENRES or any drilled-in deck) ───────
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

// ── Explore page (banner cards, like the old LIVE grid) ───────
function ensureExploreScaffold(pageEl) {
  if (pageEl.dataset.exploreBuilt === "1") return;
  pageEl.dataset.exploreBuilt = "1";
  pageEl.innerHTML = `<div class="explore-grid"></div>`;
}

function buildExploreCardScaffold(index) {
  const cardEl = document.createElement("div");
  cardEl.className = "explore-card";
  cardEl.dataset.i = String(index);
  cardEl.innerHTML = `
    <div class="bg-image"></div>
    <div class="bg-overlay"></div>
    <div class="explore-card-inner">
      <span class="explore-card-name"></span>
      <span class="explore-card-sub"></span>
    </div>
  `;
  return cardEl;
}

function updateExploreCard(cardEl, card) {
  const bg = cardEl.querySelector(".bg-image");
  const desired = card.artwork ? `url("${card.artwork}")` : "";
  if (bg.style.backgroundImage !== desired) bg.style.backgroundImage = desired;
  // No-art cards expose the .explore-card's own tiled pattern bg via
  // a class toggle that adjusts the overlay weight.
  cardEl.classList.toggle("has-art", !!card.artwork);

  const name = cardEl.querySelector(".explore-card-name");
  const label = (card.label || "").toUpperCase();
  if (name.textContent !== label) name.textContent = label;

  const sub = cardEl.querySelector(".explore-card-sub");
  const subText = (card.subtitle || "").toUpperCase();
  if (sub.textContent !== subText) sub.textContent = subText;
  sub.hidden = !subText;
}

function renderExplorePage(pageEl, page) {
  ensureExploreScaffold(pageEl);
  const grid = pageEl.querySelector(".explore-grid");
  const cards = pageVisibleCards(page);

  if (!cards) {
    if (grid.dataset.sig !== "loading") {
      grid.dataset.sig = "loading";
      grid.innerHTML = "";
      const loader = document.createElement("div");
      loader.className = "loading-state";
      loader.innerHTML = `<div class="spinner"></div><div class="loading-label">LOADING</div>`;
      grid.appendChild(loader);
    }
    return;
  }

  // Sig keys per-page so swapping between explore-1 and explore-2
  // (same deck, different slice) triggers a fresh scaffold.
  const sig = `${page.id}|${cards.map((c) => c.id).join("|")}`;
  if (grid.dataset.sig !== sig) {
    grid.dataset.sig = sig;
    grid.innerHTML = "";
    cards.forEach((_, i) => grid.appendChild(buildExploreCardScaffold(i)));
  }
  cards.forEach((card, i) => updateExploreCard(grid.children[i], card));

  const entry = currentEntry();
  const focused = entry.level === "top" ? (entry.itemCursors[page.id] ?? 0) : 0;
  Array.from(grid.children).forEach((cardEl) => {
    const i = parseInt(cardEl.dataset.i, 10);
    cardEl.classList.toggle("on", i === focused);
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
  const display = withLoadingMore(cards, deckMeta[entry.deck]);
  // Cursor stays clamped to real-card indexes — the loading-more
  // placeholder is decorative and lives at display[cards.length].
  const focused = Math.max(0, Math.min(cards.length - 1, entry.cursor));
  entry.cursor = focused;
  buildOrUpdateList(pageEl, {
    title: deckLabel(entry.deck),
    cards: display,
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
  const display = withLoadingMore(cards, deckMeta[entry.deck]);
  buildOrUpdateList(pageEl, {
    title: deckLabel(entry.deck),
    cards: display,
    focused: entry.cursor,
  });
}

// Append a decorative "loading more" row when the deck has further
// pages. The placeholder sits past the last real card, so when the
// cursor is on the last episode the user sees a "more coming" cue
// directly below — without making the placeholder cursor-targetable.
function withLoadingMore(cards, meta) {
  if (!meta || !meta.hasMore) return cards;
  return [...cards, { id: "__loading_more__", kind: "loading-more" }];
}

function subtitleForPage(page, cards) {
  if (page.id === "genres") return "SELECT A GENRE";
  return "";
}

function buildOrUpdateList(pageEl, { title, subtitle, cards, focused }) {
  const sig = `${title}|${cards.length}|${cards.map((c) => c.id).join(",")}`;
  const existingSig = pageEl.dataset.listSig;

  if (existingSig !== sig) {
    pageEl.dataset.listSig = sig;
    pageEl.innerHTML = "";

    // Tiled NTS pattern, always present. When .list-bg-image has no
    // URL (cards without artwork — genres top-level, genre detail),
    // the transparent layer above lets this pattern show through.
    const idle = document.createElement("div");
    idle.className = "list-bg-idle";
    pageEl.appendChild(idle);

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

    const track = document.createElement("div");
    track.className = "list-track";

    cards.forEach((card, i) => {
      const row = document.createElement("div");
      const extraClass =
        card.kind === "unplayable" ? " unplayable" :
        card.kind === "loading-more" ? " loading-more" : "";
      row.className = "list-row" + extraClass;
      row.dataset.i = String(i);

      if (card.kind === "loading-more") {
        // Decorative placeholder past the last real card — signals that
        // more episodes are loading. No number, no meta, just a label.
        const name = document.createElement("span");
        name.className = "list-name";
        name.textContent = "LOADING MORE…";
        row.appendChild(name);
        track.appendChild(row);
        return;
      }

      const { main, meta } = listRowParts(card);

      const num = document.createElement("span");
      num.className = "list-num meta-label";
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

      track.appendChild(row);
    });

    scroll.appendChild(track);

    // Single fixed-position marker pinned at the viewport's vertical
    // centre. Rows slide under it (via .list-track translateY) so the
    // focused row is always exactly under the marker — no chase.
    const marker = document.createElement("span");
    marker.className = "list-focus-marker";
    scroll.appendChild(marker);

    pageEl.appendChild(scroll);

    // (Re)build the Y-offset cache for this DOM. Cards length / kinds
    // are baked into the sig, so a cache built here matches the rows
    // we just appended until the next sig-change rebuild.
    buildOffsetCache(pageEl, cards);
    // Force fresh focus paint after a DOM rebuild — no previous window
    // exists, so applyListFocus should treat it as a first-render.
    delete pageEl.dataset.lastFocused;
  }

  // Update focus highlighting + bg image
  applyListFocus(pageEl, cards, focused);
}

// Rows outside this distance from the focused row land at the dim
// floor — the per-row opacity formula caps at 0.18 past dist 4, so
// touching them on every cursor move is pure DOM thrash on long lists.
const OPACITY_WINDOW = 4;

// Cumulative Y-offset per row, keyed by pageEl. Populated when the
// list DOM is (re)built so listTrackOffset becomes O(1) instead of
// looping 0..focused on every encoder tick.
const offsetCache = new WeakMap();

function applyListFocus(pageEl, cards, focused) {
  const focusedCard = cards[focused];
  const bg = pageEl.querySelector(".list-bg-image");
  if (bg) {
    bg.style.backgroundImage = focusedCard?.artwork
      ? `url("${focusedCard.artwork}")`
      : "";
  }

  const track = pageEl.querySelector(".list-track");
  if (!track) return;
  const rows = track.children;

  // Sliding-window update: clear the previous focus window, then
  // re-paint the new one. Each window is ~9 rows, so the work is
  // bounded regardless of list length.
  const prev = pageEl.dataset.lastFocused;
  const lastFocused = prev !== undefined ? parseInt(prev, 10) : focused;
  pageEl.dataset.lastFocused = String(focused);

  const clearMin = Math.max(0, lastFocused - OPACITY_WINDOW);
  const clearMax = Math.min(rows.length - 1, lastFocused + OPACITY_WINDOW);
  for (let i = clearMin; i <= clearMax; i++) {
    const row = rows[i];
    row.classList.remove("on");
    row.style.opacity = "";
  }

  const setMin = Math.max(0, focused - OPACITY_WINDOW);
  const setMax = Math.min(rows.length - 1, focused + OPACITY_WINDOW);
  for (let i = setMin; i <= setMax; i++) {
    const row = rows[i];
    const dist = Math.abs(i - focused);
    if (i === focused) {
      row.classList.add("on");
      row.style.opacity = "1";
    } else {
      row.style.opacity = String(Math.max(0.18, 0.7 - dist * 0.15));
    }
  }

  // Compute translateY from the cached cumulative-row offsets — no
  // measurement, no per-tick loop over the list.
  track.style.transform = `translateY(${listTrackOffset(pageEl, focused)}px)`;
}

function buildOffsetCache(pageEl, cards) {
  // Pull CSS-var geometry from the pageEl so any page-specific overrides
  // (e.g. .list-page.hero-list) flow through here too.
  const geom = listGeomFrom(pageEl);
  const offsets = new Array(cards.length);
  let y = 0;
  for (let i = 0; i < cards.length; i++) {
    offsets[i] = y;
    const hasMeta = listRowParts(cards[i]).meta !== "";
    y += hasMeta ? geom.rowHeightWithMeta : geom.rowHeightNoMeta;
  }
  offsetCache.set(pageEl, { offsets, geom });
}

function listTrackOffset(pageEl, focusedIdx) {
  const entry = offsetCache.get(pageEl);
  if (!entry) return 0;
  const { offsets, geom } = entry;
  if (focusedIdx < 0 || focusedIdx >= offsets.length) return 0;
  return -(offsets[focusedIdx] + geom.focusedTitleCentre);
}

function renderLoading(el, label) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "loading-state";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  wrap.appendChild(spinner);
  const lab = document.createElement("div");
  lab.className = "loading-label meta-label";
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

  // Re-render whichever surface is showing this deck. Multiple top pages
  // can share a deck (channel-1 and channel-2 both read "live") — render
  // every match that's inside the active neighbourhood.
  const entry = currentEntry();
  if (entry.level === "top" && topMode) {
    TOP_PAGES.forEach((p, i) => {
      if (p.deck !== deckId) return;
      if (Math.abs(i - entry.pageIndex) > RENDER_NEIGHBOR_RADIUS) return;
      renderTopPageContent(p, i === entry.pageIndex);
    });
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
// Enter-key state for the keyboard stub. keydownActive tracks whether
// Enter is currently down (used to ignore key repeat); holdTimer fires
// the back event at the 500ms threshold mid-press; keyBackFired records
// that emission so keyup knows to emit press_end (not a spurious click);
// keyTwisted records whether any arrow fired during the press so keyup
// can suppress the click.
let holdTimer = null;
let keydownActive = false;
let keyBackFired = false;
let keyTwisted = false;

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener("open", () => {
    // Tell the backend the UI is up — triggers the boot-time fade-up of
    // the backlight from the dark "still booting" state.
    send({ type: "ready" });
    // Pre-fetch the deck for every top page (deduped — channel-1 and
    // channel-2 share "live", and the backend would just hit the same
    // cache twice anyway).
    const decksToFetch = new Set();
    for (const page of TOP_PAGES) {
      if (page.deck) decksToFetch.add(page.deck);
    }
    for (const deckId of decksToFetch) {
      send({ type: "request_deck", deck_id: deckId, offset: 0 });
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
    else if (msg.type === "screen_dimmed") {
      // Backend fires this at the end of the first dim stage (before the
      // screen fully fades out). Doing the snap while the screen is still
      // partially lit means the UI is already at NP by the time the user
      // wakes it. Skip the snap if we're already at NP top-level.
      const onNpTop =
        stack.length === 1 &&
        TOP_PAGES[stack[0].pageIndex].kind === "now-playing";
      if (!onNpTop) goToTopLevel();
    }
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

// Watchdog: clear a stale pressHeld if no terminating event (click or
// press_end) arrives in this many ms. A driver hiccup that drops the
// release would otherwise leave every subsequent rotate stuck in the
// volume branch. 30s is well past any plausible user hold — long enough
// to never interrupt a legitimate twist session, short enough to
// recover automatically.
const PRESS_HELD_WATCHDOG_MS = 30000;
let pressHeldWatchdog = null;

function clearPressHeld() {
  pressHeld = false;
  pressHeldTwisted = false;
  if (pressHeldWatchdog !== null) {
    clearTimeout(pressHeldWatchdog);
    pressHeldWatchdog = null;
  }
}

function handleEncoder(event) {
  if (event.event === "rotate") {
    const direction = event.direction === "cw" ? "next" : "prev";
    if (pressHeld) {
      // While the button is held, rotation is the volume modifier —
      // available from tick one of the press; no 500ms warm-up.
      pressHeldTwisted = true;
      const delta = direction === "next" ? 1 : -1;
      adjustVolume(delta * VOLUME_STEP);
    } else {
      moveCursor(direction);
    }
  } else if (event.event === "press_start") {
    pressHeld = true;
    pressHeldTwisted = false;
    if (pressHeldWatchdog !== null) clearTimeout(pressHeldWatchdog);
    pressHeldWatchdog = setTimeout(clearPressHeld, PRESS_HELD_WATCHDOG_MS);
  } else if (event.event === "click") {
    // Short tap (released before threshold, no twist).
    clearPressHeld();
    click();
  } else if (event.event === "back") {
    // Fired mid-press, when the hold crossed 500ms without any twist.
    // The encoder is still physically held — keep pressHeld true so a
    // subsequent twist still adjusts volume from whatever page back
    // navigated to.
    backGesture();
  } else if (event.event === "press_end") {
    // Press window closed. Back or volume already happened mid-press
    // (or neither, if the user twisted then stopped before crossing the
    // threshold). Just release the flag.
    clearPressHeld();
  }
}

// ── Keyboard simulation ────────────────────────────────────────
// Mirrors the GPIO encoder protocol: Enter keydown emits press_start
// immediately (volume modifier engaged from tick one — no 500ms wait);
// holding past PRESS_HOLD_MS emits "back" mid-press if no twist has
// happened. Keyup picks click (no twist, no back fired), or press_end
// (otherwise — release just closes the window).
//
// Escape is a one-shot back shortcut for dev convenience.
document.addEventListener("keydown", (e) => {
  if (e.repeat && e.key === "Enter") return;
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    if (keydownActive) keyTwisted = true;
    send({ type: "encoder", event: "rotate", direction: "ccw", velocity: 1 });
    e.preventDefault();
  } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    if (keydownActive) keyTwisted = true;
    send({ type: "encoder", event: "rotate", direction: "cw", velocity: 1 });
    e.preventDefault();
  } else if (e.key === "Enter" && !keydownActive) {
    keydownActive = true;
    keyBackFired = false;
    keyTwisted = false;
    send({ type: "encoder", event: "press_start" });
    holdTimer = setTimeout(() => {
      if (!keyTwisted) {
        keyBackFired = true;
        send({ type: "encoder", event: "back" });
      }
    }, PRESS_HOLD_MS);
    e.preventDefault();
  } else if (e.key === "Escape") {
    send({ type: "encoder", event: "back" });
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
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (keyTwisted || keyBackFired) {
      // Press already resolved into volume or back mid-press; release
      // just closes the window.
      send({ type: "encoder", event: "press_end" });
    } else {
      // Short tap, no twist, hadn't crossed the threshold.
      send({ type: "encoder", event: "click" });
    }
    keydownActive = false;
    keyBackFired = false;
    keyTwisted = false;
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
