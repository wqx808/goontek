// Side panel controller.
//
// Each tab owns an <iframe>, created lazily and kept alive for the life of the
// tab, so switching tabs preserves scroll position and page state. Tab state
// lives in chrome.storage.session, which the browser discards on shutdown.

const $ = (id) => document.getElementById(id);

const stage = $("stage");
const empty = $("empty");
const urlInput = $("url");
const omni = $("omni");
const tabsEl = $("tabs");
const toastEl = $("toast");

const CONFIG_KEY = "goontek:config";
const SESSION_KEY = "goontek:session";

// Favourites are the only state that outlives a session: storage.local, on
// disk, untouched by hide. Mobile emulation and ad blocking have no settings;
// the service worker owns both.
let config = {
  volume: 1,
  muted: false,
  favourites: [],
  // A phone-width layout by default. See the width dropdown for why this,
  // rather than "auto", is what makes sites render the way they do on a phone.
  width: 390,
  theme: "system",
  accent: "",
  search: "duckduckgo",
  maxTabs: 8,
  scrubOnHide: true,
  adblock: true,
  ui: {}, // checkbox id -> false when that control is hidden
  keys: null, // filled from DEFAULT_KEYS on first run
};
let tabs = []; // [{ id, url }]
let activeId = null;
let visited = []; // URLs touched this session, for `clear history`
let nextId = 1;

/** id -> HTMLIFrameElement */
const frames = new Map();

init();

async function init() {
  const stored = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};
  config = { ...config, ...stored };
  // Merge rather than replace, so bindings added in a later version appear
  // instead of being missing for anyone with saved settings.
  config.keys = { ...DEFAULT_KEYS, ...(config.keys || {}) };

  const saved = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (saved) {
    tabs = saved.tabs || [];
    activeId = saved.activeId ?? null;
    visited = saved.visited || [];
    nextId = saved.nextId || tabs.length + 1;
  }
  if (tabs.length === 0) newTab({ focus: false });

  // The panel is running, so it is not collapsed. Clears the flag and any rail
  // left in a page when it was reopened by the toolbar icon or the shortcut.
  chrome.runtime.sendMessage({ type: "goontek:opened" }).catch(() => {});

  // Tell the worker which domains are already open, so its framing/UA rules
  // cover in-frame navigation even if it restarted and lost its in-memory set.
  const urls = tabs.map((t) => t.url).filter(Boolean);
  if (urls.length) {
    chrome.runtime.sendMessage({ type: "goontek:frame-domains", urls }).catch(() => {});
  }

  // A saved width from an older build may no longer be offered; snap it to the
  // nearest option so the control never renders blank.
  const widthOptions = [...$("width").options].map((o) => o.value);
  if (!widthOptions.includes(String(config.width))) {
    const n = Number(config.width);
    config.width = Number.isFinite(n)
      ? Number(
          widthOptions
            .filter((v) => v !== "auto")
            .reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best))
        )
      : "auto";
    saveConfig();
  }
  $("width").value = String(config.width);
  applyAppearance();
  renderVolume();
  renderFavourites();
  renderTabs();
  showActive();
  urlInput.focus();
}

// ---------------------------------------------------------------- tabs

function newTab({ url = "", focus = true } = {}) {
  if (tabs.length >= config.maxTabs) {
    toast(`Tab limit is ${config.maxTabs}`);
    return null;
  }
  const tab = { id: nextId++, url };
  tabs.push(tab);
  activeId = tab.id;
  if (url) {
    navigate(url);
  } else {
    saveSession();
    renderTabs();
    showActive();
  }
  if (focus) urlInput.focus();
  return tab;
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return;

  destroyFrame(id);
  tabs.splice(i, 1);

  if (activeId === id) {
    const next = tabs[i] || tabs[i - 1];
    activeId = next ? next.id : null;
  }
  if (tabs.length === 0) newTab({ focus: false });

  saveSession();
  renderTabs();
  showActive();
}

function activate(id) {
  activeId = id;
  saveSession();
  renderTabs();
  showActive();
}

function activeTab() {
  return tabs.find((t) => t.id === activeId) || null;
}

