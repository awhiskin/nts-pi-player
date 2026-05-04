const LONG_PRESS_MS = 500;
const PAGE_PREFETCH_THRESHOLD = 5;
const VOLUME_STEP = 5;

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

const screenEl = document.getElementById("screen");
const chromeLabelEl = document.getElementById("chrome-label");
const chromeTimeEl = document.getElementById("chrome-time");
const chromeDotsEl = document.getElementById("chrome-dots");

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

  // Now-playing: in volume mode, encoder = volume. Direction is inverted
  // vs navigation — pushing "up" (ccw / ↑ / ←) raises volume, matching
  // typical volume sliders.
  if (page.kind === "now-playing" && nowPlayingMode === "volume") {
    adjustVolume(-delta * VOLUME_STEP);
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
    // Refresh now-playing page bg etc.
    renderTopActivePage();
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
      send({ type: "stop" });
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
      renderTopActivePage();
      return;
    }
    // On any other top-level page: jump to Now Playing and reset cursors.
    entry.pageIndex = 0;
    resetTopCursors(0);
    updateTopTransform();
    updateChrome();
    refreshAllTopPages();
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
  stack.length = 1;
  stack[0].pageIndex = 0;
  nowPlayingMode = "volume";
  resetTopCursors(0);
  render();
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

// Refresh focus highlight on all top pages, including off-screen ones, so a
// reset is reflected before the user slides into a page (no stale highlight).
function refreshAllTopPages() {
  if (!topMode) return;
  const activeId = TOP_PAGES[stack[0].pageIndex].id;
  for (const page of TOP_PAGES) {
    renderTopPageContent(page, page.id === activeId);
  }
}

function adjustVolume(delta) {
  const cur = nowPlaying.volume ?? 60;
  const next = Math.max(0, Math.min(100, cur + delta));
  if (next === cur) return;
  nowPlaying.volume = next; // optimistic; backend will echo back
  send({ type: "set_volume", value: next });
  updateNowPlayingMode();
}

function decodeEntities(encodedString) {
  const textArea = document.createElement('textarea');
  textArea.innerHTML = encodedString;
  return textArea.value;
}

