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
  width: "auto",
  theme: "system",
  accent: "",
  search: "duckduckgo",
  maxTabs: 8,
  scrubOnHide: true,
  ui: {}, // checkbox id -> false when that control is hidden
};
let minimized = false;
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

  const saved = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (saved) {
    tabs = saved.tabs || [];
    activeId = saved.activeId ?? null;
    visited = saved.visited || [];
    nextId = saved.nextId || tabs.length + 1;
  }
  if (tabs.length === 0) newTab({ focus: false });

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
    const el = document.createElement("div");
    el.className = "tab";
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(tab.id === activeId));

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab-label";
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

// ------------------------------------------------------------- frames

function frameFor(tab) {
  let frame = frames.get(tab.id);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "frame";
    frame.title = "Goontek panel content";
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
      // which the panel otherwise never hears about; without it the width
      // measured for the first page sticks for every page after it.
      if (config.width === "auto") {
        fits.delete(id);
        clearFit(frame);
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
    if (fits.has(id)) return; // already fitted for this navigation
    const required = Number(msg.required);
    if (!Number.isFinite(required) || required < 200) return;
    fits.set(id, required);
    applyFit(id);
  } else if (msg.type === "located") {
    recordVisit(id, msg.url);
  } else if (msg.type === "fullscreen") {
    const frame = frames.get(id);
    if (!frame) return;
    if (msg.on) clearFit(frame);
    else applyFit(id);
  }
});

/** The width to lay the page out at: an explicit choice, or what it measured. */
function targetWidth(id) {
  if (config.width !== "auto") return Number(config.width);
  return fits.get(id) || 0;
}

function applyFit(id) {
  const frame = frames.get(id);
  if (!frame) return;

  const target = targetWidth(id);
  const width = stage.clientWidth;
  const height = stage.clientHeight;

  // On auto, leave pages that already fit alone rather than scaling them.
  if (!target || !width || (config.width === "auto" && target <= width + 8)) {
    clearFit(frame);
    return;
  }

  const scale = width / target;
  frame.style.width = `${target}px`;
  frame.style.height = `${Math.ceil(height / scale)}px`;
  frame.style.transform = `scale(${scale})`;
}

function applyFitAll() {
  for (const id of frames.keys()) applyFit(id);
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
  frame.style.transform = "";
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
new ResizeObserver(applyFitAll).observe(stage);

/** Show only the active tab's frame; show the empty state if it has no URL. */
function showActive() {
  const tab = activeTab();
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

function renderFavourites() {
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
    });

    el.append(open, remove);
    wrap.appendChild(el);
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

$("panic").addEventListener("click", () => minimize());
$("reopen").addEventListener("click", restore);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "goontek:panic") {
    if (minimized) restore();
    else minimize();
  }
});

/**
 * Cover the panel and silence playing media, keeping tabs alive so restore()
 * puts the session back as it was. History is scrubbed here because it is the
 * only trace that outlives the panel.
 */
async function minimize() {
  if (minimized) return;
  minimized = true;

  // Silence before painting, so nothing keeps playing behind the curtain.
  for (const frame of frames.values()) {
    try {
      frame.contentWindow?.postMessage({ source: "goontek", type: "pause" }, "*");
    } catch {}
  }

  document.body.classList.add("minimized");
  $("curtain").hidden = false;
  $("reopen").focus();

  if (config.scrubOnHide !== false && visited.length) {
    await chrome.runtime
      .sendMessage({ type: "goontek:clear-history", urls: visited })
      .catch(() => {});
    visited = [];
    saveSession();
  }
}

function restore() {
  minimized = false;
  document.body.classList.remove("minimized");
  $("curtain").hidden = true;
  pushVolumeAll();
  urlInput.focus();
}

// ------------------------------------------------------------ settings

// Paste a Solana address here to enable the donate panel. Left empty on
// purpose: an address that is wrong or invented sends real money nowhere.
const SOLANA_WALLET = "";
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

const UI_KEYS = {
  uiFavourites: "favs",
  uiVolume: "volwrap",
  uiWidth: "width",
  uiClear: "clear",
  uiHide: "panic",
};