function renderTabs() {
  tabsEl.textContent = "";
  for (const tab of tabs) {
    // The wrapper is decoration. `role="tab"` belongs on the focusable button,
    // and a tab may not contain other interactive elements, so the close button
    // sits beside it rather than inside it.
    const el = document.createElement("div");
    el.className = "tab";
    el.dataset.selected = String(tab.id === activeId);

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab-label";
    label.setAttribute("role", "tab");
    label.setAttribute("aria-selected", String(tab.id === activeId));
    // Roving tabindex: one stop for the whole strip, arrows move between tabs.
    label.tabIndex = tab.id === activeId ? 0 : -1;
    label.textContent = tab.url ? hostLabel(tab.url) : "new tab";
    label.title = tab.url || "Empty tab";
    label.addEventListener("click", () => activate(tab.id));

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${label.textContent}`);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    el.append(label, close);
    tabsEl.appendChild(el);
  }
}

// Left/right move along the strip, as in a real tab bar. Ctrl+1..8 still jumps
// directly, but nothing advertises it, so arrows are what most people try.
tabsEl.addEventListener("keydown", (e) => {
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!step || tabs.length < 2) return;
  e.preventDefault();
  const i = tabs.findIndex((t) => t.id === activeId);
  const next = tabs[(i + step + tabs.length) % tabs.length];
  activate(next.id);
  tabsEl.querySelector('[aria-selected="true"]')?.focus();
});

// ------------------------------------------------------------- frames

function frameFor(tab) {
  let frame = frames.get(tab.id);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "frame";
    frame.title = "goontek panel content";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute(
      "sandbox",
      "allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    );
    // Without this a video player's fullscreen button does nothing: the
    // Permissions Policy for fullscreen is not delegated to a frame by default.
    frame.setAttribute(
      "allow",
      "fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write"
    );
    frame.allowFullscreen = true;
    const id = tab.id;
    frame.addEventListener("load", () => {
      // Media state resets on every navigation.
      pushVolume(frame);
      // So does layout. This fires for navigations *inside* the frame too,
      // which the panel otherwise never hears about.
      // Either way, a measurement from the previous page must not carry over.
      fits.delete(id);
      if (config.width === "auto") {
        // Auto waits for the page to report an overflow before doing anything.
        clearFit(frame);
      } else {
        // An explicit width applies immediately, whether or not the page
        // overflows, which is the whole point of forcing a phone width.
        applyFit(id);
      }
    });
    frames.set(tab.id, frame);
    stage.appendChild(frame);
  }
  return frame;
}

function destroyFrame(id) {
  const frame = frames.get(id);
  if (frame) {
    frame.src = "about:blank";
    frame.remove();
    frames.delete(id);
  }
  fits.delete(id);
  navHistory.delete(id);
}

// ------------------------------------------------------------ fit width

// Sites with a hard minimum width overflow a narrow panel. When a framed
// document reports needing more room than it has, lay the frame out at that
// width and scale it down so the whole page stays visible.
//
// Only the first overflowing report per navigation is honoured; re-fitting on
// later reports would measure an already-scaled frame and oscillate.
const fits = new Map(); // tab id -> required CSS width

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.source !== "goontek") return;

  let id = null;
  for (const [tabId, frame] of frames) {
    if (frame.contentWindow === event.source) {
      id = tabId;
      break;
    }
  }
  if (id === null) return;

  if (msg.type === "fit") {
    const required = Number(msg.required);
    if (!Number.isFinite(required) || required < 200) return;
    const prev = fits.get(id) || 0;
    // Take the first report, or a substantially larger one. A large jump means
    // the page genuinely grew (typically a site switching itself to a desktop
    // layout after load), which we do want to react to. Small changes are
    // re-measurement wobble and are ignored, so the fit does not oscillate.
    if (prev && required <= prev * 1.25) return;
    fits.set(id, required);
    applyFit(id);
  } else if (msg.type === "located") {
    recordVisit(id, msg.url);
  } else if (msg.type === "cleared") {
    const c = msg.cleared || {};
    const n = (c.cookies?.length || 0) + (c.storage?.length || 0);
    toast(n ? `Cleared ${n}, reloading…` : "No desktop preference found");
  } else if (msg.type === "fullscreen") {
    const frame = frames.get(id);
    if (!frame) return;
    if (msg.on) clearFit(frame);
    else applyFit(id);
  }
});

/** The width to lay the page out at: an explicit choice, or what it measured. */
function targetWidth(id) {
  if (config.width === "auto") return fits.get(id) || 0;

  const forced = Number(config.width);
  const reported = fits.get(id) || 0;
  // Phone mode normally pins the layout to the forced width. But if the page
  // turns out dramatically wider (a site that switched itself to a desktop
  // layout after load, defeating the narrow viewport), fit that real width
  // instead of clipping it. The page is then all visible, just small, which
  // beats a cropped column with a horizontal scrollbar.
  if (reported > forced * 1.8) return reported;
  return forced;
}

/**
 * `box` lets a caller fitting several frames measure the stage once. Reading
 * clientWidth after writing a frame's zoom forces a synchronous layout, so a
 * loop that re-measures per frame pays for a relayout per frame.
 */
function applyFit(id, box) {
  const frame = frames.get(id);
  if (!frame) return;

  const target = targetWidth(id);
  const width = box ? box.width : stage.clientWidth;
  const height = box ? box.height : stage.clientHeight;

  // On auto, leave pages that already fit alone rather than scaling them.
  if (!target || !width || (config.width === "auto" && target <= width + 8)) {
    clearFit(frame);
    return;
  }

  const scale = width / target;
  frame.style.width = `${target}px`;
  frame.style.height = `${Math.ceil(height / scale)}px`;
  // `zoom`, not `transform: scale()`. Two reasons: zoom re-rasterises at the
  // target size so scaling up (phone mode) stays sharp instead of blurring,
  // and it creates no transformed ancestor, which is what breaks a video's
  // fullscreen inside the frame.
  frame.style.zoom = String(scale);
}

function applyFitAll() {
  const box = { width: stage.clientWidth, height: stage.clientHeight };
  for (const id of frames.keys()) applyFit(id, box);
}

$("width").addEventListener("change", (e) => {
  config.width = e.target.value === "auto" ? "auto" : Number(e.target.value);
  saveConfig();
  applyFitAll();
  toast(config.width === "auto" ? "Width: auto" : `Width: ${config.width}px`);
});

function clearFit(frame) {
  frame.style.width = "";
  frame.style.height = "";
  frame.style.zoom = "";
}

// -------------------------------------------------------- back / forward

// Per-tab history, built from what the framed documents report. The panel
// cannot read a cross-origin frame's own history, so this is the only way to
// offer back and forward across navigations the user makes inside the page.
const navHistory = new Map(); // tab id -> { stack: string[], index: number, expect: string|null }

function historyFor(id) {
  let h = navHistory.get(id);
  if (!h) {
    h = { stack: [], index: -1, expect: null };
    navHistory.set(id, h);
  }
  return h;
}

function recordVisit(id, url) {
  if (typeof url !== "string" || url === "about:blank") return;

  // Keep the tab's own URL, the address bar, tab label, and favourite star in
  // sync with where the frame actually is; the frame navigates itself on link
  // clicks, and the panel only learns the new URL from this report.
  const tab = tabs.find((t) => t.id === id);
  if (tab && tab.url !== url) {
    tab.url = url;
    if (id === activeId) {
      urlInput.value = url;
      renderFavStar();
    }
    renderTabs();
    saveSession();
  }

  const h = historyFor(id);

  // A visit we caused by going back or forward is already in the stack.
  if (h.expect === url) {
    h.expect = null;
    renderNav();
    return;
  }
  if (h.stack[h.index] === url) return;

  h.stack.splice(h.index + 1); // moving somewhere new drops the forward entries
  h.stack.push(url);
  h.index = h.stack.length - 1;
  renderNav();
}

function go(delta) {
  const tab = activeTab();
  if (!tab) return;
  const h = historyFor(tab.id);
  const next = h.index + delta;
  if (next < 0 || next >= h.stack.length) return;

  h.index = next;
  h.expect = h.stack[next];
  tab.url = h.stack[next];

  const frame = frameFor(tab);
  fits.delete(tab.id);
  clearFit(frame);
  frame.src = h.stack[next];

  saveSession();
  renderTabs();
  showActive();
}

function renderNav() {
  const tab = activeTab();
  const h = tab ? historyFor(tab.id) : { stack: [], index: -1 };
  $("back").disabled = h.index <= 0;
  $("forward").disabled = h.index < 0 || h.index >= h.stack.length - 1;
}

$("back").addEventListener("click", () => go(-1));
$("forward").addEventListener("click", () => go(1));

// The panel is user-resizable, so a scaled frame has to be rescaled with it.
// Dragging the panel edge fires this continuously, and each pass rewrites every
// frame's zoom, which relayouts the framed document. One pass per frame painted
// is enough.
let fitFrame = 0;
new ResizeObserver(() => {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    applyFitAll();
  });
}).observe(stage);

/** Show only the active tab's frame; show the empty state if it has no URL. */
function showActive() {
  const tab = activeTab();

  // Frames are DOM, so they do not survive the panel closing, but the tab list
  // does. Rebuild the active tab's frame on demand, or reopening the panel
  // after a hide shows its URL in the address bar above an empty stage.
  if (tab?.url && !frames.has(tab.id)) {
    const frame = frameFor(tab);
    frame.src = tab.url;
  }

  for (const [id, frame] of frames) {
    frame.classList.toggle("visible", tab != null && id === tab.id);
  }
  const blank = !tab || !tab.url;
  empty.classList.toggle("hidden", !blank);
  urlInput.value = tab?.url || "";
  renderFavStar();
  renderNav();
}

// --------------------------------------------------------- favourites

function favIndex(url) {
  return config.favourites.findIndex((f) => f.url === url);
}

function renderFavStar() {
  const url = activeTab()?.url || "";
  const saved = Boolean(url) && favIndex(url) !== -1;
  const btn = $("fav");
  btn.textContent = saved ? "★" : "☆";
  btn.setAttribute("aria-pressed", String(saved));
  btn.title = saved ? "Remove from favourites (Ctrl+D)" : "Add to favourites (Ctrl+D)";
  btn.disabled = !url;
}

// The list drops from the address bar rather than holding a row open all the
// time. Two ways in, because focusing the address bar is not discoverable on
// its own: the star in the utility row opens it whenever you want it.
function showFavourites(on) {
  const show = on && config.favourites.length > 0;
  $("favpop").hidden = !show;
  $("favlist").setAttribute("aria-expanded", String(show));
  $("favlist").classList.toggle("open", show);
}

$("favlist").addEventListener("click", () => showFavourites($("favpop").hidden));

urlInput.addEventListener("focus", () => showFavourites(true));
urlInput.addEventListener("input", () => showFavourites(urlInput.value === ""));
// Deferred: a click on a favourite blurs the input before its own handler runs.
// Skipped when the star is what took focus, or it would close on its own click.
urlInput.addEventListener("blur", () =>
  setTimeout(() => {
    if (document.activeElement !== $("favlist")) showFavourites(false);
  }, 120)
);

// Anywhere else in the panel closes it.
document.addEventListener("pointerdown", (e) => {
  if ($("favpop").hidden) return;
  if (e.target.closest("#favpop, #favlist, #url")) return;
  showFavourites(false);
});

function renderFavourites() {
  // Nothing to list, nothing to open.
  $("favlist").hidden = config.favourites.length === 0;

  const wrap = $("favs");
  wrap.textContent = "";
  for (const fav of config.favourites) {
    const el = document.createElement("div");
    el.className = "fav";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "fav-label";
    open.textContent = fav.name;
    open.title = `${fav.url}\nClick to open, shift-click for a new tab`;
    open.addEventListener("click", (e) => {
      if (e.shiftKey) newTab({ url: fav.url });
      else navigate(fav.url);
      showFavourites(false);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "fav-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${fav.name} from favourites`);
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      const i = favIndex(fav.url);
      if (i !== -1) config.favourites.splice(i, 1);
      await saveConfig();
      renderFavourites();
      renderFavStar();
      toast("Removed from favourites");
      showFavourites(config.favourites.length > 0);
    });

    el.append(open, remove);
    wrap.appendChild(el);
  }

  renderFavGrid();
}

