const LONG_PRESS_MS = 500;
const PAGE_PREFETCH_THRESHOLD = 5;

const cardEl = document.getElementById("card");
const decks = {};
const deckMeta = {};
const stack = [{ deck: "root", cursor: 0, cursorPlaced: false }];

function currentEntry() {
  return stack[stack.length - 1];
}

function currentCards() {
  return decks[currentEntry().deck];
}

function currentCard() {
  const cards = currentCards();
  return cards ? cards[currentEntry().cursor] : null;
}

function placeCursor(entry) {
  if (entry.cursorPlaced) return;
  const cards = decks[entry.deck];
  if (!cards || !cards.length) return;
  entry.cursor = cards[0]?.kind === "back" ? 1 : 0;
  entry.cursorPlaced = true;
}

function render() {
  const entry = currentEntry();
  placeCursor(entry);
  const cards = decks[entry.deck];

  if (!cards) {
    cardEl.dataset.kind = "loading";
    cardEl.style.backgroundImage = "";
    cardEl.innerHTML = '<h1 class="card-label">…</h1>';
    return;
  }

  const card = cards[entry.cursor];
  cardEl.dataset.kind = card.kind;
  cardEl.style.backgroundImage = card.artwork ? `url("${card.artwork}")` : "";
  cardEl.innerHTML = "";

  const label = document.createElement("h1");
  label.className = "card-label";
  label.textContent = card.label;
  cardEl.appendChild(label);

  let subtitle = card.subtitle;
  if (card.kind === "now-playing" && !subtitle) subtitle = "Nothing playing";
  if (subtitle) {
    const sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = subtitle;
    cardEl.appendChild(sub);
  }
}

function rotate(direction) {
  const cards = currentCards();
  if (!cards || !cards.length) return;
  const entry = currentEntry();
  const delta = direction === "cw" ? 1 : -1;
  entry.cursor = Math.max(0, Math.min(cards.length - 1, entry.cursor + delta));
  entry.cursorPlaced = true;
  maybePrefetchPage(entry);
  render();
}

function maybePrefetchPage(entry) {
  const meta = deckMeta[entry.deck];
  if (!meta || !meta.hasMore || meta.pending) return;
  const cards = decks[entry.deck];
  if (!cards) return;
  const trailingIdx = cards.length - 1; // Back to Top
  if (entry.cursor >= trailingIdx - PAGE_PREFETCH_THRESHOLD) {
    meta.pending = true;
    send({ type: "request_deck", deck_id: entry.deck, offset: meta.nextOffset });
  }
}

function click() {
  const card = currentCard();
  if (!card) return;
  switch (card.kind) {
    case "enter-deck":
      enterDeck(card.deck);
      break;
    case "back":
      goBack();
      break;
    case "back-to-top":
      jumpToFirstContent();
      break;
    case "play":
      send({ type: "play", card_id: card.id });
      goToRoot();
      break;
    case "unplayable":
      // No audio source — slice 6 will surface a "Not available" toast.
      break;
    case "now-playing":
      // slice 6 will toggle play/pause
      break;
  }
}

function enterDeck(deckId) {
  stack.push({ deck: deckId, cursor: 0, cursorPlaced: false });
  send({ type: "request_deck", deck_id: deckId, offset: 0 });
  render();
}

function goBack() {
  if (stack.length > 1) {
    stack.pop();
    render();
  }
}

function goToRoot() {
  stack.length = 1;
  stack[0].cursor = 0;
  stack[0].cursorPlaced = true;
  render();
}

function jumpToFirstContent() {
  const entry = currentEntry();
  const cards = decks[entry.deck];
  if (!cards || !cards.length) return;
  entry.cursor = cards[0]?.kind === "back" ? 1 : 0;
  entry.cursorPlaced = true;
  render();
}

function prefetchArtwork(cards) {
  for (const c of cards) {
    if (c.artwork) {
      const img = new Image();
      img.src = c.artwork;
    }
  }
}

function countContent(cards) {
  let n = 0;
  for (const c of cards) {
    if (c.kind !== "back" && c.kind !== "back-to-top") n++;
  }
  return n;
}

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
    // Stale page — current state isn't expecting this offset, ignore.
    if (!existing || !meta || meta.nextOffset !== offset) return;
    const trailingIdx = existing.length - 1; // Back to Top
    existing.splice(trailingIdx, 0, ...cards);
    meta.hasMore = !!msg.has_more;
    meta.nextOffset += cards.length;
    meta.pending = false;
  }
  prefetchArtwork(cards);
  if (currentEntry().deck === deckId) render();
}

function longPress() {
  const card = currentCard();
  if (card && card.kind === "now-playing") return;
  if (stack.length > 1) {
    goBack();
  } else {
    jumpToFirstContent();
  }
}

function handleEncoder(event) {
  if (event.event === "rotate") rotate(event.direction);
  else if (event.event === "click") click();
  else if (event.event === "long_press") longPress();
}

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
    send({ type: "request_deck", deck_id: "root", offset: 0 });
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
  });
  ws.addEventListener("close", () => setTimeout(connect, 500));
}

document.addEventListener("keydown", (e) => {
  if (e.repeat && e.key === "Enter") return;
  if (e.key === "ArrowLeft") {
    send({ type: "encoder", event: "rotate", direction: "ccw", velocity: 1 });
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    send({ type: "encoder", event: "rotate", direction: "cw", velocity: 1 });
    e.preventDefault();
  } else if (e.key === "Enter" && pressTimer === null) {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      send({ type: "encoder", event: "long_press" });
    }, LONG_PRESS_MS);
    e.preventDefault();
  }
});

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

render();
connect();