function applyAppearance() {
  const root = document.documentElement;
  if (config.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", config.theme);

  if (config.accent) root.style.setProperty("--accent", config.accent);
  else root.style.removeProperty("--accent");

  for (const [checkboxId, elementId] of Object.entries(UI_KEYS)) {
    const el = $(elementId);
    if (el) el.classList.toggle("ui-off", config.ui?.[checkboxId] === false);
  }
}

function renderSettings() {
  $("setTheme").value = config.theme;
  $("setMaxTabs").value = String(config.maxTabs);
  $("setSearch").value = config.search;
  $("setScrubOnHide").checked = config.scrubOnHide !== false;

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

$("settings").addEventListener("click", () => {
  renderSettings();
  $("settingsPanel").hidden = false;
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

for (const id of Object.keys(UI_KEYS)) {
  $(id).addEventListener("change", (e) => {
    config.ui = { ...config.ui, [id]: e.target.checked };
    saveConfig();
    applyAppearance();
  });
}

$("reportBug").addEventListener("click", () => newTab({ url: BUG_URL }));

$("donate").addEventListener("click", () => {
  if (!SOLANA_WALLET) {
    toast("No wallet configured yet");
    return;
  }
  const box = $("donateBox");
  box.hidden = !box.hidden;
  $("wallet").textContent = SOLANA_WALLET;
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
async function diagnose() {
  const lines = [];
  const bg = await chrome.runtime
    .sendMessage({ type: "goontek:diagnose" })
    .catch((e) => ({ errors: [`service worker unreachable: ${e.message}`] }));

  lines.push(`extension id   ${bg.id || "?"}`);
  lines.push(`dynamic rules  ${bg.rules?.length ? bg.rules.join(", ") : "NONE"}`);
  lines.push(`blocklist      ${bg.blocklist ?? "?"} domains`);
  lines.push("content scripts");
  if (bg.scripts?.length) for (const s of bg.scripts) lines.push(`  ${s}`);
  else lines.push("  NONE REGISTERED");

  const tab = activeTab();
  lines.push("");
  if (!tab?.url) {
    lines.push("active frame   (nothing loaded)");
  } else {
    const pong = await pingActiveFrame();
    if (!pong) {
      lines.push("active frame   NO RESPONSE");
      lines.push("  content script is not running in this frame, or its");
      lines.push("  extension-frame guard rejected it.");
    } else {
      lines.push(`active frame   ${pong.url}`);
      lines.push(`  ready        ${pong.readyState}`);
      lines.push(`  main-world patch ${pong.mobilePatched ? "applied" : "DID NOT RUN"}`);
      lines.push(`  viewport     ${pong.viewport || "(none)"}`);
      lines.push(`  innerWidth   ${pong.innerWidth}`);
      lines.push(`  scrollWidth  ${pong.scrollWidth}`);
      const over = pong.scrollWidth - pong.innerWidth;
      lines.push(`  overflow     ${over > 8 ? `${over}px WIDER than the panel` : "none"}`);
      lines.push(`  fit applied  ${fits.has(tab.id) ? `yes (${fits.get(tab.id)}px)` : "no"}`);
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

// ------------------------------------------------------------ keyboard

document.addEventListener("keydown", (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
      return;
    }
  }

  if (e.key === "Escape") {
    $("settingsPanel").hidden = true;
    $("diag").hidden = true;
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  if (e.shiftKey && (e.key === "D" || e.key === "d")) {
    e.preventDefault();
    diagnose();
    return;
  }

  if (e.key === "t") {
    e.preventDefault();
    newTab();
  } else if (e.key === "w") {
    e.preventDefault();
    if (activeId != null) closeTab(activeId);
  } else if (e.key === "l") {
    e.preventDefault();
    urlInput.select();
  } else if (e.key === "r") {
    e.preventDefault();
    reload();
  } else if (e.key === "d") {
    e.preventDefault();
    toggleFavourite();
  } else if (e.key >= "1" && e.key <= "8") {
    const tab = tabs[Number(e.key) - 1];
    if (tab) {
      e.preventDefault();
      activate(tab.id);
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