/**
 * The same favourites, laid out for an empty tab. A new tab is the moment you
 * are most likely to want one, and the stage is otherwise doing nothing.
 */
function renderFavGrid() {
  const grid = $("favgrid");
  grid.textContent = "";
  for (const fav of config.favourites) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "favtile";
    open.textContent = fav.name;
    open.title = fav.url;
    open.addEventListener("click", () => navigate(fav.url));
    grid.appendChild(open);
  }
}

async function toggleFavourite() {
  const url = activeTab()?.url;
  if (!url) {
    toast("Nothing to favourite");
    return;
  }
  const i = favIndex(url);
  if (i === -1) {
    config.favourites.push({ name: hostLabel(url), url });
    toast("Added to favourites");
  } else {
    config.favourites.splice(i, 1);
    toast("Removed from favourites");
  }
  await saveConfig();
  renderFavourites();
  renderFavStar();
}

$("fav").addEventListener("click", toggleFavourite);

// --------------------------------------------------------- navigation

omni.addEventListener("submit", (e) => {
  e.preventDefault();
  const target = normalize(urlInput.value.trim());
  if (target) navigate(target);
});

function normalize(raw) {
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  // A hostname: dot-separated labels ending in an alphabetic TLD, with an
  // optional port and path. Requiring a real TLD keeps "1.5" and "notes.txt"
  // out, which a bare "contains a dot" test promoted to bogus URLs.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/[^\s]*)?$/i.test(raw)) {
    return "https://" + raw;
  }
  // localhost has no dot, and does not serve https by default.
  if (/^localhost(:\d+)?(\/[^\s]*)?$/i.test(raw)) return "http://" + raw;
  // A LAN address has no TLD to match on, so it would otherwise be searched for.
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/[^\s]*)?$/.test(raw)) return "http://" + raw;
  const engine = SEARCH_ENGINES[config.search] || SEARCH_ENGINES.duckduckgo;
  return engine + encodeURIComponent(raw);
}

