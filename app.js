// CardKave — minimalist Pokémon companion

// ---- OAuth configuration ----
// Fill in real client IDs here to enable production sign-in with Google/Apple.
// While these are empty strings, the buttons fall back to the demo simulator.
//
// Google: register at https://console.cloud.google.com/apis/credentials
//   Create an OAuth 2.0 Client ID of type "Web application".
//   Add ALL origins the app runs on under "Authorized JavaScript origins":
//     - https://www.cardkave.com   (production)
//     - https://cardkave.com       (apex, redirected to www but include anyway)
//     - http://localhost:8765      (local dev with `npx http-server`)
//   No redirect URI needed for the token-client popup flow.
//
// Apple: register at https://developer.apple.com/account/resources/identifiers/list/serviceId
//   Create a Services ID, enable "Sign in with Apple", and add this
//   site's domain (cardkave.com) plus a return URL:
//     - Domain:     cardkave.com
//     - Return URL: https://www.cardkave.com/
//   Apple does NOT allow http://localhost; the popup flow only works on
//   the live HTTPS domain.
const OAUTH_CONFIG = {
  google: {
    clientId: "", // e.g. "1234567890-abcdef.apps.googleusercontent.com"
  },
  apple: {
    clientId: "",     // e.g. "com.example.cardkave.signin" (Service ID)
    redirectURI: "",  // e.g. "https://shivanka3.github.io/cardkave/"
  },
};

// ---- EmailJS configuration ----
// Real verification emails (email change, password reset) are sent via EmailJS
// directly from the browser — no backend required.
//
// Set up:
//   1. Sign up at https://www.emailjs.com (free tier: 200 emails/month)
//   2. Add an Email Service (Gmail, Outlook, custom SMTP, etc.) and copy its Service ID
//   3. Create an Email Template with three variables: {{to_email}}, {{code}}, {{purpose}}
//      Suggested template:
//        Subject: Your CardKave {{purpose}} code
//        Body:    Your CardKave {{purpose}} code is {{code}}.
//                 It expires in 15 minutes. If you didn't request this, ignore this email.
//      Set "To Email" in the template settings to: {{to_email}}
//   4. Copy your Public Key from Account → API Keys
//   5. Paste all three values below.
//
// Until configured, the verify-code modal shows a clear error instead of sending.
const EMAIL_CONFIG = {
  publicKey: "",  // e.g. "AbCdEfGhIjKlMnOpQ"
  serviceId: "", // e.g. "service_xxxxxxx"
  templateId: "", // e.g. "template_xxxxxxx"
};

// Sync the auth-mode body class immediately so the topbar doesn't flash on
// auth pages before route() runs.
(function preroute() {
  const hash = location.hash || "";
  const hasSession = !!localStorage.getItem("cardkave-session");
  const onAuth = hash === "" || hash.startsWith("#/login") || hash.startsWith("#/signup");
  if (onAuth && !hasSession) {
    document.documentElement.classList.add("auth-mode");
    if (document.body) document.body.classList.add("auth-mode");
    else document.addEventListener("DOMContentLoaded", () => document.body.classList.add("auth-mode"), { once: true });
  }
})();

const API = "https://pokeapi.co/api/v2";
const DATA = "data"; // relative to index.html — works locally + on GitHub Pages
const SPRITE = id => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
const PAGE = 60;
const TOTAL = 1025;

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } },
  set(key, v) { localStorage.setItem(key, JSON.stringify(v)); refreshCounts(); },
  toggle(key, id) {
    const list = store.get(key);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
    store.set(key, list);
    return i < 0;
  },
  has(key, id) { return store.get(key).includes(id); },
};

function snapshotCard(c) {
  return {
    id: c.id,
    name: c.name,
    images: { small: c.images?.small || "", large: c.images?.large || c.images?.small || "" },
    set: { name: c.set?.name || "", releaseDate: c.set?.releaseDate || "", printedTotal: c.set?.printedTotal || "" },
    rarity: c.rarity || "",
    artist: c.artist || "",
    hp: c.hp || "",
    number: c.number || "",
  };
}
function makeCardStore(key) {
  return {
    key,
    list() {
      try {
        const arr = JSON.parse(localStorage.getItem(key)) || [];
        return arr.map(c => (c && c.quantity ? c : { ...c, quantity: 1 }));
      } catch { return []; }
    },
    has(id) { return this.quantity(id) > 0; },
    quantity(id) {
      const c = this.list().find(c => c.id === id);
      return c ? c.quantity : 0;
    },
    totalCount() {
      return this.list().reduce((sum, c) => sum + (c.quantity || 0), 0);
    },
    add(card) {
      const list = this.list();
      const i = list.findIndex(c => c.id === card.id);
      if (i >= 0) {
        list[i] = { ...list[i], quantity: list[i].quantity + 1 };
      } else {
        list.unshift({ ...snapshotCard(card), quantity: 1 });
      }
      localStorage.setItem(key, JSON.stringify(list));
      refreshCounts();
      return list[i >= 0 ? i : 0].quantity;
    },
    remove(cardOrId) {
      const id = typeof cardOrId === "string" ? cardOrId : cardOrId.id;
      const list = this.list();
      const i = list.findIndex(c => c.id === id);
      if (i < 0) return 0;
      const newQty = list[i].quantity - 1;
      if (newQty <= 0) list.splice(i, 1);
      else list[i] = { ...list[i], quantity: newQty };
      localStorage.setItem(key, JSON.stringify(list));
      refreshCounts();
      return Math.max(0, newQty);
    },
  };
}
const wishlistCards = makeCardStore("wishlist-cards");
const collectionCards = makeCardStore("collection-cards");

const view = document.getElementById("view");
const tpl = id => document.getElementById(id).content.cloneNode(true);

function refreshCounts() {
  document.getElementById("count-collection").textContent = collectionCards.totalCount();
  document.getElementById("count-wishlist").textContent = wishlistCards.totalCount();
  const me = (() => { try { return JSON.parse(localStorage.getItem("user-profile")); } catch { return null; } })();
  const tradesEl = document.getElementById("count-trades");
  if (tradesEl) {
    let count = 0;
    if (me) {
      try {
        const trades = JSON.parse(localStorage.getItem("trades")) || [];
        count = trades.filter(t => (t.fromUserName === me.name || t.toUserName === me.name) && t.status === "proposed").length;
      } catch {}
    }
    tradesEl.textContent = count;
  }
  const decksEl = document.getElementById("count-decks");
  if (decksEl) {
    let count = 0;
    if (me) {
      try {
        const decks = JSON.parse(localStorage.getItem("decks")) || [];
        count = decks.filter(d => d.ownerName === me.name).length;
      } catch {}
    }
    decksEl.textContent = count;
  }
}

function setActiveNav(route) {
  document.querySelectorAll(".nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.route === route);
  });
}

function idFromUrl(url) {
  const m = url.match(/\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

// Progressively append items to `container` as the user scrolls. Renders an
// initial batch synchronously, then watches a sentinel element with
// IntersectionObserver (with a scroll listener as fallback) and appends another
// batch each time it nears the viewport.
//
// Returns a function that cleans up listeners. When `opts.extendable` is true,
// the renderer keeps the observer alive after exhausting the initial list so
// the caller can `.extend(moreItems)` later (used when paginated data arrives
// after we've already rendered page 1). Caller must call `.finish()` once no
// more items are coming.
function lazyRender(items, container, makeEl, opts = {}) {
  const batchSize = opts.batchSize || 30;
  const margin = opts.rootMargin || 600;
  let extendable = !!opts.extendable;
  const sentinel = document.createElement("div");
  sentinel.className = "lazy-sentinel";
  sentinel.setAttribute("aria-hidden", "true");
  container.parentNode.insertBefore(sentinel, container.nextSibling);

  const list = items.slice();
  let cursor = 0;
  let observer = null;
  let scrollHandler = null;
  let done = false;
  let exhaustedSignaled = false;

  function cleanup() {
    if (done) return;
    done = true;
    if (observer) { observer.disconnect(); observer = null; }
    if (scrollHandler) {
      window.removeEventListener("scroll", scrollHandler, { passive: true });
      window.removeEventListener("resize", scrollHandler);
      scrollHandler = null;
    }
    if (sentinel.parentNode) sentinel.remove();
  }

  function renderBatch() {
    if (done) return;
    const end = Math.min(cursor + batchSize, list.length);
    if (end === cursor) return;
    const frag = document.createDocumentFragment();
    for (let i = cursor; i < end; i++) frag.appendChild(makeEl(list[i]));
    container.appendChild(frag);
    cursor = end;
    if (cursor >= list.length) {
      if (!extendable) cleanup();
      else exhaustedSignaled = true;
      return;
    }
    // After rendering, check whether the sentinel is still near the viewport;
    // if so, render another batch right away (the user has already scrolled past).
    queueMicrotask(checkVisible);
  }

  function checkVisible() {
    if (done) return;
    if (cursor >= list.length) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top - margin <= window.innerHeight && rect.bottom + margin >= 0) {
      renderBatch();
    }
  }

  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) renderBatch();
    }, { rootMargin: `${margin}px 0px` });
    observer.observe(sentinel);
  }
  scrollHandler = () => checkVisible();
  window.addEventListener("scroll", scrollHandler, { passive: true });
  window.addEventListener("resize", scrollHandler);

  renderBatch();

  const handle = () => cleanup();
  handle.extend = (more) => {
    if (done || !more || !more.length) return;
    list.push(...more);
    exhaustedSignaled = false;
    queueMicrotask(checkVisible);
  };
  handle.finish = () => {
    // No more items coming. Switch off extendable so the next renderBatch
    // that empties the list will auto-cleanup. If already exhausted, do it now.
    extendable = false;
    if (cursor >= list.length) cleanup();
  };
  return handle;
}

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// Local-data layer. The dump script (dump.mjs) writes static JSON under
// ./data; the SPA never reloads index.html, so a single in-memory promise
// per resource is all the cache we need. The browser HTTP cache handles
// cross-session persistence.
let _setsPromise = null;
let _setsByIdPromise = null;
const _cardsBySetIdPromise = new Map();
let _cardsIndexPromise = null;

function getSets() {
  if (!_setsPromise) _setsPromise = fetchJSON(`${DATA}/sets.json`);
  return _setsPromise;
}

function getSetsById() {
  if (!_setsByIdPromise) {
    _setsByIdPromise = getSets().then(arr => {
      const map = Object.create(null);
      for (const s of arr) map[s.id] = s;
      return map;
    });
  }
  return _setsByIdPromise;
}

function getCardsForSet(setId) {
  if (!_cardsBySetIdPromise.has(setId)) {
    _cardsBySetIdPromise.set(setId, fetchJSON(`${DATA}/cards/${setId}.json`));
  }
  return _cardsBySetIdPromise.get(setId);
}

function getCardsIndex() {
  if (!_cardsIndexPromise) _cardsIndexPromise = fetchJSON(`${DATA}/cards-index.json`);
  return _cardsIndexPromise;
}

// Inflate a slim search-index entry { i,n,s,num,rar,art,hp,sm,lg } into the
// snapshotCard shape that makeTcgCardEl/openCardModal expect. Set details
// are joined from the in-memory sets map.
function indexEntryToCard(e, setsById) {
  const set = setsById[e.s] || {};
  return {
    id: e.i,
    name: e.n,
    images: { small: e.sm || "", large: e.lg || e.sm || "" },
    set: {
      id: set.id || e.s,
      name: set.name || "",
      releaseDate: set.releaseDate || "",
      printedTotal: set.printedTotal || "",
    },
    rarity: e.rar || "",
    artist: e.art || "",
    hp: e.hp || "",
    number: e.num || "",
  };
}

function makeCard(p) {
  const el = document.createElement("a");
  el.className = "card";
  el.href = `#/p/${p.id}`;
  el.innerHTML = `
    <img loading="lazy" src="${SPRITE(p.id)}" alt="${p.name}" onerror="this.src='https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${p.id}.png'" />
    <div class="num">#${String(p.id).padStart(4, "0")}</div>
    <div class="name">${p.name.replace(/-/g, " ")}</div>
  `;
  return el;
}

// ---- Browse (sets)
function makeSetCard(s) {
  const el = document.createElement("a");
  el.className = "set-card";
  el.href = `#/sets/${s.id}`;
  const total = s.total || s.printedTotal || "";
  const date = s.releaseDate || "";
  const meta = [s.series, date].filter(Boolean).join(" · ");
  const cardCount = total ? `${total} cards` : "";
  el.innerHTML = `
    <div class="set-card-logo">
      ${s.images?.logo
        ? `<img loading="lazy" src="${s.images.logo}" alt="${s.name}" />`
        : `<span class="set-card-fallback">${s.name}</span>`}
    </div>
    <div class="set-card-info">
      <div class="set-card-name">${s.name}</div>
      <div class="muted mono">${meta}</div>
      ${cardCount ? `<div class="muted mono">${cardCount}</div>` : ""}
    </div>
  `;
  return el;
}

// ---- Recently searched queries
// Stores the actual search terms the user typed and submitted, like Google's
// search history. Clicking one re-runs that search; we don't track cards
// they opened from results.
const recentQueries = {
  KEY: "recently-searched-queries",
  MAX: 5,
  list() {
    try {
      const arr = JSON.parse(localStorage.getItem(this.KEY)) || [];
      // Tolerate the old shape (array of card snapshots) — just drop those.
      return arr.filter(q => typeof q === "string").slice(0, this.MAX);
    } catch { return []; }
  },
  add(query) {
    const q = String(query || "").trim();
    if (!q) return;
    const lower = q.toLowerCase();
    const list = this.list().filter(existing => existing.toLowerCase() !== lower);
    list.unshift(q);
    if (list.length > this.MAX) list.length = this.MAX;
    try { localStorage.setItem(this.KEY, JSON.stringify(list)); } catch {}
  },
  remove(query) {
    const list = this.list().filter(existing => existing !== query);
    try { localStorage.setItem(this.KEY, JSON.stringify(list)); } catch {}
  },
  clear() {
    try { localStorage.removeItem(this.KEY); } catch {}
  },
};

// Filter the in-memory search index by name. Single-token queries match as a
// case-insensitive prefix on any word ("char" → Charizard, Charcadet); multi-
// token queries fall back to a substring match so phrases like "mr mime" hit.
// Results are sorted newest-set-first to mirror the API's old orderBy.
function searchCardsByName(query, index, setsById) {
  const cleaned = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (cleaned.length < 2) return [];
  const tokens = cleaned.split(" ");

  let matches;
  if (tokens.length === 1) {
    const t = tokens[0];
    matches = index.filter(e => {
      const n = e.n.toLowerCase();
      if (n.startsWith(t)) return true;
      return n.split(/\s+/).some(w => w.startsWith(t));
    });
  } else {
    matches = index.filter(e => e.n.toLowerCase().includes(cleaned));
  }

  matches.sort((a, b) => {
    const da = setsById[a.s]?.releaseDate || "";
    const db = setsById[b.s]?.releaseDate || "";
    return db.localeCompare(da);
  });
  return matches;
}