function updateNowPlayingMode() {
  const modeEl = screenEl.querySelector(
    '.page[data-page-id="now-playing"] .np-mode'
  );
  if (!modeEl) return;
  modeEl.classList.toggle("scroll", nowPlayingMode === "scroll");
  if (nowPlayingMode === "volume") {
    const vol = `VOL ${nowPlaying.volume ?? 60}`;
    modeEl.textContent = nowPlaying.paused ? `PAUSED · ${vol}` : vol;
  } else {
    modeEl.textContent =
      nowPlaying.state === "idle"
        ? "SCROLL MODE — ROTATE TO NAVIGATE"
        : "SCROLL MODE — CLICK TO STOP, ROTATE TO NAVIGATE";
  }
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
function render() {
  const entry = currentEntry();
  if (entry.level === "top") {
    if (!topMode) {
      buildTopCarousel();
      topMode = true;
    }
    updateTopTransform();
    TOP_PAGES.forEach((p, i) => renderTopPageContent(p, i === entry.pageIndex));
  } else {
    topMode = false;
    renderDeckPage(entry);
  }
  updateChrome();
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
  updateChromeDots(topIndex);
}

function updateChromeDots(activeIndex) {
  if (!chromeDotsEl) return;
  if (chromeDotsEl.children.length !== TOP_PAGES.length) {
    chromeDotsEl.innerHTML = "";
    for (let i = 0; i < TOP_PAGES.length; i++) {
      const dot = document.createElement("span");
      dot.className = "dot";
      chromeDotsEl.appendChild(dot);
    }
  }
  for (let i = 0; i < chromeDotsEl.children.length; i++) {
    chromeDotsEl.children[i].classList.toggle("on", i === activeIndex);
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
      </div>
      <h1 class="np-show"></h1>
      <div class="np-with" hidden></div>
      <div class="np-sub" hidden></div>
      <div class="np-progress" hidden>
        <div class="np-progress-bar"><div class="np-progress-fill"></div></div>
        <div class="np-progress-times">
          <span class="np-time-elapsed"></span>
          <span class="np-time-duration"></span>
        </div>
      </div>
      <div class="np-mode"></div>
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

  // Eyebrow: the live pip is exclusive to live channels (1/2). It pulses
  // when actively playing, sits dim while paused/error, and is hidden for
  // mixtapes / episodes / idle. While loading, the pip is replaced by a
  // small inline spinner so the marker keeps its position next to the
  // status word. The eyebrow row hides when there's nothing meaningful to
  // say (e.g. a past episode is playing — title carries the info).
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
  eyebrow.hidden = !eyebrowStr;

  // Title — split on " w/ " so the "w/ Host Name" portion can render below
  // the main title at a smaller, italic, dimmed weight.
  const show = pageEl.querySelector(".np-show");
  const withEl = pageEl.querySelector(".np-with");
  let mainTitle, withPart;
  if (np.state === "idle") {
    mainTitle = "NOTHING PLAYING";
    withPart = "";
  } else if (np.state === "error") {
    mainTitle = (np.error_message || "ERROR").toUpperCase();
    withPart = "";
  } else {
    const split = splitTitleOnWith(np.title || "Loading…");
    mainTitle = decodeEntities(split.main.toUpperCase());
    withPart = decodeEntities(split.with.toUpperCase());
  }
  if (show.textContent !== mainTitle) show.textContent = mainTitle;
  withEl.hidden = !withPart;
  if (withPart && withEl.textContent !== withPart) withEl.textContent = withPart;

  // Subtitle.
  const sub = pageEl.querySelector(".np-sub");
  const subText =
    np.state !== "idle" && np.state !== "error" && np.subtitle
      ? np.subtitle.toUpperCase()
      : "";
  sub.hidden = !subText;
  if (subText && sub.textContent !== subText) sub.textContent = subText;

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

  // Mode indicator (volume / scroll).
  updateNowPlayingMode();
}

// NTS show titles often look like "Soup To Nuts w/ John Gómez" — split off
// the "w/ Host" tail so the main title can dominate and the host gets
// rendered below in a smaller, italic, dimmed style.
function splitTitleOnWith(raw) {
  if (!raw) return { main: "", with: "" };
  const m = raw.match(/^(.+?)\s+(w\/.*)$/i);
  if (!m) return { main: raw, with: "" };
  return { main: m[1].trim(), with: m[2].trim() };
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

  // Rebuild grid only when channel set changes.
  const sig = cards.map((c) => c.id).join("|");
  if (grid.dataset.liveSig !== sig) {
    grid.dataset.liveSig = sig;
    grid.innerHTML = "";
    cards.forEach((card, i) => {
      const cardEl = document.createElement("div");
      cardEl.className = "live-card";
      cardEl.dataset.i = String(i);

      const bg = document.createElement("div");
      bg.className = "bg-image";
      if (card.artwork) bg.style.backgroundImage = `url("${card.artwork}")`;
      cardEl.appendChild(bg);

      const overlay = document.createElement("div");
      overlay.className = "bg-overlay";
      cardEl.appendChild(overlay);

      const inner = document.createElement("div");
      inner.className = "live-card-inner";

      const ch = document.createElement("div");
      ch.className = "live-ch";
      const pip = document.createElement("span");
      pip.className = "live-pip";
      ch.appendChild(pip);
      const chLabel = document.createElement("span");
      chLabel.textContent = (card.label || "").toUpperCase();
      ch.appendChild(chLabel);
      inner.appendChild(ch);

      if (card.subtitle) {
        const show = document.createElement("div");
        show.className = "np-show";

        const showWith = document.createElement("div");
        showWith.className = "np-with";

        const split = splitTitleOnWith(decodeEntities(card.subtitle.toUpperCase()) || "Loading…");

        let mainTitle = decodeEntities(split.main.toUpperCase());
        let withPart = decodeEntities(split.with.toUpperCase());

        show.textContent = mainTitle;
        showWith.textContent = withPart;

        inner.appendChild(show);
        inner.appendChild(showWith);
      }

      cardEl.appendChild(inner);
      grid.appendChild(cardEl);
    });
  }

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

      const num = document.createElement("span");
      num.className = "list-num";
      num.textContent = String(i + 1).padStart(2, "0");
      row.appendChild(num);

      const name = document.createElement("span");
      name.className = "list-name";
      name.textContent = (card.label || "").toUpperCase();
      row.appendChild(name);

      if (card.subtitle) {
        const sub = document.createElement("span");
        sub.className = "list-sub-row";
        sub.textContent = card.subtitle.toUpperCase();
        row.appendChild(sub);
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

  // Re-render whichever surface is showing this deck
  const entry = currentEntry();
  if (entry.level === "top") {
    const page = TOP_PAGES.find((p) => p.deck === deckId);
    if (page && topMode) renderTopPageContent(page, page.id === TOP_PAGES[entry.pageIndex].id);
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
      // Refresh now-playing page if visible.
      const entry = currentEntry();
      if (entry.level === "top" && TOP_PAGES[entry.pageIndex].kind === "now-playing") {
        renderTopActivePage();
      } else if (entry.level === "top") {
        // NP card off-screen but still in DOM — keep it fresh too.
        renderNowPlayingPage(screenEl.querySelector('.page[data-page-id="now-playing"]'));
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
  chromeTimeEl.textContent = formatTimeOfDay(new Date());
}
tickClock();
setInterval(tickClock, 1000 * 30);

// ── Boot ───────────────────────────────────────────────────────
render();
connect();