function navigate(url) {
  const tab = activeTab() || newTab({ focus: false });
  if (!tab) return;
  tab.url = url;

  const frame = frameFor(tab);
  // A new document measures its own width from scratch.
  fits.delete(tab.id);
  clearFit(frame);
  frame.src = url;

  if (!visited.includes(url)) visited.push(url);

  saveSession();
  renderTabs();
  showActive();

  // Iframe navigations should not reach chrome://history, but scrub anyway in
  // case the URL arrived through the omnibox.
  chrome.runtime.sendMessage({ type: "goontek:visited", url }).catch(() => {});
}

// Safari's "Request Mobile Website", for sites that serve desktop because of a
// stored preference rather than the viewport. Clears that site's own preference
// cookies/storage (from inside the frame, no cookie permission), then reloads.
function requestMobileSite() {
  const tab = activeTab();
  const frame = tab && frames.get(tab.id);
  if (!frame || !tab.url) {
    toast("Nothing loaded");
    return;
  }
  try {
    frame.contentWindow?.postMessage({ source: "goontek", type: "clearPrefs" }, "*");
  } catch {}
  // Give the frame a moment to clear before the reload takes effect.
  setTimeout(() => {
    fits.delete(tab.id);
    clearFit(frame);
    frame.src = "about:blank";
    frame.src = tab.url;
  }, 80);
}