async function renderBrowse() {
  setActiveNav("browse");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-browse"));

  const setsPanel = document.getElementById("browse-sets-panel");
  const cardsPanel = document.getElementById("browse-cards-panel");
  const tabs = document.querySelectorAll("#browse-tabs .tab");

  let cleanupSets = null;
  let cleanupCards = null;

  initSetsPanel();
  initCardsPanel();

  tabs.forEach(b => b.addEventListener("click", () => {
    const tab = b.dataset.tab;
    tabs.forEach(x => x.classList.toggle("active", x === b));
    setsPanel.classList.toggle("hidden", tab !== "sets");
    cardsPanel.classList.toggle("hidden", tab !== "cards");
  }));

  function initSetsPanel() {
    const grid = document.getElementById("grid");
    const loader = document.getElementById("loader");
    const search = document.getElementById("search");

    let allSets = [];
    let cleanupLazy = null;

    function render(filter = "") {
      if (cleanupLazy) { cleanupLazy(); cleanupLazy = null; }
      grid.innerHTML = "";
      const q = filter.trim().toLowerCase();
      const filtered = q
        ? allSets.filter(s =>
            (s.name || "").toLowerCase().includes(q) ||
            (s.series || "").toLowerCase().includes(q))
        : allSets;
      if (!filtered.length) {
        loader.classList.remove("hidden");
        loader.textContent = allSets.length ? "No sets match." : "No sets to show.";
        return;
      }
      loader.classList.add("hidden");
      cleanupLazy = lazyRender(filtered, grid, makeSetCard, { batchSize: 24 });
    }

    loader.classList.remove("hidden");
    loader.textContent = "Loading sets…";
    getSets()
      .then(data => {
        allSets = data;
        render();
      })
      .catch(() => {
        loader.textContent = "Couldn't load sets. Check your connection and try again.";
      });

    // Search only runs on Enter — auto-search-as-you-type feels noisy when
    // there are this many sets. Clearing the input restores the default view
    // immediately (empty isn't really a "search").
    search.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        render(search.value);
      }
    });
    search.addEventListener("input", () => {
      if (search.value === "") render("");
    });

    cleanupSets = () => {
      if (cleanupLazy) { cleanupLazy(); cleanupLazy = null; }
    };
  }

  function initCardsPanel() {
    const wrap = cardsPanel.querySelector(".card-search-wrap");
    const search = document.getElementById("card-search");
    const status = document.getElementById("card-search-status");
    const grid = document.getElementById("card-search-grid");
    const dropdown = document.getElementById("recent-dropdown");
    const recentList = document.getElementById("recent-list");
    const clearBtn = document.getElementById("clear-recent");

    let searchToken = 0;

    const onCardOpen = (c) => openCardModal(c);

    function makeRecentItem(query) {
      const row = document.createElement("div");
      row.className = "recent-item-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-item";
      btn.setAttribute("aria-label", `Search ${query}`);

      const icon = document.createElement("span");
      icon.className = "recent-item-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

      const text = document.createElement("span");
      text.className = "recent-item-text";
      const nameEl = document.createElement("span");
      nameEl.className = "recent-item-name";
      nameEl.textContent = query;
      text.appendChild(nameEl);

      btn.appendChild(icon);
      btn.appendChild(text);

      // mousedown would blur the input before click fires; suppress it.
      btn.addEventListener("mousedown", e => e.preventDefault());
      btn.addEventListener("click", () => {
        closeDropdown();
        search.value = query;
        performSearch(query);
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "recent-item-remove";
      remove.setAttribute("aria-label", `Remove ${query} from recent searches`);
      remove.textContent = "×";
      remove.addEventListener("mousedown", e => e.preventDefault());
      remove.addEventListener("click", e => {
        e.stopPropagation();
        recentQueries.remove(query);
        paintRecent();
      });

      row.appendChild(btn);
      row.appendChild(remove);
      return row;
    }

    function paintRecent() {
      const recents = recentQueries.list();
      recentList.innerHTML = "";
      if (!recents.length) {
        dropdown.classList.add("hidden");
        return;
      }
      const frag = document.createDocumentFragment();
      recents.forEach(q => frag.appendChild(makeRecentItem(q)));
      recentList.appendChild(frag);
    }

    function openDropdown() {
      paintRecent();
      if (!recentQueries.list().length) return;
      dropdown.classList.remove("hidden");
    }
    function closeDropdown() {
      dropdown.classList.add("hidden");
    }

    search.addEventListener("focus", () => {
      if (!search.value.trim()) openDropdown();
    });
    search.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        closeDropdown();
        performSearch(search.value);
      } else if (e.key === "Escape") {
        closeDropdown();
        search.blur();
      }
    });

    const onDocMouseDown = (e) => {
      if (!wrap.contains(e.target)) closeDropdown();
    };
    document.addEventListener("mousedown", onDocMouseDown);

    clearBtn.addEventListener("mousedown", e => e.preventDefault());
    clearBtn.addEventListener("click", () => {
      recentQueries.clear();
      paintRecent();
      closeDropdown();
    });

    // Kick off the index + sets-by-id fetches up-front — by the time the user
    // finishes typing, the data is usually already in memory.
    const indexReady = Promise.all([getCardsIndex(), getSetsById()]);

    let cleanupLazy = null;

    async function performSearch(q) {
      const myToken = ++searchToken;
      if (cleanupLazy) { cleanupLazy(); cleanupLazy = null; }
      grid.innerHTML = "";

      const trimmed = q.trim();
      if (!trimmed) {
        setStatus("Type a card name above to search across every set.", true);
        return;
      }
      if (trimmed.length < 2) {
        setStatus("Keep typing…", true);
        return;
      }

      // Persist the query the user actually submitted (regardless of result
      // count) so it shows up in the recents dropdown next time.
      recentQueries.add(trimmed);

      setStatus("Searching…", true);

      let index, setsById;
      try {
        [index, setsById] = await indexReady;
      } catch {
        if (myToken !== searchToken) return;
        setStatus("Couldn't load the card index. Refresh to retry.", true);
        return;
      }
      if (myToken !== searchToken) return;

      const matches = searchCardsByName(trimmed, index, setsById);
      if (!matches.length) {
        setStatus(`No cards found for "${trimmed}".`, true);
        return;
      }

      const cards = matches.map(e => indexEntryToCard(e, setsById));
      cleanupLazy = lazyRender(
        cards,
        grid,
        c => makeTcgCardEl(c, { onOpen: onCardOpen }),
        { batchSize: 30 }
      );
      setStatus(`${cards.length} card${cards.length === 1 ? "" : "s"}`, false);
    }

    function setStatus(text, visible) {
      status.textContent = text;
      status.classList.toggle("hidden", !visible);
    }

    // Search runs on Enter only (handled in the keydown listener above).
    // Typing manages dropdown visibility; emptying the input resets the
    // results to the prompt state immediately.
    search.addEventListener("input", () => {
      if (search.value.trim()) {
        closeDropdown();
      } else {
        if (document.activeElement === search) openDropdown();
        performSearch("");
      }
    });

    cleanupCards = () => {
      searchToken++;
      if (cleanupLazy) { cleanupLazy(); cleanupLazy = null; }
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }

  window.__cleanup = () => {
    if (cleanupSets) { cleanupSets(); cleanupSets = null; }
    if (cleanupCards) { cleanupCards(); cleanupCards = null; }
  };
}