function reload() {
  const tab = activeTab();
  if (!tab?.url) return;
  const frame = frames.get(tab.id);
  if (frame) {
    fits.delete(tab.id);
    clearFit(frame);
    // Reassigning src is the only reload available for a cross-origin frame.
    frame.src = "about:blank";
    frame.src = tab.url;
  } else {
    navigate(tab.url);
  }
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 18);
  }
}

// ------------------------------------------------------------- volume

function pushVolume(frame) {
  const value = config.muted ? 0 : config.volume;
  try {
    frame.contentWindow?.postMessage(
      { source: "goontek", type: "volume", value, muted: config.muted },
      "*"
    );
  } catch {
    // Frame not ready or already torn down.
  }
}

function pushVolumeAll() {
  for (const frame of frames.values()) pushVolume(frame);
}

function renderVolume() {
  const pct = Math.round(config.volume * 100);
  const slider = $("vol");
  slider.value = String(pct);
  // Drives the filled portion of the track via CSS.
  slider.style.setProperty("--fill", `${config.muted ? 0 : pct}%`);

  const wrap = $("volwrap");
  wrap.dataset.level = config.muted || pct === 0 ? "mute" : pct < 50 ? "low" : "high";

  const mute = $("mute");
  mute.setAttribute("aria-pressed", String(config.muted || pct === 0));
  mute.title = config.muted ? "Unmute" : `Mute (${pct}%)`;
}

$("vol").addEventListener("input", (e) => {
  config.volume = Number(e.target.value) / 100;
  config.muted = false;
  renderVolume();
  pushVolumeAll();
});

$("vol").addEventListener("change", saveConfig);

$("mute").addEventListener("click", () => {
  config.muted = !config.muted;
  renderVolume();
  pushVolumeAll();
  saveConfig();
});

// ------------------------------------------------------- other controls

$("newtab").addEventListener("click", () => newTab());
$("refresh").addEventListener("click", reload);


$("clear").addEventListener("click", async () => {
  if (visited.length === 0) {
    toast("Nothing to clear");
    return;
  }
  const res = await chrome.runtime
    .sendMessage({ type: "goontek:clear-history", urls: visited })
    .catch(() => null);
  const n = res?.count ?? visited.length;
  visited = [];
  saveSession();
  toast(`Cleared ${n} ${n === 1 ? "entry" : "entries"}`);
});

$("panic").addEventListener("click", () => collapse());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "goontek:panic") collapse();
});

/**
 * Close the panel and leave a rail in the page to bring it back.
 *
 * Nothing is merely covered. The panel document is destroyed, which stops every
 * frame outright and gives the page its width back. Tabs live in session
 * storage, so opening the panel again restores them; history is scrubbed first
 * because it is the only trace that would outlive the panel.
 */
let collapsing = false;
async function collapse() {
  if (collapsing) return;
  collapsing = true;

  // Silence first. Closing kills the frames anyway, but a page that has already
  // opened Picture-in-Picture keeps playing outside the panel.
  for (const frame of frames.values()) {
    try {
      frame.contentWindow?.postMessage({ source: "goontek", type: "pause" }, "*");
    } catch {}
  }

  if (config.scrubOnHide !== false && visited.length) {
    await chrome.runtime
      .sendMessage({ type: "goontek:clear-history", urls: visited })
      .catch(() => {});
    visited = [];
    await saveSession();
  }

  // Draw the rail before closing: after window.close() nothing here runs.
  await chrome.runtime.sendMessage({ type: "goontek:collapse" }).catch(() => {});
  window.close();
}

// ------------------------------------------------------------ settings

// icons/donate-qr.png encodes exactly this string; regenerate it if this changes.
const SOLANA_WALLET = "3B3cxY82ZmeED45Bqt4XBk7cucKiBZ9moqnPaayw6Fv5";
const BUG_URL = "https://github.com/wqx808/goontek/issues/new";

const SEARCH_ENGINES = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  brave: "https://search.brave.com/search?q=",
  startpage: "https://www.startpage.com/sp/search?query=",
};

const ACCENTS = [
  ["neutral", ""],
  ["orange", "#f97316"],
  ["blue", "#3b82f6"],
  ["green", "#3f9d5c"],
  ["violet", "#8b5cf6"],
  ["red", "#dc4a3d"],
];

// Each toggle hides every element belonging to that feature. Favourites owns
// both the saved list and the star that adds to it; hiding one without the
// other leaves a control that acts on something invisible.
const UI_KEYS = {
  uiFavourites: ["favpop", "favlist", "favgrid", "fav"],
  uiVolume: ["volwrap"],
  uiWidth: ["width"],
  uiClear: ["clear"],
  uiHide: ["panic"],
};

function applyAppearance() {
  const root = document.documentElement;
  if (config.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", config.theme);

  if (config.accent) root.style.setProperty("--accent", config.accent);
  else root.style.removeProperty("--accent");

  for (const [checkboxId, elementIds] of Object.entries(UI_KEYS)) {
    const off = config.ui?.[checkboxId] === false;
    for (const elementId of elementIds) {
      const el = $(elementId);
      if (el) el.classList.toggle("ui-off", off);
    }
  }
}

function renderSettings() {
  $("setTheme").value = config.theme;
  $("setMaxTabs").value = String(config.maxTabs);
  $("setSearch").value = config.search;
  $("setScrubOnHide").checked = config.scrubOnHide !== false;
  $("setAdblock").checked = config.adblock !== false;
  renderKeys();

  for (const id of Object.keys(UI_KEYS)) {
    $(id).checked = config.ui?.[id] !== false;
  }

  const wrap = $("swatches");
  wrap.textContent = "";
  for (const [name, value] of ACCENTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.title = name;
    b.setAttribute("aria-label", name);
    b.setAttribute("aria-pressed", String((config.accent || "") === value));
    if (value) b.style.background = value;
    else b.classList.add("swatch-neutral");
    b.addEventListener("click", () => {
      config.accent = value;
      saveConfig();
      applyAppearance();
      renderSettings();
    });
    wrap.appendChild(b);
  }
}

function openSettings() {
  renderSettings();
  $("settingsPanel").hidden = false;
}

$("settings").addEventListener("click", openSettings);

function renderKeys() {
  const wrap = $("keys");
  wrap.textContent = "";
  for (const [action, { label }] of Object.entries(ACTIONS)) {
    const row = document.createElement("div");
    row.className = "row";

    const name = document.createElement("span");
    name.textContent = label;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "keybind";
    btn.textContent = capturing === action ? "press keys…" : config.keys[action] || "unset";
    btn.classList.toggle("capturing", capturing === action);
    btn.title = "Click, then press the combination. Escape cancels.";
    btn.addEventListener("click", () => {
      capturing = action;
      renderKeys();
    });

    row.append(name, btn);
    wrap.appendChild(row);
  }
}

$("resetKeys").addEventListener("click", () => {
  config.keys = { ...DEFAULT_KEYS };
  saveConfig();
  renderKeys();
  toast("Shortcuts reset");
});

// The two global hotkeys are browser-level commands. Extensions cannot rebind
// them; only Chrome's own shortcuts page can.
$("browserKeys").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
$("settingsClose").addEventListener("click", () => {
  $("settingsPanel").hidden = true;
});

$("setTheme").addEventListener("change", (e) => {
  config.theme = e.target.value;
  saveConfig();
  applyAppearance();
});

$("setMaxTabs").addEventListener("change", (e) => {
  config.maxTabs = Number(e.target.value);
  saveConfig();
});

$("setSearch").addEventListener("change", (e) => {
  config.search = e.target.value;
  saveConfig();
});

$("setScrubOnHide").addEventListener("change", (e) => {
  config.scrubOnHide = e.target.checked;
  saveConfig();
});

$("setAdblock").addEventListener("change", async (e) => {
  config.adblock = e.target.checked;
  await saveConfig();
  await chrome.runtime.sendMessage({ type: "goontek:sync" }).catch(() => {});
  toast(config.adblock ? "Ad blocking on" : "Ad blocking off");
});

for (const id of Object.keys(UI_KEYS)) {
  $(id).addEventListener("change", (e) => {
    config.ui = { ...config.ui, [id]: e.target.checked };
    saveConfig();
    applyAppearance();
  });
}

$("reqMobile").addEventListener("click", () => {
  $("settingsPanel").hidden = true;
  requestMobileSite();
});

$("openTab").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab?.url) {
    toast("Nothing loaded");
    return;
  }
  chrome.tabs.create({ url: tab.url });
});

$("showDiag").addEventListener("click", () => {
  $("settingsPanel").hidden = true;
  diagnose();
});

$("reportBug").addEventListener("click", () => newTab({ url: BUG_URL }));

$("donate").addEventListener("click", () => {
  if (!SOLANA_WALLET) {
    toast("No wallet configured yet");
    return;
  }
  $("wallet").textContent = SOLANA_WALLET;
  const img = $("qrImg");
  if (!img.getAttribute("src")) img.src = "../icons/donate-qr.png";
  // Sits above the settings sheet, so the QR is not competing with a long
  // scrolling list behind it.
  $("donateBox").hidden = false;
});

function closeDonate() {
  $("donateBox").hidden = true;
}

$("qrClose").addEventListener("click", closeDonate);
// Clicking the dimmed area dismisses, but not clicks inside the card.
$("donateBox").addEventListener("click", (e) => {
  if (e.target === $("donateBox")) closeDonate();
});

$("copyWallet").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(SOLANA_WALLET);
    toast("Address copied");
  } catch {
    toast("Could not copy");
  }
});

// -------------------------------------------------------- diagnostics

// Ctrl+Shift+D. Answers, for the frame you are looking at: did the content
// scripts register, did they run in this frame, did the main-world mobile
// patch apply, and is the document wider than the panel.
/** Resolve `p`, but never wait longer than `ms`; a stalled service worker or
 *  frame must not leave the panel hanging with nothing shown. */