// ---- Set detail
function sortSetCards(cards) {
  // Don't pass orderBy=number to the TCG API — it has a pagination bug
  // that drops ~45 SR/full-art/gold cards. We sort client-side instead.
  return cards.slice().sort((a, b) => {
    const na = parseInt(a.number, 10);
    const nb = parseInt(b.number, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return (a.number || "").localeCompare(b.number || "", undefined, { numeric: true });
  });
}

async function renderSet(setId) {
  setActiveNav("browse");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-set"));

  const titleEl = document.getElementById("set-name");
  const metaEl = document.getElementById("set-meta");
  const logoEl = document.getElementById("set-logo");
  const grid = document.getElementById("set-cards");
  const status = document.getElementById("set-status");

  // Show a loading placeholder right away so the header isn't blank.
  titleEl.textContent = "Loading set…";

  function paintHeader(setData) {
    titleEl.textContent = setData.name || setId;
    metaEl.textContent = [setData.series, setData.releaseDate].filter(Boolean).join(" · ");
    if (setData.images?.logo) {
      logoEl.innerHTML = `<img src="${setData.images.logo}" alt="${setData.name || ""}" />`;
    } else if (setData.images?.symbol) {
      logoEl.innerHTML = `<img src="${setData.images.symbol}" alt="${setData.name || ""}" />`;
    }
  }

  function setMeta(setData, count) {
    metaEl.textContent =
      [setData.series, setData.releaseDate].filter(Boolean).join(" · ") +
      ` · ${count} card${count === 1 ? "" : "s"}`;
  }

  // Kick off both requests in parallel — header paints as soon as the sets
  // index lands; cards appear when their per-set file arrives.
  const setPromise = getSetsById().then(map => map[setId] || null);
  const cardsPromise = getCardsForSet(setId);

  let setData = null;
  setPromise.then(s => {
    if (s) { setData = s; paintHeader(s); }
  });

  let cards;
  try {
    cards = await cardsPromise;
  } catch {
    status.textContent = "Couldn't load cards. Check your connection and try again.";
    return;
  }

  // Make sure header data has settled before rendering meta line.
  await setPromise;
  if (!setData) {
    setData = { id: setId, name: setId, series: "", releaseDate: "" };
    paintHeader(setData);
  }

  if (!cards.length) {
    status.textContent = "No cards found in this set.";
    status.classList.remove("hidden");
    return;
  }

  setMeta(setData, cards.length);
  status.classList.add("hidden");
  grid.innerHTML = "";
  const cleanup = lazyRender(sortSetCards(cards), grid, makeTcgCardEl, { batchSize: 30 });
  window.__cleanup = () => cleanup && cleanup();
}

// ---- Detail
async function renderDetail(id) {
  setActiveNav(null);
  view.innerHTML = "";
  view.appendChild(tpl("tpl-detail"));

  let p;
  try { p = await fetchJSON(`${API}/pokemon/${id}`); }
  catch { view.innerHTML = "<p class='muted'>Couldn’t load that one.</p>"; return; }

  document.getElementById("art").src = SPRITE(p.id);
  document.getElementById("art").alt = p.name;
  document.getElementById("num").textContent = `#${String(p.id).padStart(4, "0")}`;
  document.getElementById("name").textContent = p.name.replace(/-/g, " ");

  const types = document.getElementById("types");
  p.types.forEach(t => {
    const s = document.createElement("span");
    s.className = "type";
    s.textContent = t.type.name;
    types.appendChild(s);
  });

  document.getElementById("height").textContent = `${(p.height / 10).toFixed(1)} m`;
  document.getElementById("weight").textContent = `${(p.weight / 10).toFixed(1)} kg`;
  document.getElementById("abilities").textContent =
    p.abilities.map(a => a.ability.name.replace(/-/g, " ")).join(", ");

  const stats = document.getElementById("stats");
  const max = 200;
  p.stats.forEach(s => {
    const li = document.createElement("li");
    const pct = Math.min(100, (s.base_stat / max) * 100);
    li.innerHTML = `
      <span class="label">${s.stat.name.replace(/-/g, " ")}</span>
      <span class="bar"><span style="width:${pct}%"></span></span>
      <span class="val">${s.base_stat}</span>
    `;
    stats.appendChild(li);
  });

  loadCards(p);
}

// Build a TCG card tile. Clicking the image opens the modal where the user
// picks collection/wishlist and adjusts quantity. Optional `listSource` shows
// a quantity badge from that store on the tile (used on saved-list pages).
function makeTcgCardEl(c, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "tcg-card";
  wrap.dataset.cardId = c.id;
  if (opts.listSource) wrap.dataset.listSource = opts.listSource;

  const imgBtn = document.createElement("button");
  imgBtn.className = "tcg-img";
  imgBtn.type = "button";
  imgBtn.setAttribute("aria-label", `${c.name} — ${c.set?.name || ""}`);
  imgBtn.innerHTML = `<img loading="lazy" decoding="async" src="${c.images?.small || ""}" alt="${c.name}" />`;
  imgBtn.addEventListener("click", () => {
    if (typeof opts.onOpen === "function") opts.onOpen(c);
    else openCardModal(c);
  });
  wrap.appendChild(imgBtn);

  if (opts.listSource) {
    const store = opts.listSource === "collection" ? collectionCards : wishlistCards;
    const qty = store.quantity(c.id);
    const badge = document.createElement("span");
    badge.className = "tcg-qty-badge";
    badge.textContent = `×${qty}`;
    if (qty <= 1) badge.classList.add("hidden");
    wrap.appendChild(badge);
  }

  return wrap;
}

function syncCardTiles(cardId) {
  document.querySelectorAll(`.tcg-card[data-card-id="${cardId}"][data-list-source]`).forEach(tile => {
    const source = tile.dataset.listSource;
    const store = source === "collection" ? collectionCards : wishlistCards;
    const qty = store.quantity(cardId);
    if (qty <= 0) {
      tile.remove();
      return;
    }
    let badge = tile.querySelector(".tcg-qty-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "tcg-qty-badge";
      tile.appendChild(badge);
    }
    badge.textContent = `×${qty}`;
    badge.classList.toggle("hidden", qty <= 1);
  });

  const grid = document.getElementById("list-grid");
  const empty = document.getElementById("list-empty");
  if (grid && empty && !grid.children.length) empty.classList.remove("hidden");

  syncModalQty(cardId);
}

function syncModalQty(cardId) {
  const collQtyEl = document.getElementById("modal-collect-qty");
  if (!collQtyEl || collQtyEl.dataset.cardId !== cardId) return;
  const collQty = collectionCards.quantity(cardId);
  const wishQty = wishlistCards.quantity(cardId);
  collQtyEl.textContent = collQty;
  document.getElementById("modal-wish-qty").textContent = wishQty;
  document.getElementById("modal-collect-minus").disabled = collQty <= 0;
  document.getElementById("modal-wish-minus").disabled = wishQty <= 0;
  document.getElementById("modal-collect-ctrl").classList.toggle("has-items", collQty > 0);
  document.getElementById("modal-wish-ctrl").classList.toggle("has-items", wishQty > 0);
}

// ---- TCG cards
async function getSpeciesName(p) {
  try {
    const s = await fetchJSON(p.species.url);
    const en = s.names.find(n => n.language.name === "en");
    return en?.name || p.name;
  } catch {
    return p.name.replace(/-/g, " ");
  }
}

// Find every TCG card whose name matches a Pokémon's species name. Looks at
// the local index in two passes: an exact (case-insensitive) match first,
// then a fall-back to the longest distinctive token so "Mr. Mime" → Mr. Mime
// cards and "Farfetch'd" still hits.
function findCardsForName(displayName, index, setsById) {
  const cleaned = displayName.replace(/\s+/g, " ").trim().toLowerCase();
  if (!cleaned) return [];

  const exact = index.filter(e => e.n.toLowerCase() === cleaned);
  if (exact.length) return enrichAndSort(exact, setsById);

  const tokens = cleaned.split(" ");
  const distinctive = tokens.slice().sort((a, b) => b.length - a.length)[0];
  if (distinctive && distinctive.length >= 3) {
    const t = distinctive;
    const tokenMatches = index.filter(e =>
      e.n.toLowerCase().split(/\s+/).some(w => w === t || w.startsWith(t))
    );
    if (tokenMatches.length) return enrichAndSort(tokenMatches, setsById);
  }
  return [];
}

function enrichAndSort(entries, setsById) {
  return entries
    .map(e => indexEntryToCard(e, setsById))
    .sort((a, b) => (b.set?.releaseDate || "").localeCompare(a.set?.releaseDate || ""));
}

async function loadCards(pokemon) {
  const status = document.getElementById("cards-status");
  const grid = document.getElementById("cards-grid");
  const meta = document.getElementById("cards-meta");
  if (!status || !grid) return;

  const speciesName = await getSpeciesName(pokemon);
  let cards;
  try {
    const [index, setsById] = await Promise.all([getCardsIndex(), getSetsById()]);
    cards = findCardsForName(speciesName, index, setsById);
  } catch {
    status.textContent = "Couldn't load the card index. Try again later.";
    return;
  }

  if (!cards.length) {
    status.textContent = `No TCG cards found for ${speciesName}.`;
    return;
  }

  status.classList.add("hidden");
  meta.textContent = `${cards.length} card${cards.length === 1 ? "" : "s"}`;

  const frag = document.createDocumentFragment();
  cards.forEach(c => frag.appendChild(makeTcgCardEl(c)));
  grid.appendChild(frag);
}

// ---- Modal
function openCardModal(c) {
  const modal = document.getElementById("modal");
  document.getElementById("modal-img").src = c.images?.large || c.images?.small || "";
  document.getElementById("modal-img").alt = c.name;
  document.getElementById("modal-name").textContent = c.name;
  document.getElementById("modal-set").textContent = c.set?.name || "—";
  document.getElementById("modal-date").textContent = c.set?.releaseDate || "—";
  document.getElementById("modal-rarity").textContent = c.rarity || "—";
  document.getElementById("modal-num").textContent =
    c.number ? `${c.number}${c.set?.printedTotal ? `/${c.set.printedTotal}` : ""}` : "—";
  document.getElementById("modal-artist").textContent = c.artist || "—";
  document.getElementById("modal-hp").textContent = c.hp || "—";

  const collQty = document.getElementById("modal-collect-qty");
  const wishQty = document.getElementById("modal-wish-qty");
  collQty.dataset.cardId = c.id;
  wishQty.dataset.cardId = c.id;

  document.getElementById("modal-collect-plus").onclick = () => {
    collectionCards.add(c);
    syncCardTiles(c.id);
  };
  document.getElementById("modal-collect-minus").onclick = () => {
    collectionCards.remove(c);
    syncCardTiles(c.id);
  };
  document.getElementById("modal-wish-plus").onclick = () => {
    wishlistCards.add(c);
    syncCardTiles(c.id);
  };
  document.getElementById("modal-wish-minus").onclick = () => {
    wishlistCards.remove(c);
    syncCardTiles(c.id);
  };
  syncModalQty(c.id);

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeCardModal() {
  document.getElementById("modal").classList.add("hidden");
  document.body.style.overflow = "";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("modal-close").addEventListener("click", closeCardModal);
  document.getElementById("modal").addEventListener("click", e => {
    if (e.target.id === "modal") closeCardModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeCardModal();
  });
});

// ---- Saved lists
function renderCardList(store, route, title, emptyMsg, listSource) {
  setActiveNav(route);
  view.innerHTML = "";
  view.appendChild(tpl("tpl-list"));
  document.getElementById("list-title").textContent = title;

  const cards = store.list();
  const empty = document.getElementById("list-empty");
  const grid = document.getElementById("list-grid");

  if (!cards.length) {
    empty.textContent = emptyMsg;
    empty.classList.remove("hidden");
    return;
  }
  empty.textContent = emptyMsg;
  empty.classList.add("hidden");

  grid.classList.remove("grid");
  grid.classList.add("tcg-grid");

  cards.forEach(c => grid.appendChild(makeTcgCardEl(c, { listSource })));
}

const renderCollection = () => renderCardList(
  collectionCards, "collection", "Collection",
  "No cards yet. Open a card and add it to your collection.",
  "collection"
);
const renderCardWishlist = () => renderCardList(
  wishlistCards, "wishlist", "Wishlist",
  "No cards yet. Open a card and add it to your wishlist.",
  "wishlist"
);

// ---- Feed: profile, posts, groups
const profileStore = {
  get() { try { return JSON.parse(localStorage.getItem("user-profile")); } catch { return null; } },
  set(p) { localStorage.setItem("user-profile", JSON.stringify(p)); refreshProfileNav(); },
};

// ---- Auth: accounts, sessions, password hashing
async function hashPassword(password) {
  const salt = "cardkave-v1";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const authStore = {
  ACCOUNTS_KEY: "cardkave-accounts",
  SESSION_KEY: "cardkave-session",

  accounts() {
    try { return JSON.parse(localStorage.getItem(this.ACCOUNTS_KEY)) || []; }
    catch { return []; }
  },
  saveAccounts(arr) { localStorage.setItem(this.ACCOUNTS_KEY, JSON.stringify(arr)); },

  findByEmail(email) {
    const e = String(email).trim().toLowerCase();
    return this.accounts().find(a => a.email === e);
  },
  byId(id) { return this.accounts().find(a => a.id === id); },

  current() {
    const id = localStorage.getItem(this.SESSION_KEY);
    if (!id) return null;
    return this.byId(id);
  },
  isAuthed() { return !!this.current(); },

  setSession(id) {
    localStorage.setItem(this.SESSION_KEY, id);
    const acc = this.byId(id);
    if (acc) {
      profileStore.set({
        name: acc.displayName,
        location: acc.location || "",
        email: acc.email,
        provider: acc.provider,
        bio: acc.bio || "",
        favoriteType: acc.favoriteType || "",
        avatarColor: acc.avatarColor || "",
        initials: acc.initials || "",
      });
    }
    refreshAuthUI();
  },

  signOut() {
    localStorage.removeItem(this.SESSION_KEY);
    localStorage.removeItem("user-profile");
    // Tell Google not to auto-prompt on the next page load. Best-effort —
    // safe no-op if the GIS script hasn't loaded.
    try {
      if (typeof google !== "undefined" && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
      }
    } catch {}
    refreshAuthUI();
  },

  async createEmailAccount({ name, email, location, password }) {
    const e = String(email).trim().toLowerCase();
    if (this.findByEmail(e)) {
      throw new Error("An account with that email already exists. Try signing in instead.");
    }
    const passwordHash = await hashPassword(password);
    const acc = {
      id: uid("acc"),
      email: e,
      displayName: name.trim(),
      location: (location || "").trim(),
      provider: "email",
      passwordHash,
      createdAt: Date.now(),
    };
    const arr = this.accounts();
    arr.push(acc);
    this.saveAccounts(arr);
    this.setSession(acc.id);
    return acc;
  },

  async signInWithPassword({ email, password }) {
    const acc = this.findByEmail(email);
    if (!acc) throw new Error("No account found with that email.");
    if (acc.provider !== "email") {
      throw new Error(`This email is registered with ${acc.provider === "google" ? "Google" : "Apple"}. Use that to sign in.`);
    }
    const candidate = await hashPassword(password);
    if (candidate !== acc.passwordHash) throw new Error("Incorrect password. Try again.");
    this.setSession(acc.id);
    return acc;
  },

  signInWithProvider({ provider, email, displayName, location }) {
    const e = String(email).trim().toLowerCase();
    const arr = this.accounts();
    let acc = arr.find(a => a.email === e);
    if (acc) {
      if (acc.provider !== provider) {
        const used = acc.provider === "email" ? "email and password" : (acc.provider === "google" ? "Google" : "Apple");
        throw new Error(`This email is already registered with ${used}. Use that to sign in.`);
      }
      if (displayName && !acc.displayName) acc.displayName = displayName;
      if (location && !acc.location) acc.location = location;
      this.saveAccounts(arr);
    } else {
      acc = {
        id: uid("acc"),
        email: e,
        displayName: (displayName || "").trim() || e.split("@")[0],
        location: (location || "").trim(),
        provider,
        passwordHash: null,
        createdAt: Date.now(),
      };
      arr.push(acc);
      this.saveAccounts(arr);
    }
    this.setSession(acc.id);
    return acc;
  },

  updateCurrent(patch) {
    const id = localStorage.getItem(this.SESSION_KEY);
    if (!id) return null;
    const arr = this.accounts();
    const i = arr.findIndex(a => a.id === id);
    if (i < 0) return null;
    arr[i] = { ...arr[i], ...patch };
    this.saveAccounts(arr);
    profileStore.set({
      name: arr[i].displayName,
      location: arr[i].location || "",
      email: arr[i].email,
      provider: arr[i].provider,
      bio: arr[i].bio || "",
      favoriteType: arr[i].favoriteType || "",
      avatarColor: arr[i].avatarColor || "",
      initials: arr[i].initials || "",
    });
    return arr[i];
  },

  async changePassword({ currentPassword, newPassword }) {
    const acc = this.current();
    if (!acc) throw new Error("You're not signed in.");
    if (acc.provider !== "email") {
      throw new Error(`This account signs in with ${acc.provider === "google" ? "Google" : "Apple"} — manage the password there.`);
    }
    const candidate = await hashPassword(currentPassword);
    if (candidate !== acc.passwordHash) throw new Error("Current password is incorrect.");
    if (newPassword.length < 6) throw new Error("New password must be at least 6 characters.");
    const newHash = await hashPassword(newPassword);
    this.updateCurrent({ passwordHash: newHash, passwordChangedAt: Date.now() });
    return true;
  },

  async setPasswordViaReset(newPassword) {
    if (newPassword.length < 6) throw new Error("Password must be at least 6 characters.");
    const newHash = await hashPassword(newPassword);
    this.updateCurrent({ passwordHash: newHash, passwordChangedAt: Date.now() });
    return true;
  },

  changeEmail(newEmail) {
    const acc = this.current();
    if (!acc) throw new Error("You're not signed in.");
    const e = String(newEmail).trim().toLowerCase();
    if (!isValidEmail(e)) throw new Error("Enter a valid email address.");
    if (e === acc.email) throw new Error("That's already your email.");
    if (this.findByEmail(e)) throw new Error("Another account already uses that email.");
    this.updateCurrent({ email: e, emailChangedAt: Date.now() });
    return true;
  },

  deleteCurrent() {
    const id = localStorage.getItem(this.SESSION_KEY);
    if (!id) return false;
    const arr = this.accounts().filter(a => a.id !== id);
    this.saveAccounts(arr);
    this.signOut();
    return true;
  },
};

function refreshAuthUI() {
  refreshProfileNav();
  refreshCounts();
  const out = document.getElementById("nav-signout");
  if (out) out.classList.toggle("hidden", !authStore.isAuthed());
}

// Top-level logout. Clears the local session, asks Google to forget the user,
// optionally confirms with the user, and sends them to the login page.
//
// Options:
//   - confirm:   show a "Sign out of CardKave?" dialog first (default true)
//   - redirect:  hash to navigate to after sign-out (default "#/login")
//   - silent:    skip the redirect entirely (caller will handle it)
//
// Returns true if the session was cleared, false if the user cancelled.
// Also exposed as window.logout so it can be called from devtools or hooks.
function logout(options = {}) {
  if (!authStore.isAuthed()) {
    if (!options.silent) window.location.hash = options.redirect || "#/login";
    return false;
  }
  const shouldConfirm = options.confirm !== false;
  if (shouldConfirm && !window.confirm("Sign out of CardKave?")) return false;
  authStore.signOut();
  if (!options.silent) window.location.hash = options.redirect || "#/login";
  return true;
}
window.logout = logout;

const PUBLIC_ROUTES = new Set(["login", "signup"]);
function isPublicRoute(parts) {
  return PUBLIC_ROUTES.has(parts[0]);
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}

const postStore = {
  list() { try { return JSON.parse(localStorage.getItem("feed-posts")) || []; } catch { return []; } },
  save(arr) { localStorage.setItem("feed-posts", JSON.stringify(arr)); },
  add(p) { const arr = this.list(); arr.unshift(p); this.save(arr); },
  toggleLike(id, name) {
    const arr = this.list();
    const p = arr.find(x => x.id === id);
    if (!p) return;
    p.likes = p.likes || [];
    const i = p.likes.indexOf(name);
    if (i >= 0) p.likes.splice(i, 1); else p.likes.push(name);
    this.save(arr);
  },
};

const groupStore = {
  list() { try { return JSON.parse(localStorage.getItem("feed-groups")) || []; } catch { return []; } },
  save(arr) { localStorage.setItem("feed-groups", JSON.stringify(arr)); },
  add(g) { const arr = this.list(); arr.unshift(g); this.save(arr); },
  byId(id) { return this.list().find(g => g.id === id); },
  toggleMember(id, name) {
    const arr = this.list();
    const g = arr.find(x => x.id === id);
    if (!g) return false;
    g.members = g.members || [];
    const i = g.members.indexOf(name);
    const joined = i < 0;
    if (i >= 0) g.members.splice(i, 1); else g.members.push(name);
    this.save(arr);
    return joined;
  },
  forUser(name) { return this.list().filter(g => (g.members || []).includes(name)); },
};

const eventStore = {
  list() { try { return JSON.parse(localStorage.getItem("feed-events")) || []; } catch { return []; } },
  save(arr) { localStorage.setItem("feed-events", JSON.stringify(arr)); },
  add(e) { const arr = this.list(); arr.unshift(e); this.save(arr); },
  byId(id) { return this.list().find(e => e.id === id); },
  update(id, patch) {
    const arr = this.list();
    const i = arr.findIndex(e => e.id === id);
    if (i < 0) return null;
    arr[i] = { ...arr[i], ...patch };
    this.save(arr);
    return arr[i];
  },
  toggleAttendee(id, name) {
    const arr = this.list();
    const ev = arr.find(x => x.id === id);
    if (!ev) return false;
    ev.attendees = ev.attendees || [];
    const i = ev.attendees.indexOf(name);
    const joining = i < 0;
    if (joining) {
      if (ev.attendees.length >= ev.maxPeople) return false;
      ev.attendees.push(name);
    } else {
      ev.attendees.splice(i, 1);
    }
    this.save(arr);
    return joining;
  },
};

// ---- Trade data layer
function tradeCard(setId, num, name, set, rarity, hp = "", artist = "") {
  return {
    id: `${setId}-${num}`,
    name,
    images: {
      small: `https://images.pokemontcg.io/${setId}/${num}.png`,
      large: `https://images.pokemontcg.io/${setId}/${num}_hires.png`,
    },
    set: { name: set, releaseDate: "", printedTotal: "" },
    rarity,
    artist,
    hp,
    number: String(num),
  };
}

const TRADE_CATALOG_LIST = [
  tradeCard("base1", "4",  "Charizard",  "Base Set", "Holo Rare", "120", "Mitsuhiro Arita"),
  tradeCard("base1", "2",  "Blastoise",  "Base Set", "Holo Rare", "100", "Ken Sugimori"),
  tradeCard("base1", "15", "Venusaur",   "Base Set", "Holo Rare", "100", "Mitsuhiro Arita"),
  tradeCard("base1", "10", "Mewtwo",     "Base Set", "Holo Rare", "60",  "Ken Sugimori"),
  tradeCard("base1", "1",  "Alakazam",   "Base Set", "Holo Rare", "80",  "Ken Sugimori"),
  tradeCard("base1", "6",  "Gyarados",   "Base Set", "Holo Rare", "100", "Mitsuhiro Arita"),
  tradeCard("base1", "8",  "Machamp",    "Base Set", "Holo Rare", "100", "Ken Sugimori"),
  tradeCard("base1", "14", "Raichu",     "Base Set", "Holo Rare", "80",  "Mitsuhiro Arita"),
  tradeCard("base1", "16", "Zapdos",     "Base Set", "Holo Rare", "90",  "Mitsuhiro Arita"),
  tradeCard("base1", "58", "Pikachu",    "Base Set", "Common",    "40",  "Mitsuhiro Arita"),
  tradeCard("jungle", "1", "Clefable",   "Jungle",   "Holo Rare", "70",  "Mitsuhiro Arita"),
  tradeCard("fossil", "1", "Aerodactyl", "Fossil",   "Holo Rare", "60",  "Kagemaru Himeno"),
];
const TRADE_CATALOG = Object.fromEntries(TRADE_CATALOG_LIST.map(c => [c.id, c]));

const tradeStore = {
  list() { try { return JSON.parse(localStorage.getItem("trades")) || []; } catch { return []; } },
  save(arr) { localStorage.setItem("trades", JSON.stringify(arr)); refreshCounts(); },
  add(t) { const arr = this.list(); arr.unshift(t); this.save(arr); },
  byId(id) { return this.list().find(t => t.id === id); },
  update(id, patch) {
    const arr = this.list();
    const i = arr.findIndex(t => t.id === id);
    if (i < 0) return null;
    arr[i] = { ...arr[i], ...patch, updatedAt: Date.now() };
    this.save(arr);
    return arr[i];
  },
  addMessage(id, sender, text) {
    const arr = this.list();
    const i = arr.findIndex(t => t.id === id);
    if (i < 0) return null;
    arr[i].messages = arr[i].messages || [];
    arr[i].messages.push({ sender, text, ts: Date.now() });
    arr[i].updatedAt = Date.now();
    this.save(arr);
    return arr[i];
  },
  forUser(name) {
    if (!name) return [];
    return this.list().filter(t => t.fromUserName === name || t.toUserName === name);
  },
};

const verifiedTemplateStore = {
  list() { try { return JSON.parse(localStorage.getItem("verified-event-templates")) || []; } catch { return []; } },
  save(arr) { localStorage.setItem("verified-event-templates", JSON.stringify(arr)); },
  signature(title, location) {
    return `${title.trim().toLowerCase()}|${location.trim().toLowerCase()}`;
  },
  has(title, location) { return this.list().includes(this.signature(title, location)); },
  add(title, location) {
    const sig = this.signature(title, location);
    const arr = this.list();
    if (!arr.includes(sig)) { arr.push(sig); this.save(arr); }
  },
};

function readImageAsResizedDataUrl(file, maxDim = 800) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function initials(name) {
  return String(name).split(/\s+/).map(p => p[0] || "").join("").slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  { name: "Slate", value: "#475569" },
  { name: "Crimson", value: "#dc2626" },
  { name: "Ember", value: "#ea580c" },
  { name: "Sun", value: "#ca8a04" },
  { name: "Leaf", value: "#16a34a" },
  { name: "Teal", value: "#0d9488" },
  { name: "Sky", value: "#0284c7" },
  { name: "Indigo", value: "#4f46e5" },
  { name: "Violet", value: "#7c3aed" },
  { name: "Pink", value: "#db2777" },
];

function avatarDisplay(profile) {
  const fromInitials = (profile?.initials || "").trim();
  if (fromInitials) return fromInitials.slice(0, 4);
  return initials(profile?.name || "");
}

function paintAvatar(el, profile) {
  if (!el || !profile) return;
  el.textContent = avatarDisplay(profile);
  if (profile.avatarColor) {
    el.style.background = profile.avatarColor;
    el.style.color = "#fff";
  } else {
    el.style.background = "";
    el.style.color = "";
  }
}

function refreshProfileNav() {
  const el = document.getElementById("nav-profile");
  if (!el) return;
  const p = profileStore.get();
  const authed = typeof authStore !== "undefined" && authStore.isAuthed();
  if (p && authed) {
    el.textContent = "";
    el.setAttribute("href", "#/profile");
    el.dataset.route = "profile";
    const av = document.createElement("span");
    av.className = "avatar avatar-sm";
    paintAvatar(av, p);
    const nm = document.createElement("span");
    nm.textContent = p.name;
    el.appendChild(av);
    el.appendChild(nm);
  } else {
    el.textContent = "Sign in";
    el.setAttribute("href", "#/login");
    el.dataset.route = "login";
  }
}

// ---- Render: Profile
function renderProfile() {
  setActiveNav("profile");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-profile"));

  const acc = authStore.current();
  if (!acc) { location.hash = "#/login"; return; }

  const flash = document.getElementById("profile-flash");
  let flashTimer = null;
  function showFlash(msg, kind = "ok") {
    flash.textContent = msg;
    flash.classList.remove("hidden", "profile-flash-error");
    if (kind === "error") flash.classList.add("profile-flash-error");
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.classList.add("hidden"), 4000);
  }

  function paintHeader() {
    const me = profileStore.get();
    paintAvatar(document.getElementById("pf-avatar-preview"), me);
    const meta = document.getElementById("profile-meta");
    const a = authStore.current();
    if (a && me) {
      const providerLabel = a.provider === "google" ? "Google" : a.provider === "apple" ? "Apple" : "email";
      const bits = [me.name, me.location, `${a.email} · ${providerLabel}`].filter(Boolean);
      meta.textContent = bits.join(" · ");
    }
    const emailSub = document.getElementById("pf-email-sub");
    if (emailSub && a) emailSub.textContent = a.email;
  }

  // ---- Identity form
  const me = profileStore.get() || {};
  const nameInp = document.getElementById("pf-name");
  const locInp = document.getElementById("pf-loc");
  const bioInp = document.getElementById("pf-bio");
  const typeInp = document.getElementById("pf-type");
  const bioCount = document.getElementById("pf-bio-count");
  nameInp.value = me.name || "";
  locInp.value = me.location || "";
  bioInp.value = me.bio || "";
  typeInp.value = me.favoriteType || "";
  bioCount.textContent = bioInp.value.length;
  bioInp.addEventListener("input", () => { bioCount.textContent = bioInp.value.length; });

  document.getElementById("profile-form").addEventListener("submit", e => {
    e.preventDefault();
    const name = nameInp.value.trim();
    const loc = locInp.value.trim();
    if (!name || !loc) return;
    authStore.updateCurrent({
      displayName: name,
      location: loc,
      bio: bioInp.value.trim(),
      favoriteType: typeInp.value,
    });
    paintHeader();
    showFlash("Profile saved.");
  });

  // ---- Avatar form
  const colorRow = document.getElementById("pf-color-row");
  const initialsInp = document.getElementById("pf-initials");
  initialsInp.value = me.initials || "";
  let selectedColor = me.avatarColor || "";
  function renderColors() {
    colorRow.innerHTML = "";
    const blank = document.createElement("button");
    blank.type = "button";
    blank.className = "color-swatch color-swatch-default";
    blank.title = "Default";
    blank.setAttribute("aria-label", "Default color");
    blank.setAttribute("role", "radio");
    blank.setAttribute("aria-checked", selectedColor === "" ? "true" : "false");
    if (selectedColor === "") blank.classList.add("selected");
    blank.addEventListener("click", () => { selectedColor = ""; renderColors(); });
    colorRow.appendChild(blank);
    AVATAR_COLORS.forEach(c => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "color-swatch";
      b.style.background = c.value;
      b.title = c.name;
      b.setAttribute("aria-label", c.name);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", selectedColor === c.value ? "true" : "false");
      if (selectedColor === c.value) b.classList.add("selected");
      b.addEventListener("click", () => { selectedColor = c.value; renderColors(); });
      colorRow.appendChild(b);
    });
  }
  renderColors();

  document.getElementById("avatar-form").addEventListener("submit", e => {
    e.preventDefault();
    authStore.updateCurrent({
      avatarColor: selectedColor,
      initials: initialsInp.value.trim().slice(0, 4),
    });
    paintHeader();
    showFlash("Avatar updated.");
  });

  // ---- Email form
  const emailInp = document.getElementById("pf-email");
  const newEmailInp = document.getElementById("pf-new-email");
  const emailMsg = document.getElementById("email-msg");
  emailInp.value = acc.email;

  function showEmailMsg(msg, kind = "error") {
    emailMsg.textContent = msg;
    emailMsg.classList.remove("hidden");
    emailMsg.classList.toggle("auth-error", kind === "error");
  }
  function clearEmailMsg() {
    emailMsg.textContent = "";
    emailMsg.classList.add("hidden");
  }

  document.getElementById("email-form").addEventListener("submit", e => {
    e.preventDefault();
    clearEmailMsg();
    const next = newEmailInp.value.trim();
    if (!isValidEmail(next)) return showEmailMsg("Enter a valid email address.");
    const a = authStore.current();
    if (a && next.toLowerCase() === a.email) return showEmailMsg("That's already your email.");
    if (authStore.findByEmail(next)) return showEmailMsg("Another account already uses that email.");
    openCodeModal({
      title: "Confirm your new email",
      intro: `We're sending a 6-digit code to ${next}.`,
      email: next,
      purpose: "email change",
      onVerified: () => {
        try {
          authStore.changeEmail(next);
          newEmailInp.value = "";
          emailInp.value = next;
          paintHeader();
          showFlash(`Email updated to ${next}.`);
        } catch (err) {
          showEmailMsg(err.message || "Couldn't change email.");
        }
      },
    });
  });

  // ---- Password form
  const passwordCard = document.getElementById("password-card");
  const passwordSub = document.getElementById("pf-password-sub");
  const currentPw = document.getElementById("pf-current-pw");
  const newPw = document.getElementById("pf-new-pw");
  const confirmPw = document.getElementById("pf-confirm-pw");
  const passwordMsg = document.getElementById("password-msg");
  const passwordSubmit = document.getElementById("password-submit");
  const resetLinkBtn = document.getElementById("password-reset-link");

  if (acc.provider !== "email") {
    passwordSub.textContent = `Managed by ${acc.provider === "google" ? "Google" : "Apple"} — no password to change.`;
    [currentPw, newPw, confirmPw, passwordSubmit].forEach(el => { el.disabled = true; });
    resetLinkBtn.disabled = true;
  }

  function showPwMsg(msg, kind = "error") {
    passwordMsg.textContent = msg;
    passwordMsg.classList.remove("hidden");
    passwordMsg.classList.toggle("auth-error", kind === "error");
  }
  function clearPwMsg() {
    passwordMsg.textContent = "";
    passwordMsg.classList.add("hidden");
  }

  document.getElementById("password-form").addEventListener("submit", async e => {
    e.preventDefault();
    clearPwMsg();
    if (acc.provider !== "email") return;
    if (newPw.value !== confirmPw.value) return showPwMsg("New passwords don't match.");
    passwordSubmit.disabled = true;
    passwordSubmit.textContent = "Updating…";
    try {
      await authStore.changePassword({ currentPassword: currentPw.value, newPassword: newPw.value });
      currentPw.value = ""; newPw.value = ""; confirmPw.value = "";
      showFlash("Password updated.");
    } catch (err) {
      showPwMsg(err.message || "Couldn't update password.");
    } finally {
      passwordSubmit.disabled = false;
      passwordSubmit.textContent = "Update password";
    }
  });

  resetLinkBtn.addEventListener("click", () => {
    if (acc.provider !== "email") return;
    openCodeModal({
      title: "Reset your password",
      intro: `We're sending a 6-digit code to ${acc.email}.`,
      email: acc.email,
      purpose: "password reset",
      onVerified: () => {
        const next = window.prompt("Choose a new password (at least 6 characters)");
        if (next == null) return;
        authStore.setPasswordViaReset(next).then(() => {
          showFlash("Password reset — you can sign in with the new password.");
        }).catch(err => showFlash(err.message || "Couldn't reset password.", "error"));
      },
    });
  });

  // ---- Account
  document.getElementById("profile-signout").addEventListener("click", () => logout());
  document.getElementById("profile-delete").addEventListener("click", () => {
    if (!window.confirm("Delete your CardKave account? This signs you out and removes your login. Local card data stays in this browser.")) return;
    authStore.deleteCurrent();
    window.location.hash = "#/login";
  });

  paintHeader();
}

// ---- EmailJS verification ----
const CODE_TTL_MS = 15 * 60 * 1000;

function isEmailServiceConfigured() {
  return !!(EMAIL_CONFIG.publicKey && EMAIL_CONFIG.serviceId && EMAIL_CONFIG.templateId);
}

function initEmailService() {
  if (!isEmailServiceConfigured()) return;
  if (typeof emailjs === "undefined") return;
  try { emailjs.init({ publicKey: EMAIL_CONFIG.publicKey }); } catch {}
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationCode({ to, purpose }) {
  if (!isEmailServiceConfigured()) {
    throw new Error("Email service isn't set up yet. Add your EmailJS credentials to EMAIL_CONFIG at the top of app.js.");
  }
  if (typeof emailjs === "undefined") {
    throw new Error("Email service is loading — try again in a moment.");
  }
  const code = generateCode();
  await emailjs.send(EMAIL_CONFIG.serviceId, EMAIL_CONFIG.templateId, {
    to_email: to,
    code,
    purpose,
  });
  return { code, expiresAt: Date.now() + CODE_TTL_MS };
}

// Open a modal that sends a real 6-digit code to `email`, then waits for the
// user to type it back. Calls onVerified() when the code matches.
function openCodeModal({ title, intro, email, purpose, onVerified }) {
  const modal = document.getElementById("email-link-modal");
  const titleEl = document.getElementById("email-link-title");
  const textEl = document.getElementById("email-link-text");
  const codeInp = document.getElementById("email-link-code");
  const errEl = document.getElementById("email-link-error");
  const confirmBtn = document.getElementById("email-link-confirm");
  const resendBtn = document.getElementById("email-link-resend");
  const closeBtn = document.getElementById("email-link-close");
  const backdrop = document.getElementById("email-link-backdrop");
  const fine = document.getElementById("email-link-fine");

  titleEl.textContent = title;
  textEl.textContent = intro;
  codeInp.value = "";
  fine.textContent = "This code expires in 15 minutes.";
  hideErr();
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  let pending = null;

  function hideErr() {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }
  function showErr(msg) {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  }
  function setSending(flag) {
    resendBtn.disabled = flag;
    confirmBtn.disabled = flag;
  }

  async function sendCode(initial) {
    setSending(true);
    if (initial) {
      titleEl.textContent = "Sending code…";
      textEl.textContent = `Sending a code to ${email}.`;
    } else {
      fine.textContent = "Sending a new code…";
    }
    try {
      pending = await sendVerificationCode({ to: email, purpose });
      titleEl.textContent = title;
      textEl.textContent = `We sent a 6-digit code to ${email}. Enter it below to confirm.`;
      fine.textContent = "This code expires in 15 minutes.";
      codeInp.focus();
    } catch (err) {
      titleEl.textContent = title;
      textEl.textContent = intro;
      fine.textContent = "Couldn't send a code.";
      showErr(err.message || "Couldn't send verification code.");
      pending = null;
    } finally {
      setSending(false);
    }
  }

  function verify() {
    hideErr();
    if (!pending) return showErr("No code to verify — request a new one.");
    if (Date.now() > pending.expiresAt) { pending = null; return showErr("That code expired. Tap \"Resend code\" to get a new one."); }
    const entered = codeInp.value.trim();
    if (entered.length !== 6 || !/^\d{6}$/.test(entered)) return showErr("Enter the 6-digit code from the email.");
    if (entered !== pending.code) return showErr("That code doesn't match. Double-check the email.");
    close();
    onVerified && onVerified();
  }

  function close() {
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");
    confirmBtn.removeEventListener("click", verify);
    resendBtn.removeEventListener("click", onResend);
    closeBtn.removeEventListener("click", close);
    backdrop.removeEventListener("click", close);
    codeInp.removeEventListener("keydown", onKey);
  }
  function onResend() { sendCode(false); }
  function onKey(e) { if (e.key === "Enter") { e.preventDefault(); verify(); } }

  confirmBtn.addEventListener("click", verify);
  resendBtn.addEventListener("click", onResend);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  codeInp.addEventListener("keydown", onKey);

  sendCode(true);
}

// ---- Render: Login
function renderLogin() {
  setActiveNav("login");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-login"));

  const emailInp = document.getElementById("login-email");
  const pwInp = document.getElementById("login-password");
  const errEl = document.getElementById("login-error");
  const submitBtn = document.getElementById("login-submit");
  const showBtn = document.getElementById("login-show-pw");

  showBtn.addEventListener("click", () => {
    const showing = pwInp.type === "text";
    pwInp.type = showing ? "password" : "text";
    showBtn.textContent = showing ? "Show" : "Hide";
  });

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  }
  function clearError() {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }

  document.getElementById("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    clearError();
    const email = emailInp.value.trim();
    const password = pwInp.value;
    if (!isValidEmail(email)) return showError("Enter a valid email address.");
    if (password.length < 6) return showError("Password must be at least 6 characters.");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";
    try {
      await authStore.signInWithPassword({ email, password });
      location.hash = "#/browse";
    } catch (err) {
      showError(err.message || "Sign-in failed.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  });

  document.getElementById("login-google").addEventListener("click", () => {
    runGoogleOAuth().then(profile => {
      if (!profile) return;
      try {
        authStore.signInWithProvider({ provider: "google", ...profile });
          location.hash = "#/browse";
      } catch (err) { showError(err.message); }
    });
  });

  document.getElementById("login-apple").addEventListener("click", () => {
    runAppleOAuth().then(profile => {
      if (!profile) return;
      try {
        authStore.signInWithProvider({ provider: "apple", ...profile });
          location.hash = "#/browse";
      } catch (err) { showError(err.message); }
    });
  });
}

// ---- Render: Signup
function renderSignup() {
  setActiveNav("signup");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-signup"));

  const nameInp = document.getElementById("signup-name");
  const emailInp = document.getElementById("signup-email");
  const locInp = document.getElementById("signup-location");
  const pwInp = document.getElementById("signup-password");
  const cfInp = document.getElementById("signup-confirm");
  const errEl = document.getElementById("signup-error");
  const submitBtn = document.getElementById("signup-submit");
  const showBtn = document.getElementById("signup-show-pw");

  showBtn.addEventListener("click", () => {
    const showing = pwInp.type === "text";
    pwInp.type = showing ? "password" : "text";
    cfInp.type = showing ? "password" : "text";
    showBtn.textContent = showing ? "Show" : "Hide";
  });

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  }
  function clearError() {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }

  document.getElementById("signup-form").addEventListener("submit", async e => {
    e.preventDefault();
    clearError();
    const name = nameInp.value.trim();
    const email = emailInp.value.trim();
    const loc = locInp.value.trim();
    const password = pwInp.value;
    const confirmPw = cfInp.value;
    if (!name) return showError("Display name is required.");
    if (!isValidEmail(email)) return showError("Enter a valid email address.");
    if (!loc) return showError("City or area is required.");
    if (password.length < 6) return showError("Password must be at least 6 characters.");
    if (password !== confirmPw) return showError("Passwords don't match.");
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating account…";
    try {
      await authStore.createEmailAccount({ name, email, location: loc, password });
      window.location.hash = "#/browse";
    } catch (err) {
      showError(err.message || "Could not create account.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create account";
    }
  });

  document.getElementById("signup-google").addEventListener("click", () => {
    runGoogleOAuth().then(profile => {
      if (!profile) return;
      try {
        authStore.signInWithProvider({ provider: "google", ...profile, location: locInp.value.trim() });
          location.hash = "#/browse";
      } catch (err) { showError(err.message); }
    });
  });

  document.getElementById("signup-apple").addEventListener("click", () => {
    runAppleOAuth().then(profile => {
      if (!profile) return;
      try {
        authStore.signInWithProvider({ provider: "apple", ...profile, location: locInp.value.trim() });
          location.hash = "#/browse";
      } catch (err) { showError(err.message); }
    });
  });
}

// ---- OAuth simulators (Google / Apple)
function openOAuthModal(templateId) {
  const modal = document.getElementById("oauth-modal");
  const popup = document.getElementById("oauth-popup");
  popup.innerHTML = "";
  popup.appendChild(tpl(templateId));
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  return { modal, popup };
}
function closeOAuthModal() {
  const modal = document.getElementById("oauth-modal");
  const popup = document.getElementById("oauth-popup");
  modal.classList.add("hidden");
  popup.innerHTML = "";
  document.body.style.overflow = "";
}

function runGoogleOAuth() {
  if (OAUTH_CONFIG.google.clientId) return runGoogleOAuthReal();
  return runGoogleOAuthSimulator();
}

function runGoogleOAuthReal() {
  return new Promise(resolve => {
    if (typeof google === "undefined" || !google.accounts || !google.accounts.oauth2) {
      alert("Google Sign-In is still loading — try again in a moment.");
      return resolve(null);
    }
    let resolved = false;
    const finish = (value) => { if (!resolved) { resolved = true; resolve(value); } };
    const client = google.accounts.oauth2.initTokenClient({
      client_id: OAUTH_CONFIG.google.clientId,
      scope: "openid email profile",
      callback: async (resp) => {
        if (resp.error || !resp.access_token) {
          alert(resp.error_description || resp.error || "Google sign-in failed.");
          return finish(null);
        }
        try {
          const u = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${resp.access_token}` },
          }).then(r => {
            if (!r.ok) throw new Error(`userinfo ${r.status}`);
            return r.json();
          });
          if (!u.email) {
            alert("Google did not return an email.");
            return finish(null);
          }
          finish({ email: u.email, displayName: u.name || u.given_name || u.email.split("@")[0] });
        } catch (e) {
          alert("Could not load your Google profile: " + (e.message || e));
          finish(null);
        }
      },
      error_callback: (err) => {
        if (err && err.type !== "popup_closed") alert(err.message || "Google sign-in failed.");
        finish(null);
      },
    });
    client.requestAccessToken();
  });
}

function runGoogleOAuthSimulator() {
  return new Promise(resolve => {
    const { popup } = openOAuthModal("tpl-oauth-google");
    let settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      closeOAuthModal();
      resolve(value);
    }
    document.getElementById("oauth-close").addEventListener("click", () => settle(null));
    document.getElementById("oauth-backdrop").addEventListener("click", () => settle(null));

    const customForm = document.getElementById("oauth-google-custom");
    setTimeout(() => document.getElementById("oauth-google-email").focus(), 50);
    customForm.addEventListener("submit", e => {
      e.preventDefault();
      const email = document.getElementById("oauth-google-email").value.trim();
      const name = document.getElementById("oauth-google-name").value.trim();
      if (!isValidEmail(email) || !name) return;
      showLoadingState(popup, "Signing in to Google…");
      setTimeout(() => settle({ email, displayName: name }), 650);
    });
  });
}

function runAppleOAuth() {
  if (OAUTH_CONFIG.apple.clientId) return runAppleOAuthReal();
  return runAppleOAuthSimulator();
}

function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch { return null; }
}

function runAppleOAuthReal() {
  return new Promise(resolve => {
    if (typeof AppleID === "undefined" || !AppleID.auth) {
      alert("Apple Sign-In is still loading — try again in a moment.");
      return resolve(null);
    }
    try {
      AppleID.auth.init({
        clientId: OAUTH_CONFIG.apple.clientId,
        scope: "name email",
        redirectURI: OAUTH_CONFIG.apple.redirectURI || window.location.origin + window.location.pathname,
        usePopup: true,
      });
    } catch (e) {
      alert("Apple Sign-In init failed: " + (e.message || e));
      return resolve(null);
    }
    AppleID.auth.signIn().then(data => {
      const claims = decodeJwt(data?.authorization?.id_token);
      const email = claims?.email || data?.user?.email;
      if (!email) {
        alert("Apple did not return an email.");
        return resolve(null);
      }
      const userName = data?.user?.name;
      const displayName = userName?.firstName
        ? `${userName.firstName} ${userName.lastName || ""}`.trim()
        : (claims?.name || email.split("@")[0]);
      resolve({ email, displayName });
    }).catch(err => {
      const code = err && (err.error || err.code);
      if (code && code !== "popup_closed_by_user" && code !== "user_cancelled_authorize") {
        alert("Apple sign-in failed: " + (err.error || err.message || code));
      }
      resolve(null);
    });
  });
}

function runAppleOAuthSimulator() {
  return new Promise(resolve => {
    const { popup } = openOAuthModal("tpl-oauth-apple");
    let settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      closeOAuthModal();
      resolve(value);
    }
    document.getElementById("oauth-close-apple").addEventListener("click", () => settle(null));
    document.getElementById("oauth-backdrop").addEventListener("click", () => settle(null));

    document.getElementById("oauth-apple-form").addEventListener("submit", e => {
      e.preventDefault();
      const rawEmail = document.getElementById("oauth-apple-email").value.trim();
      const name = document.getElementById("oauth-apple-name").value.trim();
      const hide = document.getElementById("oauth-apple-hide").checked;
      if (!isValidEmail(rawEmail) || !name) return;
      const email = hide
        ? `${Math.random().toString(36).slice(2, 10)}@privaterelay.appleid.com`
        : rawEmail;
      showLoadingState(popup, "Signing in with Apple…");
      setTimeout(() => settle({ email, displayName: name }), 650);
    });
  });
}

function showLoadingState(popup, label) {
  popup.innerHTML = `
    <div class="oauth-loading">
      <div class="oauth-spinner" aria-hidden="true"></div>
      <p>${label}</p>
    </div>
  `;
}

// ---- Render: Feed
function renderFeed() {
  setActiveNav("feed");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-feed"));

  const me = profileStore.get();
  const ctx = document.getElementById("feed-context");
  if (me) {
    ctx.textContent = `Signed in as ${me.name} · ${me.location}`;
  } else {
    ctx.innerHTML = `<a href="#/profile" class="link">Set up your profile</a> to post and filter by your area.`;
  }

  const tabs = document.querySelectorAll("#feed-tabs .tab");
  let tab = me ? "community" : "all";
  if (!me) {
    const ctab = document.querySelector('#feed-tabs .tab[data-tab="community"]');
    if (ctab) ctab.classList.add("hidden");
  }
  tabs.forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  tabs.forEach(b => b.addEventListener("click", () => {
    tab = b.dataset.tab;
    tabs.forEach(x => x.classList.toggle("active", x === b));
    paint();
  }));

  if (me) mountCompose(document.getElementById("compose-host"), { groupId: null });

  function paint() {
    const list = postStore.list().filter(p => !p.groupId);
    const filtered = tab === "community" && me
      ? list.filter(p => (p.authorLocation || "").toLowerCase() === me.location.toLowerCase())
      : list;
    paintFeed(document.getElementById("feed-list"), document.getElementById("feed-empty"), filtered);
  }
  paint();
}

function paintFeed(host, empty, posts) {
  host.innerHTML = "";
  if (!posts.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  const me = profileStore.get();
  posts.forEach(p => host.appendChild(makePostEl(p, me)));
}

function makePostEl(post, me) {
  const wrap = document.createElement("article");
  wrap.className = "post";
  wrap.dataset.postId = post.id;

  const head = document.createElement("header");
  head.className = "post-head";
  const av = document.createElement("span");
  av.className = "avatar";
  const myProfile = profileStore.get();
  if (myProfile && post.authorName === myProfile.name) {
    paintAvatar(av, myProfile);
  } else {
    av.textContent = initials(post.authorName);
  }
  head.appendChild(av);

  const meta = document.createElement("div");
  meta.className = "post-meta";
  const nameRow = document.createElement("div");
  nameRow.className = "post-name-row";
  const name = document.createElement("strong");
  name.textContent = post.authorName;
  nameRow.appendChild(name);
  meta.appendChild(nameRow);

  const sub = document.createElement("div");
  sub.className = "post-sub muted mono";
  sub.textContent = `${post.authorLocation} · ${relTime(post.createdAt)}`;
  meta.appendChild(sub);
  head.appendChild(meta);
  wrap.appendChild(head);

  const body = document.createElement("p");
  body.className = "post-body";
  body.textContent = post.content;
  wrap.appendChild(body);

  if (post.card) {
    const cardEl = document.createElement("div");
    cardEl.className = "post-card";
    if (post.card.imageUrl) {
      const img = document.createElement("img");
      img.src = post.card.imageUrl;
      img.alt = post.card.name;
      img.loading = "lazy";
      cardEl.appendChild(img);
    }
    const cn = document.createElement("span");
    cn.textContent = post.card.name;
    cardEl.appendChild(cn);
    wrap.appendChild(cardEl);
  }

  const actions = document.createElement("div");
  actions.className = "post-actions";
  const likeBtn = document.createElement("button");
  likeBtn.type = "button";
  likeBtn.className = "post-like";
  const likeCount = (post.likes || []).length;
  const liked = !!(me && (post.likes || []).includes(me.name));
  likeBtn.innerHTML = `<span class="heart">${liked ? "♥" : "♡"}</span> <span>${likeCount}</span>`;
  likeBtn.classList.toggle("active", liked);
  if (!me) likeBtn.disabled = true;
  likeBtn.addEventListener("click", () => {
    if (!me) return;
    postStore.toggleLike(post.id, me.name);
    const updated = postStore.list().find(x => x.id === post.id);
    wrap.replaceWith(makePostEl(updated, profileStore.get()));
  });
  actions.appendChild(likeBtn);
  wrap.appendChild(actions);

  return wrap;
}

function mountCompose(host, opts) {
  const { groupId } = opts;
  host.innerHTML = "";
  host.appendChild(tpl("tpl-compose"));

  const me = profileStore.get();
  paintAvatar(document.getElementById("compose-avatar"), me);
  document.getElementById("compose-meta").textContent = `${me.name} · ${me.location}`;

  const attach = document.getElementById("compose-attach");
  const myCards = collectionCards.list();
  if (myCards.length === 0) {
    attach.disabled = true;
    attach.firstElementChild.textContent = "Add cards to your collection to attach";
  } else {
    myCards.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      attach.appendChild(opt);
    });
  }

  let attachedCard = null;
  const cardPreview = document.getElementById("compose-card");
  function renderAttached() {
    if (!attachedCard) { cardPreview.classList.add("hidden"); return; }
    cardPreview.classList.remove("hidden");
    document.getElementById("compose-card-img").src = attachedCard.imageUrl;
    document.getElementById("compose-card-name").textContent = attachedCard.name;
  }
  attach.addEventListener("change", () => {
    const id = attach.value;
    if (!id) { attachedCard = null; renderAttached(); return; }
    const c = myCards.find(x => x.id === id);
    if (c) {
      attachedCard = { id: c.id, name: c.name, imageUrl: c.images?.small || "" };
      renderAttached();
    }
  });
  document.getElementById("compose-card-clear").addEventListener("click", () => {
    attachedCard = null;
    attach.value = "";
    renderAttached();
  });

  const target = document.getElementById("compose-target");
  if (groupId) {
    target.classList.add("hidden");
  } else {
    const myGroups = groupStore.forUser(me.name);
    myGroups.forEach(g => {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = `Post to ${g.name}`;
      target.appendChild(opt);
    });
  }

  document.getElementById("compose").addEventListener("submit", e => {
    e.preventDefault();
    const text = document.getElementById("compose-text").value.trim();
    if (!text) return;
    const post = {
      id: uid("p"),
      authorName: me.name,
      authorLocation: me.location,
      content: text,
      card: attachedCard,
      groupId: groupId || target.value || null,
      createdAt: Date.now(),
      likes: [],
    };
    postStore.add(post);
    route();
  });
}

// ---- Render: Groups
function renderGroups() {
  setActiveNav("groups");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-groups"));

  const me = profileStore.get();
  const ctx = document.getElementById("groups-context");
  if (me) {
    ctx.textContent = `Discover collectors in ${me.location} and beyond.`;
  } else {
    ctx.innerHTML = `<a href="#/profile" class="link">Set up your profile</a> to join or create groups.`;
  }

  const newBtn = document.getElementById("new-group-btn");
  const newHost = document.getElementById("new-group-host");
  newBtn.addEventListener("click", () => {
    if (!me) { location.hash = "#/profile"; return; }
    if (newHost.firstChild) { newHost.innerHTML = ""; return; }
    newHost.appendChild(tpl("tpl-new-group"));
    document.getElementById("ng-loc").value = me.location;
    document.getElementById("ng-cancel").addEventListener("click", () => { newHost.innerHTML = ""; });
    document.getElementById("new-group-form").addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("ng-name").value.trim();
      const loc = document.getElementById("ng-loc").value.trim();
      const desc = document.getElementById("ng-desc").value.trim();
      if (!name || !loc || !desc) return;
      const g = {
        id: uid("g"),
        name, description: desc, location: loc,
        createdBy: me.name,
        createdAt: Date.now(),
        members: [me.name],
      };
      groupStore.add(g);
      location.hash = `#/groups/${g.id}`;
    });
  });

  paintGroups();
}

function paintGroups() {
  const me = profileStore.get();
  const list = document.getElementById("groups-list");
  const empty = document.getElementById("groups-empty");
  list.innerHTML = "";

  let groups = groupStore.list();
  if (me) {
    const local = me.location.toLowerCase();
    groups = groups.slice().sort((a, b) => {
      const al = a.location.toLowerCase() === local ? 0 : 1;
      const bl = b.location.toLowerCase() === local ? 0 : 1;
      if (al !== bl) return al - bl;
      const ag = a.location.toLowerCase() === "global" ? 0 : 1;
      const bg = b.location.toLowerCase() === "global" ? 0 : 1;
      if (ag !== bg) return ag - bg;
      return b.createdAt - a.createdAt;
    });
  }

  if (!groups.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  groups.forEach(g => list.appendChild(makeGroupCard(g, me)));
}

function makeGroupCard(g, me) {
  const wrap = document.createElement("a");
  wrap.className = "group-card";
  wrap.href = `#/groups/${g.id}`;

  const titleRow = document.createElement("div");
  titleRow.className = "group-title-row";
  const h3 = document.createElement("h3");
  h3.className = "group-title";
  h3.textContent = g.name;
  titleRow.appendChild(h3);
  if (me && (g.members || []).includes(me.name)) {
    const badge = document.createElement("span");
    badge.className = "joined-badge";
    badge.textContent = "Joined";
    titleRow.appendChild(badge);
  }
  wrap.appendChild(titleRow);

  const sub = document.createElement("div");
  sub.className = "group-sub muted mono";
  const memberCount = (g.members || []).length;
  sub.textContent = `${g.location} · ${memberCount} member${memberCount === 1 ? "" : "s"}`;
  wrap.appendChild(sub);

  const desc = document.createElement("p");
  desc.className = "group-desc";
  desc.textContent = g.description;
  wrap.appendChild(desc);

  const foot = document.createElement("div");
  foot.className = "group-foot muted";
  foot.textContent = `Created by ${g.createdBy}`;
  wrap.appendChild(foot);

  return wrap;
}

// ---- Render: Group detail
function renderGroup(id) {
  setActiveNav("groups");
  view.innerHTML = "";

  const g = groupStore.byId(id);
  if (!g) {
    view.innerHTML = "<p class='muted'>Group not found.</p>";
    return;
  }
  view.appendChild(tpl("tpl-group"));
  document.getElementById("group-name").textContent = g.name;
  document.getElementById("group-desc").textContent = g.description;

  const me = profileStore.get();
  const joinBtn = document.getElementById("group-join");
  const metaEl = document.getElementById("group-meta");

  function paintMeta() {
    const count = (g.members || []).length;
    metaEl.textContent = `${g.location} · ${count} member${count === 1 ? "" : "s"} · created by ${g.createdBy}`;
  }

  function syncJoin() {
    if (!me) {
      joinBtn.textContent = "Sign in to join";
      joinBtn.classList.add("ghost");
      joinBtn.onclick = () => { location.hash = "#/profile"; };
      return;
    }
    const isMember = (g.members || []).includes(me.name);
    joinBtn.textContent = isMember ? "Leave" : "Join";
    joinBtn.classList.toggle("ghost", isMember);
    joinBtn.onclick = () => {
      groupStore.toggleMember(g.id, me.name);
      const updated = groupStore.byId(g.id);
      g.members = updated.members;
      paintMeta();
      syncJoin();
      mountComposeArea();
    };
  }

  function mountComposeArea() {
    const host = document.getElementById("compose-host");
    host.innerHTML = "";
    if (!me) return;
    if (!(g.members || []).includes(me.name)) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Join to post in this group.";
      host.appendChild(note);
      return;
    }
    mountCompose(host, { groupId: g.id });
  }

  paintMeta();
  syncJoin();
  mountComposeArea();

  const posts = postStore.list().filter(p => p.groupId === g.id);
  paintFeed(document.getElementById("feed-list"), document.getElementById("feed-empty"), posts);
}

// ---- Render: Events
function renderEvents() {
  setActiveNav("events");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-events"));

  const me = profileStore.get();
  const ctx = document.getElementById("events-context");
  if (me) {
    ctx.textContent = `Meetups, trade nights, and tournaments — near ${me.location} and beyond.`;
  } else {
    ctx.innerHTML = `<a href="#/profile" class="link">Set up your profile</a> to RSVP or create events.`;
  }

  const newBtn = document.getElementById("new-event-btn");
  const newHost = document.getElementById("new-event-host");
  newBtn.addEventListener("click", () => {
    if (!me) { location.hash = "#/profile"; return; }
    if (newHost.firstChild) { newHost.innerHTML = ""; return; }
    mountNewEventForm(newHost, me, () => paintEvents(currentTab));
  });

  let currentTab = "verified";
  const tabs = document.querySelectorAll("#events-tabs .tab");
  tabs.forEach(b => b.addEventListener("click", () => {
    currentTab = b.dataset.tab;
    tabs.forEach(x => x.classList.toggle("active", x === b));
    paintEvents(currentTab);
  }));

  paintEvents(currentTab);
}

function paintEvents(tab) {
  const me = profileStore.get();
  const list = document.getElementById("events-list");
  const empty = document.getElementById("events-empty");
  list.innerHTML = "";

  let events = eventStore.list().filter(e => tab === "verified" ? e.verified : !e.verified);
  if (me) {
    const local = me.location.toLowerCase();
    events = events.slice().sort((a, b) => {
      const al = a.location.toLowerCase() === local ? 0 : 1;
      const bl = b.location.toLowerCase() === local ? 0 : 1;
      if (al !== bl) return al - bl;
      const ag = a.location.toLowerCase() === "global" ? 0 : 1;
      const bg = b.location.toLowerCase() === "global" ? 0 : 1;
      if (ag !== bg) return ag - bg;
      return b.createdAt - a.createdAt;
    });
  }

  if (!events.length) {
    empty.classList.remove("hidden");
    empty.textContent = tab === "pending" ? "No events awaiting verification." : "No events yet — be the first to create one.";
    return;
  }
  empty.classList.add("hidden");
  events.forEach(e => list.appendChild(makeEventCard(e, me)));
}

function makeEventCard(e, me) {
  const wrap = document.createElement("a");
  wrap.className = "event-card";
  wrap.href = `#/events/${e.id}`;
  if (!e.verified) wrap.classList.add("event-card-pending");

  if (e.photos && e.photos.length) {
    const thumb = document.createElement("div");
    thumb.className = "event-card-thumb";
    const img = document.createElement("img");
    img.src = e.photos[0];
    img.alt = "";
    img.loading = "lazy";
    thumb.appendChild(img);
    wrap.appendChild(thumb);
  }

  const body = document.createElement("div");
  body.className = "event-card-body";

  const titleRow = document.createElement("div");
  titleRow.className = "event-title-row";
  const h3 = document.createElement("h3");
  h3.className = "event-title";
  h3.textContent = e.title;
  titleRow.appendChild(h3);
  const status = document.createElement("span");
  status.className = `event-status ${e.verified ? "verified" : "pending"}`;
  status.textContent = e.verified ? "Verified" : "Pending";
  titleRow.appendChild(status);
  body.appendChild(titleRow);

  const sub = document.createElement("div");
  sub.className = "event-sub muted mono";
  const count = (e.attendees || []).length;
  sub.textContent = `${e.location} · ${count}/${e.maxPeople} attending`;
  body.appendChild(sub);

  const desc = document.createElement("p");
  desc.className = "event-card-desc";
  desc.textContent = e.description;
  body.appendChild(desc);

  const foot = document.createElement("div");
  foot.className = "event-foot muted";
  foot.textContent = `Created by ${e.createdBy}`;
  body.appendChild(foot);

  wrap.appendChild(body);
  return wrap;
}

function mountNewEventForm(host, me, onCreated) {
  host.innerHTML = "";
  host.appendChild(tpl("tpl-new-event"));

  const titleInp = document.getElementById("ne-title");
  const locInp = document.getElementById("ne-loc");
  const maxInp = document.getElementById("ne-max");
  const descInp = document.getElementById("ne-desc");
  const photosInp = document.getElementById("ne-photos");
  const preview = document.getElementById("ne-photo-preview");
  const note = document.getElementById("ne-verify-note");
  locInp.value = me.location;

  let photoData = [];

  function refreshNote() {
    const t = titleInp.value.trim();
    const l = locInp.value.trim();
    if (t && l && verifiedTemplateStore.has(t, l)) {
      note.innerHTML = `<span class="instant-verify">✓ This title and location have been verified before — your event will publish instantly.</span>`;
    } else {
      note.textContent = "New events need to be verified by a moderator before they go live. Reusing a previously verified title and location will publish instantly.";
    }
  }
  titleInp.addEventListener("input", refreshNote);
  locInp.addEventListener("input", refreshNote);

  photosInp.addEventListener("change", async () => {
    const files = Array.from(photosInp.files || []).slice(0, 3);
    preview.innerHTML = "";
    photoData = [];
    for (const f of files) {
      try {
        const url = await readImageAsResizedDataUrl(f);
        photoData.push(url);
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        preview.appendChild(img);
      } catch {
        // skip unreadable file
      }
    }
  });

  document.getElementById("ne-cancel").addEventListener("click", () => { host.innerHTML = ""; });

  document.getElementById("new-event-form").addEventListener("submit", ev => {
    ev.preventDefault();
    const title = titleInp.value.trim();
    const loc = locInp.value.trim();
    const max = Math.max(2, Math.min(500, Number(maxInp.value) || 0));
    const desc = descInp.value.trim();
    if (!title || !loc || !desc || !max) return;

    const preVerified = verifiedTemplateStore.has(title, loc);
    const event = {
      id: uid("e"),
      title,
      description: desc,
      location: loc,
      maxPeople: max,
      photos: photoData.slice(),
      createdBy: me.name,
      createdAt: Date.now(),
      verified: preVerified,
      attendees: [me.name],
    };
    try {
      eventStore.add(event);
    } catch (err) {
      alert("Couldn't save — your photos may be too large for browser storage. Try fewer or smaller images.");
      return;
    }
    host.innerHTML = "";
    if (preVerified) {
      location.hash = `#/events/${event.id}`;
    } else {
      onCreated && onCreated();
      location.hash = `#/events/${event.id}`;
    }
  });
}

function renderEvent(id) {
  setActiveNav("events");
  view.innerHTML = "";

  let e = eventStore.byId(id);
  if (!e) {
    view.innerHTML = "<p class='muted'>Event not found.</p>";
    return;
  }
  view.appendChild(tpl("tpl-event"));

  const me = profileStore.get();

  function paint() {
    e = eventStore.byId(id);
    document.getElementById("event-title").textContent = e.title;
    const count = (e.attendees || []).length;
    document.getElementById("event-meta").textContent =
      `${e.location} · created by ${e.createdBy} · ${relTime(e.createdAt)}`;
    document.getElementById("event-desc").textContent = e.description;

    const status = document.getElementById("event-status");
    status.textContent = e.verified ? "Verified" : "Awaiting verification";
    status.className = `event-status ${e.verified ? "verified" : "pending"}`;

    const photosEl = document.getElementById("event-photos");
    photosEl.innerHTML = "";
    if (e.photos && e.photos.length) {
      e.photos.forEach(src => {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        img.loading = "lazy";
        photosEl.appendChild(img);
      });
    } else {
      photosEl.classList.add("hidden");
    }

    const fill = document.getElementById("event-attendance-fill");
    const label = document.getElementById("event-attendance-label");
    const pct = Math.min(100, (count / e.maxPeople) * 100);
    fill.style.width = `${pct}%`;
    label.textContent = `${count} / ${e.maxPeople} attending`;

    const rsvpBtn = document.getElementById("event-rsvp");
    if (!me) {
      rsvpBtn.textContent = "Sign in to RSVP";
      rsvpBtn.classList.add("ghost");
      rsvpBtn.onclick = () => { location.hash = "#/profile"; };
    } else if (!e.verified) {
      rsvpBtn.textContent = "RSVP locked until verified";
      rsvpBtn.disabled = true;
      rsvpBtn.classList.add("ghost");
    } else {
      rsvpBtn.disabled = false;
      const isAttending = (e.attendees || []).includes(me.name);
      const isFull = count >= e.maxPeople;
      if (isAttending) {
        rsvpBtn.textContent = "Cancel RSVP";
        rsvpBtn.classList.add("ghost");
      } else if (isFull) {
        rsvpBtn.textContent = "Event full";
        rsvpBtn.disabled = true;
        rsvpBtn.classList.add("ghost");
      } else {
        rsvpBtn.textContent = "RSVP";
        rsvpBtn.classList.remove("ghost");
      }
      rsvpBtn.onclick = () => {
        eventStore.toggleAttendee(e.id, me.name);
        paint();
      };
    }

    const verifyHost = document.getElementById("event-verify-host");
    verifyHost.innerHTML = "";
    if (!e.verified) {
      const card = document.createElement("div");
      card.className = "verify-card";
      const txt = document.createElement("p");
      txt.className = "muted";
      txt.innerHTML = `This event is awaiting moderator verification. <span class="muted">(Demo: anyone can approve. Once verified, the same title and location can be reused without re-approval.)</span>`;
      card.appendChild(txt);
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.type = "button";
      btn.textContent = "Verify event";
      btn.addEventListener("click", () => {
        eventStore.update(e.id, { verified: true });
        verifiedTemplateStore.add(e.title, e.location);
        paint();
      });
      card.appendChild(btn);
      verifyHost.appendChild(card);
    }
  }

  paint();
}

// ---- Trades feature
function buildTradeMatches(_me) {
  return [];
}

function statusLabel(s) {
  return { proposed: "Proposed", accepted: "Accepted", declined: "Declined" }[s] || s;
}

function tradeOtherParty(trade, me) {
  if (!me) return { name: trade.toUserName, location: trade.toUserLocation };
  if (trade.fromUserName === me.name) return { name: trade.toUserName, location: trade.toUserLocation };
  return { name: trade.fromUserName, location: trade.fromUserLocation };
}

// ---- Render: Trades index
function renderTrades() {
  setActiveNav("trades");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-trades"));

  const me = profileStore.get();
  const ctx = document.getElementById("trades-context");
  const empty = document.getElementById("trades-empty");

  if (!me) {
    ctx.innerHTML = `<a href="#/profile" class="link">Set up your profile</a> to find trade matches in your area.`;
    empty.classList.remove("hidden");
    empty.textContent = "Sign in to start trading.";
    return;
  }

  ctx.textContent = `Matched by your collection and wishlist · prioritized near ${me.location}.`;

  const myTrades = tradeStore.forUser(me.name);
  paintActiveTrades(myTrades, me);

  const matches = buildTradeMatches(me);
  paintTradeMatches(matches, me);

  if (!myTrades.length && !matches.length) {
    empty.classList.remove("hidden");
    const myColl = collectionCards.list().length;
    const myWish = wishlistCards.list().length;
    if (!myColl && !myWish) {
      empty.innerHTML = `Add cards to your <a href="#/collection" class="link">collection</a> and <a href="#/wishlist" class="link">wishlist</a> — we'll surface collectors who want what you have and have what you want.`;
    } else if (!myColl) {
      empty.innerHTML = `<a href="#/browse" class="link">Browse</a> Pokémon and add cards to your collection so others know what you can offer.`;
    } else if (!myWish) {
      empty.innerHTML = `<a href="#/browse" class="link">Browse</a> Pokémon and add cards to your wishlist so we know what to look for.`;
    } else {
      empty.textContent = "No matching collectors yet. Try adding more cards or check back as the community grows.";
    }
  } else {
    empty.classList.add("hidden");
  }
}

function paintActiveTrades(trades, me) {
  const sec = document.getElementById("active-trades-section");
  const host = document.getElementById("active-trades");
  const meta = document.getElementById("active-trades-meta");
  host.innerHTML = "";
  if (!trades.length) {
    sec.classList.add("hidden");
    return;
  }
  sec.classList.remove("hidden");
  const open = trades.filter(t => t.status === "proposed").length;
  meta.textContent = `${trades.length} total · ${open} open`;
  trades.slice().sort((a, b) => b.updatedAt - a.updatedAt).forEach(t => host.appendChild(makeActiveTradeRow(t, me)));
}

function makeActiveTradeRow(t, me) {
  const isFromUser = t.fromUserName === me.name;
  const other = tradeOtherParty(t, me);
  const give = isFromUser ? t.fromCard : t.toCard;
  const get  = isFromUser ? t.toCard   : t.fromCard;

  const wrap = document.createElement("a");
  wrap.className = "trade-row";
  wrap.href = `#/trades/${t.id}`;

  const cards = document.createElement("div");
  cards.className = "trade-row-cards";
  cards.appendChild(makeRowThumb(give, "give"));
  const arrow = document.createElement("span");
  arrow.className = "trade-row-arrow";
  arrow.textContent = "↔";
  cards.appendChild(arrow);
  cards.appendChild(makeRowThumb(get, "get"));
  wrap.appendChild(cards);

  const info = document.createElement("div");
  info.className = "trade-row-info";
  const title = document.createElement("strong");
  title.textContent = `with ${other.name}`;
  info.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "muted mono";
  const isLocal = me.location && other.location && other.location.toLowerCase() === me.location.toLowerCase();
  sub.textContent = `${other.location || ""}${isLocal ? " · nearby" : ""} · ${relTime(t.updatedAt)}`;
  info.appendChild(sub);
  const detail = document.createElement("div");
  detail.className = "trade-row-detail muted";
  detail.textContent = `${give?.name || "?"} → ${get?.name || "?"}`;
  info.appendChild(detail);
  wrap.appendChild(info);

  const status = document.createElement("span");
  status.className = `trade-status status-${t.status}`;
  status.textContent = statusLabel(t.status);
  wrap.appendChild(status);

  return wrap;
}

function makeRowThumb(card, kind) {
  const wrap = document.createElement("div");
  wrap.className = `trade-row-thumb thumb-${kind}`;
  if (card?.images?.small) {
    const img = document.createElement("img");
    img.src = card.images.small;
    img.alt = card.name || "";
    img.loading = "lazy";
    wrap.appendChild(img);
  }
  return wrap;
}

function paintTradeMatches(matches, me) {
  const sec = document.getElementById("matches-section");
  const host = document.getElementById("matches-list");
  const meta = document.getElementById("matches-meta");
  host.innerHTML = "";
  if (!matches.length) {
    sec.classList.add("hidden");
    return;
  }
  sec.classList.remove("hidden");
  const localCount = matches.filter(m => m.user.location.toLowerCase() === me.location.toLowerCase()).length;
  meta.textContent = `${matches.length} collector${matches.length === 1 ? "" : "s"} ready to trade${localCount ? ` · ${localCount} near ${me.location}` : ""}.`;
  matches.forEach(m => host.appendChild(makeMatchCard(m, me)));
}

function makeMatchCard(match, me) {
  const isLocal = match.user.location.toLowerCase() === me.location.toLowerCase();
  const wrap = document.createElement("article");
  wrap.className = `match-card${isLocal ? " match-local" : ""}`;

  const head = document.createElement("header");
  head.className = "match-head";
  const av = document.createElement("span");
  av.className = "avatar";
  av.textContent = initials(match.user.name);
  head.appendChild(av);

  const meta = document.createElement("div");
  meta.className = "match-meta";
  const nameRow = document.createElement("div");
  nameRow.className = "match-name-row";
  const nm = document.createElement("strong");
  nm.textContent = match.user.name;
  nameRow.appendChild(nm);
  if (isLocal) {
    const b = document.createElement("span");
    b.className = "badge-local";
    b.textContent = "Nearby";
    nameRow.appendChild(b);
  }
  meta.appendChild(nameRow);
  const sub = document.createElement("div");
  sub.className = "muted mono";
  sub.textContent = match.user.location;
  meta.appendChild(sub);
  head.appendChild(meta);
  wrap.appendChild(head);

  const sides = document.createElement("div");
  sides.className = "match-sides";
  sides.appendChild(makeMatchSide(`${match.user.name} has · you want`, match.theyHaveIWant));
  sides.appendChild(makeMatchSide(`You have · ${match.user.name} wants`, match.iHaveTheyWant));
  wrap.appendChild(sides);

  const foot = document.createElement("div");
  foot.className = "match-foot";
  const cta = document.createElement("a");
  cta.className = "btn";
  cta.href = `#/trades/new/${encodeURIComponent(match.user.name)}`;
  cta.textContent = "Propose trade";
  foot.appendChild(cta);
  wrap.appendChild(foot);

  return wrap;
}

function makeMatchSide(title, cards) {
  const wrap = document.createElement("div");
  wrap.className = "match-side";
  const h = document.createElement("div");
  h.className = "match-side-title muted mono";
  h.textContent = title;
  wrap.appendChild(h);
  const list = document.createElement("div");
  list.className = "match-side-cards";
  cards.slice(0, 3).forEach(c => {
    const tile = document.createElement("div");
    tile.className = "match-tile";
    tile.title = `${c.name}${c.set?.name ? ` · ${c.set.name}` : ""}`;
    if (c.images?.small) {
      const img = document.createElement("img");
      img.src = c.images.small;
      img.alt = c.name || "";
      img.loading = "lazy";
      tile.appendChild(img);
    }
    list.appendChild(tile);
  });
  if (cards.length > 3) {
    const more = document.createElement("span");
    more.className = "match-tile-more muted mono";
    more.textContent = `+${cards.length - 3}`;
    list.appendChild(more);
  }
  wrap.appendChild(list);
  return wrap;
}

// ---- Render: Propose trade
function renderProposeTrade(otherUserName) {
  setActiveNav("trades");
  view.innerHTML = "";

  const me = profileStore.get();
  if (!me) { location.hash = "#/profile"; return; }

  const matches = buildTradeMatches(me);
  const match = matches.find(m => m.user.name === otherUserName);
  if (!match) {
    view.innerHTML = `<section class="stack"><a class="back" href="#/trades">&larr; All trades</a><p class="muted">No active match with ${otherUserName}. Add more cards to your collection or wishlist to discover trades.</p></section>`;
    return;
  }

  view.appendChild(tpl("tpl-propose-trade"));
  document.getElementById("propose-title").textContent = `Propose trade with ${match.user.name}`;
  const isLocal = match.user.location.toLowerCase() === me.location.toLowerCase();
  document.getElementById("propose-meta").textContent = `${match.user.location}${isLocal ? " · nearby" : ""}`;

  document.getElementById("propose-mine-help").textContent = "From your collection — pick one card to offer.";
  document.getElementById("propose-theirs-help").textContent = `From ${match.user.name}'s collection — pick one card to receive.`;

  const mineHost = document.getElementById("propose-mine");
  const theirsHost = document.getElementById("propose-theirs");
  match.iHaveTheyWant.forEach((c, i) => mineHost.appendChild(makeTradeCardOption("propose-mine", c, i === 0)));
  match.theyHaveIWant.forEach((c, i) => theirsHost.appendChild(makeTradeCardOption("propose-theirs", c, i === 0)));

  document.getElementById("propose-form").addEventListener("submit", e => {
    e.preventDefault();
    const mine = document.querySelector('input[name="propose-mine"]:checked');
    const theirs = document.querySelector('input[name="propose-theirs"]:checked');
    if (!mine || !theirs) return;
    const fromCard = match.iHaveTheyWant.find(c => c.id === mine.value);
    const toCard = match.theyHaveIWant.find(c => c.id === theirs.value);
    const trade = {
      id: uid("t"),
      fromUserName: me.name,
      fromUserLocation: me.location,
      toUserName: match.user.name,
      toUserLocation: match.user.location,
      fromCard: snapshotCard(fromCard),
      toCard: snapshotCard(toCard),
      status: "proposed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ sender: me.name, text: `Hi ${match.user.name} — interested in trading my ${fromCard.name} for your ${toCard.name}?`, ts: Date.now() }],
    };
    tradeStore.add(trade);
    location.hash = `#/trades/${trade.id}`;
  });
}

function makeTradeCardOption(group, card, defaultChecked) {
  const label = document.createElement("label");
  label.className = "trade-card-option";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = group;
  radio.value = card.id;
  if (defaultChecked) radio.checked = true;
  const thumb = document.createElement("span");
  thumb.className = "trade-card-thumb";
  if (card.images?.small) {
    const img = document.createElement("img");
    img.src = card.images.small;
    img.alt = card.name;
    img.loading = "lazy";
    thumb.appendChild(img);
  }
  const info = document.createElement("span");
  info.className = "trade-card-info";
  const nm = document.createElement("strong");
  nm.textContent = card.name;
  info.appendChild(nm);
  const sub = document.createElement("span");
  sub.className = "muted mono";
  sub.textContent = `${card.set?.name || "—"}${card.rarity ? ` · ${card.rarity}` : ""}`;
  info.appendChild(sub);
  label.appendChild(radio);
  label.appendChild(thumb);
  label.appendChild(info);
  return label;
}

// ---- Render: Trade detail
function renderTrade(id) {
  setActiveNav("trades");
  view.innerHTML = "";
  const trade = tradeStore.byId(id);
  if (!trade) {
    view.innerHTML = `<section class="stack"><a class="back" href="#/trades">&larr; All trades</a><p class="muted">Trade not found.</p></section>`;
    return;
  }
  view.appendChild(tpl("tpl-trade"));
  paintTradeDetail(id);
}

function paintTradeDetail(id) {
  const trade = tradeStore.byId(id);
  if (!trade) return;
  const me = profileStore.get();
  const isParticipant = !!(me && (trade.fromUserName === me.name || trade.toUserName === me.name));
  const isFromUser = me && trade.fromUserName === me.name;
  const other = tradeOtherParty(trade, me);
  const isLocal = me?.location && other.location && other.location.toLowerCase() === me.location.toLowerCase();

  document.getElementById("trade-title").textContent = isParticipant ? `Trade with ${other.name}` : `${trade.fromUserName} ↔ ${trade.toUserName}`;
  document.getElementById("trade-meta").textContent =
    `${other.location || ""}${isLocal ? " · nearby" : ""} · proposed ${relTime(trade.createdAt)}${trade.updatedAt !== trade.createdAt ? ` · updated ${relTime(trade.updatedAt)}` : ""}`;

  const status = document.getElementById("trade-status");
  status.className = `trade-status status-${trade.status}`;
  status.textContent = statusLabel(trade.status);

  // Cards
  const cardsHost = document.getElementById("trade-cards");
  cardsHost.innerHTML = "";
  const give = isFromUser ? trade.fromCard : trade.toCard;
  const get  = isFromUser ? trade.toCard   : trade.fromCard;
  const giveOwner = isParticipant ? "You" : trade.fromUserName;
  const getOwner  = isParticipant ? other.name : trade.toUserName;
  cardsHost.appendChild(makeTradeSideEl(`${giveOwner} give${isParticipant ? "" : "s"}`, give));
  cardsHost.appendChild(makeTradeSideEl(`${getOwner} give${isParticipant ? "s" : "s"}`, get));

  // Actions
  const actionsHost = document.getElementById("trade-actions");
  actionsHost.innerHTML = "";
  if (!me) {
    const note = document.createElement("p");
    note.className = "muted";
    note.innerHTML = `<a href="#/profile" class="link">Sign in</a> to message or respond to this trade.`;
    actionsHost.appendChild(note);
  } else if (isParticipant && trade.status === "proposed") {
    if (!isFromUser) {
      actionsHost.appendChild(makeActionButton("Accept trade", "btn", () => {
        tradeStore.update(trade.id, { status: "accepted" });
        tradeStore.addMessage(trade.id, me.name, "Accepted — let's set up the swap.");
        paintTradeDetail(id);
      }));
      actionsHost.appendChild(makeActionButton("Decline", "btn ghost", () => {
        tradeStore.update(trade.id, { status: "declined" });
        paintTradeDetail(id);
      }));
    } else {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = `Waiting on ${other.name} to respond.`;
      actionsHost.appendChild(note);
      actionsHost.appendChild(makeActionButton("Cancel proposal", "btn ghost", () => {
        tradeStore.update(trade.id, { status: "declined" });
        paintTradeDetail(id);
      }));
    }
  } else if (isParticipant && trade.status === "accepted") {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `Both parties agreed. Use messages below to coordinate the meet-up.`;
    actionsHost.appendChild(note);
  } else if (isParticipant && trade.status === "declined") {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `This trade was declined.`;
    actionsHost.appendChild(note);
  }

  const editHost = document.getElementById("trade-edit-host");
  editHost.innerHTML = "";
  if (isParticipant && trade.status !== "declined") {
    mountEditTrade(editHost, trade, isFromUser, () => paintTradeDetail(id));
  }

  // Messages
  paintTradeMessages(trade, me);

  // Message form
  const form = document.getElementById("trade-msg-form");
  if (!isParticipant || !me || trade.status === "declined") {
    form.classList.add("hidden");
  } else {
    form.classList.remove("hidden");
    form.onsubmit = e => {
      e.preventDefault();
      const inp = document.getElementById("trade-msg-input");
      const text = inp.value.trim();
      if (!text) return;
      tradeStore.addMessage(trade.id, me.name, text);
      inp.value = "";
      paintTradeDetail(id);
    };
  }
}

function makeActionButton(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function makeTradeSideEl(label, card) {
  const wrap = document.createElement("div");
  wrap.className = "trade-side";
  const head = document.createElement("div");
  head.className = "trade-side-head muted mono";
  head.textContent = label;
  wrap.appendChild(head);
  const art = document.createElement("div");
  art.className = "trade-side-art";
  if (card?.images?.large || card?.images?.small) {
    const img = document.createElement("img");
    img.src = card.images.large || card.images.small;
    img.alt = card.name || "";
    img.loading = "lazy";
    art.appendChild(img);
  }
  wrap.appendChild(art);
  const info = document.createElement("div");
  info.className = "trade-side-info";
  const name = document.createElement("strong");
  name.textContent = card?.name || "—";
  info.appendChild(name);
  const meta = document.createElement("div");
  meta.className = "muted mono";
  meta.textContent = [card?.set?.name, card?.rarity, card?.number ? `#${card.number}` : null].filter(Boolean).join(" · ");
  info.appendChild(meta);
  if (card?.hp) {
    const hp = document.createElement("div");
    hp.className = "muted mono";
    hp.textContent = `HP ${card.hp}`;
    info.appendChild(hp);
  }
  if (card?.artist) {
    const ar = document.createElement("div");
    ar.className = "muted mono";
    ar.textContent = `Art by ${card.artist}`;
    info.appendChild(ar);
  }
  wrap.appendChild(info);
  return wrap;
}

function paintTradeMessages(trade, me) {
  const host = document.getElementById("trade-messages");
  host.innerHTML = "";
  const msgs = trade.messages || [];
  if (!msgs.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No messages yet — say hi to coordinate the swap.";
    host.appendChild(empty);
    return;
  }
  msgs.forEach(m => {
    const isMine = me && m.sender === me.name;
    const div = document.createElement("div");
    div.className = `message ${isMine ? "message-mine" : "message-theirs"}`;
    const head = document.createElement("div");
    head.className = "message-head muted mono";
    head.textContent = `${m.sender} · ${relTime(m.ts)}`;
    div.appendChild(head);
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = m.text;
    div.appendChild(body);
    host.appendChild(div);
  });
}

function mountEditTrade(host, trade, isFromUser, onSaved) {
  host.appendChild(tpl("tpl-trade-edit"));
  const myCards = collectionCards.list();
  const currentMine = isFromUser ? trade.fromCard : trade.toCard;
  const currentTheirs = isFromUser ? trade.toCard : trade.fromCard;
  const theirCards = currentTheirs ? [currentTheirs] : [];

  const mineHost = document.getElementById("edit-mine");
  const theirsHost = document.getElementById("edit-theirs");

  if (!myCards.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Add cards to your collection to switch what you offer.";
    mineHost.appendChild(p);
  } else {
    myCards.forEach(c => mineHost.appendChild(makeTradeCardOption("edit-mine", c, c.id === currentMine?.id)));
  }
  if (!theirCards.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "The other side of this trade can't be changed.";
    theirsHost.appendChild(p);
  } else {
    theirCards.forEach(c => theirsHost.appendChild(makeTradeCardOption("edit-theirs", c, c.id === currentTheirs?.id)));
  }

  document.getElementById("trade-edit-form").addEventListener("submit", e => {
    e.preventDefault();
    const mine = document.querySelector('input[name="edit-mine"]:checked');
    const theirs = document.querySelector('input[name="edit-theirs"]:checked');
    if (!mine || !theirs) return;
    const newMine = myCards.find(c => c.id === mine.value);
    const newTheirs = theirCards.find(c => c.id === theirs.value);
    if (!newMine || !newTheirs) return;
    const patch = isFromUser
      ? { fromCard: snapshotCard(newMine), toCard: snapshotCard(newTheirs), status: "proposed" }
      : { fromCard: snapshotCard(newTheirs), toCard: snapshotCard(newMine), status: "proposed" };
    tradeStore.update(trade.id, patch);
    const me = profileStore.get();
    tradeStore.addMessage(trade.id, me.name, `Updated the trade — now offering ${newMine.name} for ${newTheirs.name}.`);
    onSaved && onSaved();
  });
}

// ---- Decks feature
const DECK_MAX_QTY = 4;

const deckStore = {
  list() { try { return JSON.parse(localStorage.getItem("decks")) || []; } catch { return []; } },
  save(arr) { localStorage.setItem("decks", JSON.stringify(arr)); refreshCounts(); },
  add(d) { const arr = this.list(); arr.unshift(d); this.save(arr); },
  byId(id) { return this.list().find(d => d.id === id); },
  update(id, patch) {
    const arr = this.list();
    const i = arr.findIndex(d => d.id === id);
    if (i < 0) return null;
    arr[i] = { ...arr[i], ...patch, updatedAt: Date.now() };
    this.save(arr);
    return arr[i];
  },
  remove(id) {
    const arr = this.list().filter(d => d.id !== id);
    this.save(arr);
  },
  forUser(name) { return this.list().filter(d => d.ownerName === name); },
};

function totalCardCount(deck) {
  return (deck.cards || []).reduce((s, c) => s + (c.quantity || 0), 0);
}

function addCardToDeck(deckId, card) {
  const deck = deckStore.byId(deckId);
  if (!deck) return;
  const cards = (deck.cards || []).slice();
  const i = cards.findIndex(c => c.cardId === card.id);
  if (i >= 0) {
    cards[i] = { ...cards[i], quantity: Math.min(DECK_MAX_QTY, cards[i].quantity + 1) };
  } else {
    cards.push({ cardId: card.id, quantity: 1, snapshot: snapshotCard(card) });
  }
  deckStore.update(deckId, { cards });
}

function updateDeckCardQuantity(deckId, cardId, quantity) {
  const deck = deckStore.byId(deckId);
  if (!deck) return;
  const cards = (deck.cards || []).slice();
  const i = cards.findIndex(c => c.cardId === cardId);
  if (i < 0) return;
  if (quantity <= 0) {
    cards.splice(i, 1);
  } else {
    cards[i] = { ...cards[i], quantity: Math.min(DECK_MAX_QTY, quantity) };
  }
  deckStore.update(deckId, { cards });
}

function downloadDeckPDF(deck) {
  const lib = window.jspdf;
  if (!lib || !lib.jsPDF) {
    alert("PDF library failed to load. Check your connection and try again.");
    return;
  }
  const { jsPDF } = lib;
  const doc = new jsPDF({ unit: "pt", format: "letter" });

  const left = 60;
  const right = 60;
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const wrapWidth = pageWidth - left - right;
  let y = 60;

  function ensureSpace(needed) {
    if (y + needed > pageHeight - 50) {
      doc.addPage();
      y = 60;
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(20);
  doc.text(deck.name || "Untitled deck", left, y);
  y += 28;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(120);
  const total = totalCardCount(deck);
  const meta = [
    `${total} card${total === 1 ? "" : "s"}`,
    deck.ownerName ? `by ${deck.ownerName}` : null,
    `created ${new Date(deck.createdAt).toLocaleDateString()}`,
  ].filter(Boolean).join("  ·  ");
  doc.text(meta, left, y);
  y += 18;

  if (deck.description) {
    doc.setTextColor(60);
    doc.setFontSize(11);
    const lines = doc.splitTextToSize(deck.description, wrapWidth);
    lines.forEach(line => {
      ensureSpace(16);
      doc.text(line, left, y);
      y += 14;
    });
    y += 6;
  }

  y += 6;
  doc.setDrawColor(220);
  doc.line(left, y, pageWidth - right, y);
  y += 22;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(20);
  doc.text("Cards", left, y);
  y += 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);

  const cards = deck.cards || [];
  if (!cards.length) {
    doc.setTextColor(120);
    doc.text("(empty deck)", left, y);
  } else {
    cards.forEach(c => {
      ensureSpace(18);
      const snap = c.snapshot || {};
      const setLabel = snap.set?.name || "";
      const numLabel = snap.number ? `#${snap.number}` : "";
      const setNum = [setLabel, numLabel].filter(Boolean).join(" ");
      const rarity = snap.rarity ? ` — ${snap.rarity}` : "";
      const line = `${c.quantity}× ${snap.name || c.cardId}${setNum ? `  (${setNum})` : ""}${rarity}`;
      doc.setTextColor(20);
      doc.text(line, left, y);
      y += 16;
    });
  }

  doc.setFontSize(9);
  doc.setTextColor(160);
  doc.text(`Generated by CardKave · ${new Date().toLocaleDateString()}`, left, pageHeight - 30);

  const safeName = (deck.name || "deck").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "deck";
  doc.save(`${safeName}.pdf`);
}

// ---- Render: Decks list
function renderDecks() {
  setActiveNav("decks");
  view.innerHTML = "";
  view.appendChild(tpl("tpl-decks"));

  const me = profileStore.get();
  const ctx = document.getElementById("decks-context");
  const newBtn = document.getElementById("new-deck-btn");
  const newHost = document.getElementById("new-deck-host");
  const listEl = document.getElementById("decks-list");
  const empty = document.getElementById("decks-empty");

  if (!me) {
    ctx.innerHTML = `<a href="#/profile" class="link">Set up your profile</a> to create decklists and download PDFs.`;
    empty.classList.remove("hidden");
    empty.textContent = "Sign in to start building decks.";
    newBtn.disabled = true;
    newBtn.classList.add("ghost");
    return;
  }

  const myDecks = deckStore.forUser(me.name);

  ctx.textContent = "Build, save, and export decklists as PDF.";

  newBtn.addEventListener("click", () => {
    if (newHost.firstChild) { newHost.innerHTML = ""; return; }
    newHost.appendChild(tpl("tpl-new-deck"));
    document.getElementById("nd-cancel").addEventListener("click", () => { newHost.innerHTML = ""; });
    document.getElementById("new-deck-form").addEventListener("submit", e => {
      e.preventDefault();
      const name = document.getElementById("nd-name").value.trim();
      const desc = document.getElementById("nd-desc").value.trim();
      if (!name) return;
      const d = {
        id: uid("d"),
        ownerName: me.name,
        ownerLocation: me.location,
        name, description: desc,
        cards: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      deckStore.add(d);
      location.hash = `#/decks/${d.id}`;
    });
  });

  if (!myDecks.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  myDecks.slice().sort((a, b) => b.updatedAt - a.updatedAt).forEach(d => listEl.appendChild(makeDeckCard(d)));
}

function makeDeckCard(d) {
  const wrap = document.createElement("a");
  wrap.className = "deck-card";
  wrap.href = `#/decks/${d.id}`;

  const titleRow = document.createElement("div");
  titleRow.className = "deck-title-row";
  const h3 = document.createElement("h3");
  h3.className = "deck-title";
  h3.textContent = d.name;
  titleRow.appendChild(h3);
  wrap.appendChild(titleRow);

  const sub = document.createElement("div");
  sub.className = "deck-sub muted mono";
  const total = totalCardCount(d);
  sub.textContent = `${total} card${total === 1 ? "" : "s"} · updated ${relTime(d.updatedAt)}`;
  wrap.appendChild(sub);

  if (d.description) {
    const desc = document.createElement("p");
    desc.className = "deck-card-desc";
    desc.textContent = d.description;
    wrap.appendChild(desc);
  }

  const thumbs = document.createElement("div");
  thumbs.className = "deck-thumbs";
  (d.cards || []).slice(0, 5).forEach(c => {
    const tile = document.createElement("div");
    tile.className = "deck-thumb";
    const url = c.snapshot?.images?.small;
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = c.snapshot?.name || "";
      img.loading = "lazy";
      tile.appendChild(img);
    }
    thumbs.appendChild(tile);
  });
  if (thumbs.children.length) wrap.appendChild(thumbs);

  return wrap;
}

// ---- Render: Deck detail
function renderDeck(id) {
  setActiveNav("decks");
  view.innerHTML = "";

  const deck = deckStore.byId(id);
  if (!deck) {
    view.innerHTML = `<section class="stack"><a class="back" href="#/decks">&larr; All decks</a><p class="muted">Deck not found.</p></section>`;
    return;
  }

  view.appendChild(tpl("tpl-deck"));
  paintDeckDetail(id);
}

function paintDeckDetail(id) {
  const deck = deckStore.byId(id);
  if (!deck) return;
  const me = profileStore.get();
  const isOwner = !!(me && me.name === deck.ownerName);

  document.getElementById("deck-name").textContent = deck.name;
  const total = totalCardCount(deck);
  const metaParts = [
    `by ${deck.ownerName}`,
    `created ${relTime(deck.createdAt)}`,
  ];
  if (deck.updatedAt !== deck.createdAt) metaParts.push(`updated ${relTime(deck.updatedAt)}`);
  document.getElementById("deck-meta").textContent = metaParts.join(" · ");

  const descEl = document.getElementById("deck-desc");
  if (deck.description) {
    descEl.textContent = deck.description;
    descEl.classList.remove("hidden");
  } else {
    descEl.classList.add("hidden");
  }

  document.getElementById("deck-count").textContent = `${total} card${total === 1 ? "" : "s"}`;

  const downloadBtn = document.getElementById("deck-download");
  downloadBtn.onclick = () => downloadDeckPDF(deck);

  const deleteBtn = document.getElementById("deck-delete");
  if (!isOwner) {
    deleteBtn.classList.add("hidden");
  } else {
    deleteBtn.classList.remove("hidden");
    deleteBtn.onclick = () => {
      if (confirm(`Delete "${deck.name}"? This can't be undone.`)) {
        deckStore.remove(id);
        location.hash = "#/decks";
      }
    };
  }

  const cardsHost = document.getElementById("deck-cards");
  const cardsEmpty = document.getElementById("deck-cards-empty");
  cardsHost.innerHTML = "";
  if (!(deck.cards || []).length) {
    cardsEmpty.classList.remove("hidden");
  } else {
    cardsEmpty.classList.add("hidden");
    deck.cards.forEach(c => cardsHost.appendChild(makeDeckCardRow(deck, c, isOwner)));
  }

  const poolHost = document.getElementById("deck-pool");
  const poolEmpty = document.getElementById("deck-pool-empty");
  const poolMeta = document.getElementById("deck-pool-meta");
  poolHost.innerHTML = "";

  if (!isOwner) {
    poolEmpty.textContent = "Only the deck owner can edit cards.";
    poolEmpty.classList.remove("hidden");
    poolMeta.textContent = "";
    return;
  }

  const colls = collectionCards.list();
  const wishs = wishlistCards.list();
  const seen = new Set();
  const pool = [];
  colls.forEach(c => { if (!seen.has(c.id)) { seen.add(c.id); pool.push({ source: "collection", card: c }); } });
  wishs.forEach(c => { if (!seen.has(c.id)) { seen.add(c.id); pool.push({ source: "wishlist", card: c }); } });

  if (!pool.length) {
    poolEmpty.innerHTML = `Add cards to your <a href="#/collection" class="link">collection</a> or <a href="#/wishlist" class="link">wishlist</a> to build your decklist.`;
    poolEmpty.classList.remove("hidden");
    poolMeta.textContent = "";
    return;
  }
  poolEmpty.classList.add("hidden");
  poolMeta.textContent = `${pool.length} card${pool.length === 1 ? "" : "s"} from your collection & wishlist`;

  pool.forEach(p => poolHost.appendChild(makePoolCardOption(deck, p.card, p.source)));
}

function makeDeckCardRow(deck, c, isOwner) {
  const wrap = document.createElement("div");
  wrap.className = "deck-card-row";

  const thumb = document.createElement("div");
  thumb.className = "deck-card-thumb";
  if (c.snapshot?.images?.small) {
    const img = document.createElement("img");
    img.src = c.snapshot.images.small;
    img.alt = c.snapshot.name || "";
    img.loading = "lazy";
    thumb.appendChild(img);
  }
  wrap.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "deck-card-info";
  const nm = document.createElement("strong");
  nm.textContent = c.snapshot?.name || c.cardId;
  info.appendChild(nm);
  const sub = document.createElement("div");
  sub.className = "muted mono";
  sub.textContent = [c.snapshot?.set?.name, c.snapshot?.rarity, c.snapshot?.number ? `#${c.snapshot.number}` : null].filter(Boolean).join(" · ") || "—";
  info.appendChild(sub);
  wrap.appendChild(info);

  if (isOwner) {
    const qty = document.createElement("div");
    qty.className = "deck-qty";
    const minus = document.createElement("button");
    minus.className = "qty-btn";
    minus.type = "button";
    minus.setAttribute("aria-label", "Decrease quantity");
    minus.textContent = "−";
    minus.onclick = () => {
      updateDeckCardQuantity(deck.id, c.cardId, c.quantity - 1);
      paintDeckDetail(deck.id);
    };
    const num = document.createElement("span");
    num.className = "qty-val";
    num.textContent = c.quantity;
    const plus = document.createElement("button");
    plus.className = "qty-btn";
    plus.type = "button";
    plus.setAttribute("aria-label", "Increase quantity");
    plus.textContent = "+";
    if (c.quantity >= DECK_MAX_QTY) plus.disabled = true;
    plus.onclick = () => {
      if (c.quantity >= DECK_MAX_QTY) return;
      updateDeckCardQuantity(deck.id, c.cardId, c.quantity + 1);
      paintDeckDetail(deck.id);
    };
    qty.appendChild(minus);
    qty.appendChild(num);
    qty.appendChild(plus);
    wrap.appendChild(qty);
  } else {
    const qty = document.createElement("span");
    qty.className = "deck-qty-static muted mono";
    qty.textContent = `×${c.quantity}`;
    wrap.appendChild(qty);
  }

  return wrap;
}

function makePoolCardOption(deck, card, source) {
  const wrap = document.createElement("div");
  wrap.className = "deck-pool-row";

  const thumb = document.createElement("div");
  thumb.className = "deck-card-thumb";
  if (card.images?.small) {
    const img = document.createElement("img");
    img.src = card.images.small;
    img.alt = card.name;
    img.loading = "lazy";
    thumb.appendChild(img);
  }
  wrap.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "deck-card-info";
  const nm = document.createElement("strong");
  nm.textContent = card.name;
  info.appendChild(nm);
  const sub = document.createElement("div");
  sub.className = "muted mono";
  const tag = source === "wishlist" ? "wishlist" : "collection";
  sub.textContent = `${card.set?.name || "—"} · from your ${tag}`;
  info.appendChild(sub);
  wrap.appendChild(info);

  const inDeck = (deck.cards || []).find(c => c.cardId === card.id);
  const btn = document.createElement("button");
  btn.type = "button";
  if (inDeck && inDeck.quantity >= DECK_MAX_QTY) {
    btn.className = "btn ghost";
    btn.textContent = `Max (×${DECK_MAX_QTY})`;
    btn.disabled = true;
  } else if (inDeck) {
    btn.className = "btn ghost";
    btn.textContent = `In deck (×${inDeck.quantity}) +`;
    btn.onclick = () => {
      addCardToDeck(deck.id, card);
      paintDeckDetail(deck.id);
    };
  } else {
    btn.className = "btn";
    btn.textContent = "Add";
    btn.onclick = () => {
      addCardToDeck(deck.id, card);
      paintDeckDetail(deck.id);
    };
  }
  wrap.appendChild(btn);

  return wrap;
}

// ---- Router
function route() {
  if (window.__cleanup) { window.__cleanup(); window.__cleanup = null; }
  window.scrollTo(0, 0);
  const authed = authStore.isAuthed();
  const hash = location.hash || (authed ? "#/browse" : "#/login");
  const parts = hash.replace(/^#\/?/, "").split("/");
  const [a, b, c] = parts;

  if (!authed && !isPublicRoute(parts)) {
    location.hash = "#/login";
    return;
  }
  if (authed && (a === "login" || a === "signup")) {
    location.hash = "#/browse";
    return;
  }

  const inAuth = a === "login" || a === "signup";
  document.body.classList.toggle("auth-mode", inAuth);
  document.documentElement.classList.toggle("auth-mode", inAuth);

  if (a === "login") return renderLogin();
  if (a === "signup") return renderSignup();
  if (a === "p" && b) return renderDetail(b);
  if (a === "sets" && b) return renderSet(b);
  if (a === "collection") return renderCollection();
  if (a === "wishlist") return renderCardWishlist();
  if (a === "feed") return renderFeed();
  if (a === "groups" && b) return renderGroup(b);
  if (a === "groups") return renderGroups();
  if (a === "events" && b) return renderEvent(b);
  if (a === "events") return renderEvents();
  if (a === "trades" && b === "new" && c) return renderProposeTrade(decodeURIComponent(c));
  if (a === "trades" && b) return renderTrade(b);
  if (a === "trades") return renderTrades();
  if (a === "decks" && b) return renderDeck(b);
  if (a === "decks") return renderDecks();
  if (a === "profile") return renderProfile();
  return renderBrowse();
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
  clearLegacySeedData();
  initEmailService();
  refreshCounts();
  refreshAuthUI();
  paintLastUpdated();
  const out = document.getElementById("nav-signout");
  if (out) out.addEventListener("click", () => logout());
  route();
});

function clearLegacySeedData() {
  if (localStorage.getItem("seed-data-cleared") === "1") return;
  ["feed-seeded", "feed-seeded-community", "events-seeded"].forEach(k => localStorage.removeItem(k));
  const groups = (() => { try { return JSON.parse(localStorage.getItem("feed-groups")) || []; } catch { return []; } })();
  const seededGroupNames = new Set([
    "Brooklyn TCG League", "Vintage Pulls", "Tokyo Collectors", "Berlin Trade Circle",
  ]);
  const filteredGroups = groups.filter(g => !seededGroupNames.has(g.name));
  localStorage.setItem("feed-groups", JSON.stringify(filteredGroups));

  const posts = (() => { try { return JSON.parse(localStorage.getItem("feed-posts")) || []; } catch { return []; } })();
  const seededAuthors = new Set(["Maya", "Hiro", "Lena", "Diego", "Sven", "Mira", "Jules"]);
  const filteredPosts = posts.filter(p => !seededAuthors.has(p.authorName));
  localStorage.setItem("feed-posts", JSON.stringify(filteredPosts));

  const events = (() => { try { return JSON.parse(localStorage.getItem("feed-events")) || []; } catch { return []; } })();
  const seededEventTitles = new Set([
    "Brooklyn TCG Trade Night", "Vintage Pulls Showcase", "Akihabara Card Shop Crawl",
  ]);
  const filteredEvents = events.filter(e => !seededEventTitles.has(e.title));
  localStorage.setItem("feed-events", JSON.stringify(filteredEvents));

  localStorage.setItem("seed-data-cleared", "1");
}

function paintLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  fetchJSON(`${DATA}/meta.json`)
    .then(meta => {
      if (!meta?.updated) return;
      const d = new Date(meta.updated);
      if (isNaN(d)) return;
      const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      el.textContent = `· data updated ${date} · ${meta.cards.toLocaleString()} cards`;
    })
    .catch(() => {});
}