function withTimeout(p, ms, fallback) {
  return Promise.race([
    Promise.resolve(p).catch((e) => ({ __err: e?.message || String(e) })),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

async function diagnose() {
  // Show the panel first, so a click always does something visible even if the
  // data collection below stalls.
  $("diagbody").textContent = "Collecting…";
  $("diag").hidden = false;

  const lines = [];
  const bg =
    (await withTimeout(
      chrome.runtime.sendMessage({ type: "goontek:diagnose" }),
      1500,
      { errors: ["service worker did not respond in time"] }
    )) || {};
  if (bg.__err) bg.errors = [`service worker: ${bg.__err}`];

  lines.push(`extension id   ${bg.id || "?"}`);
  lines.push(`dynamic rules  ${bg.rules?.length ? bg.rules.join(", ") : "NONE"}`);
  if (bg.ruleConditions?.length) {
    for (const c of bg.ruleConditions) lines.push(`  ${c}`);
  }
  lines.push(`panel domains  ${bg.panelDomains?.length ? bg.panelDomains.join(", ") : "(none)"}`);
  lines.push(`blocklist      ${bg.blocklist ?? "?"} domains`);
  lines.push("content scripts");
  if (bg.scripts?.length) for (const s of bg.scripts) lines.push(`  ${s}`);
  else lines.push("  NONE REGISTERED");

  const tab = activeTab();
  lines.push("");
  if (!tab?.url) {
    lines.push("active frame   (nothing loaded)");
  } else {
    const pong = await withTimeout(pingActiveFrame(), 1500, null);
    if (!pong || pong.__err) {
      const domain = (() => {
        try {
          return new URL(tab.url).hostname;
        } catch {
          return "";
        }
      })();
      const covered = (bg.panelDomains || []).some((d) => domain.endsWith(d));
      lines.push("active frame   NO RESPONSE");
      lines.push(`  intended url ${tab.url}`);
      lines.push("  Most likely the frame is showing a browser error page");
      lines.push("  (\"refused to connect\"), where content scripts cannot run.");
      lines.push("  That means the framing headers were not stripped for this");
      lines.push("  request, not that the content script is broken.");
      lines.push(`  domain covered by framing rule: ${covered ? "yes" : "NO"}`);
      if (!covered) {
        lines.push("  -> the site's domain is missing from the rule; reload the");
        lines.push("     page from the address bar to register it.");
      }
    } else {
      const frame = frames.get(tab.id);
      lines.push(`active frame   ${pong.url}`);
      lines.push(`  ready        ${pong.readyState}`);
      lines.push("");
      lines.push("  -- what the panel applied --");
      lines.push(`  width setting  ${config.width}`);
      lines.push(`  frame css w    ${frame?.style.width || "(none)"}`);
      lines.push(`  frame zoom     ${frame?.style.zoom || "(none)"}`);
      lines.push(`  fit recorded   ${fits.has(tab.id) ? `${fits.get(tab.id)}px` : "no"}`);
      lines.push("");
      const mw = pong.mainWorld;
      lines.push("  -- what the SITE sees (main world) --");
      lines.push(`  main patch   ${pong.mobilePatched ? "applied" : "DID NOT RUN"}`);
      lines.push(`  fullscreen api ${pong.fsPatched ? "intercepted" : "NOT PATCHED"}`);
      lines.push(`  theater open ${pong.inTheater}`);
      if (mw) {
        lines.push(`  UA           ${mw.ua}`);
        lines.push(`  platform     ${mw.platform}`);
        lines.push(`  touchPoints  ${mw.touch}`);
        lines.push(`  userAgentData ${mw.uaData}`);
        lines.push(`  screen       ${mw.screen}`);
        lines.push(`  dpr          ${mw.dpr}`);
      } else {
        lines.push("  (not recorded: main-world script did not run here)");
      }
      lines.push("");
      lines.push("  -- extension's own context (always the real browser) --");
      lines.push(`  UA           ${pong.seenUA || "?"}`);
      lines.push("  ^ expected to show your real desktop browser; an isolated");
      lines.push("    content script has its own navigator and cannot see the");
      lines.push("    main-world patch. Judge the spoof by the block above.");
      lines.push(`  innerWidth   ${pong.innerWidth}`);
      lines.push(`  scrollWidth  ${pong.scrollWidth}`);
      lines.push(`  viewport meta ${pong.viewport || "(none)"}`);
      lines.push(`  pointer:coarse ${pong.coarsePointer}`);
      lines.push(`  mq<=600px    ${pong.mqMobile600}`);
      lines.push(`  has cookies  ${pong.hasCookies}`);
      lines.push(`  cookies stored ${pong.cookieCount ?? "?"}`);
      lines.push(`  normal cookie (SameSite=Lax) ${pong.cookieLax}`);
      lines.push(`  cross-site cookie (SameSite=None) ${pong.cookieNone}`);
      lines.push(`  can use storage ${pong.storageWritable}`);
      if (pong.cookieLax === false) {
        lines.push("  ^ THIS is why an age gate or consent banner keeps");
        lines.push("    returning. The panel embeds sites cross-site, and the");
        lines.push("    browser is refusing ordinary cookies here, so the site");
        lines.push("    cannot record that you accepted. Allow third-party");
        lines.push("    cookies for this site, or open it in a browser tab.");
      }
      if (pong.cookieNames?.length) {
        lines.push("  cookie names");
        for (const n of pong.cookieNames) lines.push(`    ${n}`);
      }
      const over = pong.scrollWidth - pong.innerWidth;
      lines.push(`  overflow     ${over > 8 ? `${over}px WIDER than viewport` : "none"}`);
      lines.push("");
      lines.push("  -- verdict --");
      const iphone = /iPhone/.test(mw?.ua || "");
      if (iphone && pong.innerWidth <= 430 && over > 8) {
        lines.push("  Site sees an iPhone UA and a ~phone viewport but still");
        lines.push("  overflows: it is choosing desktop layout from something");
        lines.push("  other than UA or width (server-side or a stored cookie).");
      } else if (!iphone) {
        lines.push("  Site does NOT see the iPhone UA. The header rule or the");
        lines.push("  main-world patch is not reaching this frame.");
      } else if (pong.innerWidth > 430) {
        lines.push("  Viewport is wider than a phone. Width setting is not being");
        lines.push("  applied to this frame.");
      } else {
        lines.push("  Phone UA + phone viewport + no overflow: looks correct.");
      }
    }
  }

  if (bg.errors?.length) {
    lines.push("");
    lines.push("errors");
    for (const e of bg.errors) lines.push(`  ${e}`);
  }

  $("diagbody").textContent = lines.join("\n");
  $("diag").hidden = false;
}

function pingActiveFrame() {
  const tab = activeTab();
  const frame = tab && frames.get(tab.id);
  if (!frame) return Promise.resolve(null);

  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      const msg = event.data;
      if (msg?.source === "goontek" && msg.type === "pong") done(msg);
    };
    const timer = setTimeout(() => done(null), 900);
    window.addEventListener("message", onMessage);
    try {
      frame.contentWindow?.postMessage({ source: "goontek", type: "ping" }, "*");
    } catch {
      done(null);
    }
  });
}

$("diagclose").addEventListener("click", () => {
  $("diag").hidden = true;
});

$("diagcopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("diagbody").textContent);
    toast("Diagnostics copied");
  } catch {
    toast("Could not copy");
  }
});

// ------------------------------------------------------------ keyboard

const ACTIONS = {
  newTab: { label: "New tab", run: () => newTab() },
  closeTab: { label: "Close tab", run: () => activeId != null && closeTab(activeId) },
  address: { label: "Address bar", run: () => urlInput.select() },
  reload: { label: "Reload", run: reload },
  back: { label: "Back", run: () => go(-1) },
  forward: { label: "Forward", run: () => go(1) },
  favourite: { label: "Favourite", run: toggleFavourite },
  requestMobile: { label: "Request mobile site", run: requestMobileSite },
  diagnostics: { label: "Diagnostics", run: diagnose },
  settings: { label: "Settings", run: openSettings },
};

const DEFAULT_KEYS = {
  newTab: "Ctrl+T",
  closeTab: "Ctrl+W",
  address: "Ctrl+L",
  reload: "Ctrl+R",
  back: "Alt+ArrowLeft",
  forward: "Alt+ArrowRight",
  favourite: "Ctrl+D",
  requestMobile: "Ctrl+Shift+M",
  diagnostics: "Ctrl+Shift+D",
  settings: "Ctrl+,",
};

/**
 * Serialise a keydown as "Ctrl+Shift+D". Returns null while only modifiers are
 * held. Meta is folded into Ctrl so one binding works on both platforms.
 */
function comboOf(e) {
  const key = e.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return null;

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

let capturing = null; // action name while the user is recording a new binding

document.addEventListener("keydown", (e) => {
  const combo = comboOf(e);
  if (!combo) return;

  // Recording a binding swallows everything except the escape hatch.
  if (capturing) {
    e.preventDefault();
    if (e.key !== "Escape") {
      config.keys = { ...config.keys, [capturing]: combo };
      saveConfig();
    }
    capturing = null;
    renderKeys();
    return;
  }

  if (e.key === "Escape") {
    // Innermost first, so one press does not close everything at once.
    if (!$("donateBox").hidden) closeDonate();
    else {
      $("settingsPanel").hidden = true;
      $("diag").hidden = true;
    }
    return;
  }

  // Ctrl+1..8 selects a tab. Fixed, so it never collides with a rebinding.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key >= "1" && e.key <= "8") {
    const tab = tabs[Number(e.key) - 1];
    if (tab) {
      e.preventDefault();
      activate(tab.id);
    }
    return;
  }

  for (const [action, binding] of Object.entries(config.keys)) {
    if (binding === combo && ACTIONS[action]) {
      e.preventDefault();
      ACTIONS[action].run();
      return;
    }
  }
});

// --------------------------------------------------------- persistence

let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

function saveConfig() {
  return chrome.storage.local.set({ [CONFIG_KEY]: config });
}

function saveSession() {
  return chrome.storage.session.set({
    [SESSION_KEY]: { tabs, activeId, visited, nextId },
  });
}
