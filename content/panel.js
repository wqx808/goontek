// Runs inside framed documents. Both jobs have to happen here because the
// parent cannot reach across a cross-origin boundary:
//
//  1. Apply volume and pause messages posted in by the panel.
//  2. Report the width the document needs, so the panel can scale an
//     over-wide page down to fit instead of clipping it.
//
// Isolated world is sufficient; neither job goes beyond the DOM.

(() => {
  const chain = location.ancestorOrigins;
  if (!chain || chain.length === 0) return;
  let rooted = false;
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].startsWith("chrome-extension://")) rooted = true;
  }
  if (!rooted) return;

  // ---------------------------------------------------------- cosmetic ads
  //
  // Network blocking cannot touch an ad a site serves from its own domain, and
  // a blocked slot still leaves an empty hole. This hides the containers.
  //
  // Delivered as one stylesheet rather than by querying and removing nodes:
  // the browser does the matching, it covers elements added later for free, and
  // there is no observer running on every mutation.
  //
  // Every selector is specific. Substring matches on short tokens are the trap
  // here: [class*="ad-"] also matches thread-, upload-, download-, payload-,
  // and [id*="ads"] matches downloads and threads. Hiding is used rather than
  // removal so nothing breaks when a site's own script expects the node.
  const COSMETIC = [
    // Known adult-tube ad containers (EasyList-derived)
    "#pb_template",
    "#singleFeedSection > .emptyBlockSpace",
    ".adWrapper",
    ".removeAdsStyle",
    "#hAd",
    ".realsex",
    "#video-right",
    "#video-sponsor-links",
    ".ad-footer",
    ".adsbytrafficjunky",
    ".ad-link",
    ".top-top",
    "#video_right_col > .clearfix",
    ".video-ad",
    ".preroll",
    ".midroll",
    ".ad-overlay",
    ".vast-ad",
    ".ima-ad",
    "iframe[title*='Campaign']",
    // YouTube
    ".video-ads",
    ".ytp-ad-module",
    ".ytp-ad-overlay-container",
    ".ytp-ad-image-overlay",
    "#player-ads",
    "#masthead-ad",
    "ytd-display-ad-renderer",
    "ytd-ad-slot-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-in-feed-ad-layout-renderer",
    // Conventional, unambiguous container names
    ".advertisement",
    ".ad-container",
    ".ad-wrapper",
    ".ad-slot",
    ".ad-banner",
    ".ad-unit",
    "[data-ad-slot]",
    "[data-adunit]",
    // Frames from ad networks, matched on the network's own domain
    "iframe[src*='doubleclick']",
    "iframe[src*='googlesyndication']",
    "iframe[src*='adnxs']",
    "iframe[src*='adsystem']",
    "iframe[src*='trafficjunky']",
    "iframe[src*='exoclick']",
    "iframe[src*='juicyads']",
    "iframe[src*='popads']",
    "iframe[src*='bkcdn']",
  ];

  const COSMETIC_ID = "goontek-cosmetic";

  function applyCosmetic(on) {
    const existing = document.getElementById(COSMETIC_ID);
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement("style");
    style.id = COSMETIC_ID;
    style.textContent = COSMETIC.join(",") + "{display:none !important}";
    (document.head || document.documentElement).appendChild(style);
  }

  // Shares the ad-blocking setting, so one switch governs both layers.
  try {
    chrome.storage.local.get("goontek:config").then((got) => {
      applyCosmetic((got["goontek:config"] || {}).adblock !== false);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["goontek:config"]) {
        applyCosmetic((changes["goontek:config"].newValue || {}).adblock !== false);
      }
    });
  } catch {}

  let volume = 1;
  let muted = false;

  // Media the panel's volume has already been applied to. After that, the
  // page and the user own it: pressing the site's own mute button must stick.
  // Without this the panel re-asserts its state on every DOM mutation, which
  // un-mutes the video the instant the player's controls redraw.
  const levelled = new WeakSet();

  function applyTo(el, force) {
    if (!force && levelled.has(el)) return;
    levelled.add(el);
    try {
      el.volume = volume;
      el.muted = muted;
    } catch {
      // Some players guard their media element; skip it.
    }
  }

  /** force: the panel's slider moved, which overrides whatever the page set. */
  function applyAll(force) {
    for (const el of document.querySelectorAll("video, audio")) applyTo(el, force);
  }

  // Tell the panel which document is showing. The panel cannot read the URL of
  // a cross-origin frame, so without this it never learns about navigations
  // that happen inside the frame, and cannot keep the address bar or back and
  // forward in sync.
  //
  // Only the top framed document reports. A nested iframe (an ad, a player) has
  // more than one ancestor origin, and its URL is not what belongs in the
  // address bar.
  const isTopFramed = (location.ancestorOrigins || []).length === 1;
  let lastAnnounced = null;
  const announce = () => {
    if (!isTopFramed || location.href === lastAnnounced) return;
    lastAnnounced = location.href;
    parent.postMessage({ source: "goontek", type: "located", url: location.href }, "*");
  };
  announce();
  document.addEventListener("DOMContentLoaded", announce, { once: true });
  // Catch in-page navigation that fires no load event.
  window.addEventListener("popstate", announce);
  window.addEventListener("hashchange", announce);
  // pushState/replaceState fire no event; poll cheaply for URL changes the
  // other hooks miss (SPA route changes). Stops mattering once the tab closes.
  setInterval(announce, 700);

  /**
   * Which video the user means.
   *
   * Size decides, not DOM order or playback. A page can have an autoplaying ad
   * above the real player, and picking the first *playing* video promotes the
   * ad. The real player is essentially always the largest one on screen.
   *
   * A hint from the page's own fullscreen request wins outright, since that is
   * the element it actually asked to enlarge.
   */
  function pickVideo(hint) {
    if (hint && hint.tagName === "VIDEO") return hint;

    let pool = [];
    if (hint && hint.querySelectorAll) pool = [...hint.querySelectorAll("video")];
    if (!pool.length) pool = [...document.querySelectorAll("video")];

    const scored = [];
    for (const v of pool) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area <= 0) continue; // hidden or not laid out
      scored.push({ v, area, playing: !v.paused && !v.ended && v.readyState > 2 });
    }
    if (!scored.length) return pool[0] || null;

    scored.sort((a, b) => b.area - a.area || Number(b.playing) - Number(a.playing));
    return scored[0].v;
  }

  // The panel tracks fullscreen state so it can react to a player entering or
  // leaving it.
  document.addEventListener("fullscreenchange", () => {
    const el = document.fullscreenElement;
    parent.postMessage({ source: "goontek", type: "fullscreen", on: Boolean(el) }, "*");
  });

  // The main-world script normally turns a fullscreen request into theater
  // before it reaches the browser. In a frame it did not reach, the request
  // survives and is refused; fall back to theater rather than nothing.
  document.addEventListener("fullscreenerror", () => enterTheater());

  // A side panel cannot take over the monitor, so this is the substitute: black
  // out the page and fill the panel with the video. Labelled "Full screen" in
  // the UI; "theater" is kept as the internal name throughout this file.
  //
  // Its button is injected here rather than drawn by the panel so that it sits
  // with the player's own controls, and so the click arrives in the same
  // document as the video it acts on.

  // Layer order. The maximum is 2147483647, so the stack is built downward
  // from it rather than giving several elements the same value and relying on
  // DOM order, which the page controls.
  const Z_CONTROLS = 2147483647;
  const Z_VIDEO = 2147483646;
  const Z_BACKDROP = 2147483645;

  const BTN_STYLE = [
    "all: initial",
    "font: 600 12px/1 -apple-system, system-ui, sans-serif",
    "display: inline-flex",
    "align-items: center",
    "gap: 7px",
    "padding: 8px 13px",
    "border-radius: 999px",
    "background: rgba(20,20,20,0.82)",
    "color: #fff",
    "cursor: pointer",
    "box-shadow: 0 2px 10px rgba(0,0,0,0.35)",
  ].join(";");

  // The corner brackets a player draws around its fullscreen control, split so
  // one half sits either side of the label: the text ends up framed the way the
  // video would be, rather than carrying a small square icon in front of it.
  const BRACKET_LEFT = ["M6 2H2v4", "M2 10v4h4"];
  const BRACKET_RIGHT = ["M2 2h4v4", "M6 10v4h-4"];

  const SVG_NS = "http://www.w3.org/2000/svg";

  function makeBracket(paths) {
    const svg = document.createElementNS(SVG_NS, "svg");
    // Half as wide as it is tall, so the pair reads as one frame around the text.
    svg.setAttribute("viewBox", "0 0 8 16");
    svg.setAttribute("width", "6");
    svg.setAttribute("height", "12");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.cssText = "display:block;flex:none;opacity:0.85";
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  // The panel lays the page out at one width and zooms it to fit, which scales
  // these controls along with the page. Cancelling that zoom keeps them the
  // same size on screen whichever width is selected. Offsets need no correction:
  // the frame's zoom and this one multiply out to 1 for those too.
  let frameScale = 1;
  const scaled = new Set();

  function applyScale(el) {
    scaled.add(el);
    el.style.zoom = frameScale === 1 ? "" : String(1 / frameScale);
  }

  function rescaleAll() {
    for (const el of scaled) {
      if (el.isConnected) applyScale(el);
      else scaled.delete(el);
    }
  }

  function makeButton(label, title, onClick, bracketed) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.style.cssText = BTN_STYLE;
    if (bracketed) b.appendChild(makeBracket(BRACKET_LEFT));
    const text = document.createElement("span");
    text.textContent = label;
    text.style.cssText = "all: unset";
    b.appendChild(text);
    if (bracketed) b.appendChild(makeBracket(BRACKET_RIGHT));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  /** A video worth offering controls for. */
  function usableVideo() {
    for (const v of document.querySelectorAll("video")) {
      if (v.readyState > 0 || v.currentSrc || v.srcObject) return v;
    }
    return null;
  }

  // ------------------------------------------------------------- theater

  let theater = null;

  // Fill the panel with the video.
  //
  // The hard part is that z-index and position:fixed are scoped to the nearest
  // ancestor with a transform, filter, perspective or containment, which video
  // players are full of. Promoting only the <video> leaves it trapped inside
  // that ancestor and hidden behind the backdrop, which reads as "everything
  // went black". So every ancestor from the video up to <body> is lifted to
  // fill the viewport too, with those properties neutralised, which makes the
  // chain escape cleanly at each level.
  //
  // Nothing is re-parented and no source is touched, so streamed (MSE/blob)
  // playback such as YouTube keeps running.
  const LIFT = [
    "position: fixed !important",
    "top: 0 !important",
    "left: 0 !important",
    "right: auto !important",
    "bottom: auto !important",
    "width: 100vw !important",
    "height: 100vh !important",
    "max-width: none !important",
    "max-height: none !important",
    "min-width: 0 !important",
    "min-height: 0 !important",
    "margin: 0 !important",
    "padding: 0 !important",
    "background: #000 !important",
    "border: 0 !important",
    "border-radius: 0 !important",
    "outline: 0 !important",
    "box-shadow: none !important",
    "opacity: 1 !important",
    "visibility: visible !important",
    "display: block !important",
    "overflow: visible !important",
    // Players hide the pointer during fullscreen playback; in a panel that just
    // leaves the user with no visible cursor.
    "cursor: auto !important",
    "pointer-events: auto !important",
    // These are what create a containing block / stacking context and trap the
    // element. Clearing them is the whole trick.
    "transform: none !important",
    "filter: none !important",
    "perspective: none !important",
    "will-change: auto !important",
    "contain: none !important",
    "clip-path: none !important",
    "z-index: " + Z_VIDEO + " !important",
  ].join(";");

  function enterTheater() {
    if (theater) return;
    // mobile.js marks whatever the page asked to fullscreen.
    const asked = document.querySelector("[data-goontek-fs-target]");
    const video = pickVideo(asked);
    if (!video) return;

    // The video plus every ancestor below <body>.
    const chain = [];
    for (let el = video; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      chain.push(el);
    }

    const saved = {
      styles: chain.map((el) => ({ el, cssText: el.style.cssText })),
      controls: video.controls,
      overflow: document.documentElement.style.overflow,
    };

    const backdrop = document.createElement("div");
    backdrop.style.cssText =
      "all: initial; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;" +
      "background: #000; z-index: " + Z_BACKDROP + ";";
    (document.body || document.documentElement).appendChild(backdrop);

    for (const el of chain) el.style.cssText += ";" + LIFT;
    // Only the video letterboxes; the containers are plain black fill.
    video.style.cssText += ";object-fit: contain !important;";
    // The page's own controls are behind the backdrop now.
    video.controls = true;
    document.documentElement.style.overflow = "hidden";

    const exit = makeButton("Exit", "Leave full screen", exitTheater, true);
    exit.style.cssText += ";position: fixed; top: 10px; right: 10px; z-index: " + Z_CONTROLS + ";";
    applyScale(exit);
    (document.body || document.documentElement).appendChild(exit);

    theater = { video, backdrop, exit, saved };

    // Let the page believe it is fullscreen, so its own button toggles back out
    // and its UI updates. mobile.js reads these in the main world.
    document.documentElement.setAttribute("data-goontek-theater", "1");
    video.setAttribute("data-goontek-tv", "1");
    document.dispatchEvent(new Event("fullscreenchange"));
    document.dispatchEvent(new Event("webkitfullscreenchange"));

    document.addEventListener("keydown", onTheaterKey, true);
    document.addEventListener("click", onTheaterClick, true);
    syncVideoControls();
    notifyLayoutChanged(video, true);
  }

  function exitTheater() {
    if (!theater) return;
    const { video, backdrop, exit, saved } = theater;
    for (const { el, cssText } of saved.styles) el.style.cssText = cssText;
    video.controls = saved.controls;
    document.documentElement.style.overflow = saved.overflow;
    backdrop.remove();
    exit.remove();
    theater = null;

    document.documentElement.removeAttribute("data-goontek-theater");
    video.removeAttribute("data-goontek-tv");
    const asked = document.querySelector("[data-goontek-fs-target]");
    if (asked) asked.removeAttribute("data-goontek-fs-target");
    document.dispatchEvent(new Event("fullscreenchange"));
    document.dispatchEvent(new Event("webkitfullscreenchange"));

    document.removeEventListener("keydown", onTheaterKey, true);
    document.removeEventListener("click", onTheaterClick, true);
    syncVideoControls();
    notifyLayoutChanged(video, false);
  }

  // The page's fullscreen button routes here: mobile.js intercepts the
  // Fullscreen API in the main world and re-emits it as these events, because
  // a side panel cannot actually go fullscreen.
  document.addEventListener("goontek:theater-enter", enterTheater);
  document.addEventListener("goontek:theater-exit", exitTheater);


  /**
   * Tell the player its world changed. Players size themselves from the
   * viewport and cache the result, so without a resize they keep the
   * theater-sized geometry after exiting and the page comes back broken.
   * Sent twice because many players debounce.
   */
  function notifyLayoutChanged(video, entering) {
    const fire = () => {
      window.dispatchEvent(new Event("resize"));
      try {
        // iOS players track fullscreen through these rather than the standard
        // fullscreenchange event.
        video.dispatchEvent(
          new Event(entering ? "webkitbeginfullscreen" : "webkitendfullscreen")
        );
      } catch {}
    };
    fire();
    setTimeout(fire, 250);
  }

  // Anything that looks like a fullscreen control, by any of the ways players
  // label one.
  const FS_CONTROL = [
    ".ytp-fullscreen-button",
    '[class*="fullscreen" i]',
    '[class*="full-screen" i]',
    '[id*="fullscreen" i]',
    '[aria-label*="fullscreen" i]',
    '[aria-label*="full screen" i]',
    '[title*="fullscreen" i]',
    '[title*="full screen" i]',
    '[data-tooltip-target-id*="fullscreen" i]',
  ].join(",");

  /**
   * Exit when the player's own fullscreen control is clicked.
   *
   * The Fullscreen API is already intercepted in the main world, but not every
   * player routes through it; mobile players in particular often implement
   * "fullscreen" as their own layout change and never call the API, so nothing
   * arrives to toggle. Catching the click works whatever the player does
   * internally, and only runs while theater is open.
   */
  function onTheaterClick(e) {
    const el = e.target && e.target.closest && e.target.closest(FS_CONTROL);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    exitTheater();
  }

  function onTheaterKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitTheater();
    }
  }

  // A navigation inside the frame throws away the element we promoted.
  // Full teardown, not just dropping the reference: a page restored from
  // bfcache would otherwise come back still blacked out, with a dead Exit
  // button, because exitTheater() returns early once theater is null.
  window.addEventListener("pagehide", () => {
    if (theater) exitTheater();
  });

  // ------------------------------------------------------- control cluster

  let cluster = null;

  function syncVideoControls() {
    const show = Boolean(usableVideo()) && !theater;

    if (!show) {
      if (cluster) cluster.style.display = "none";
      return;
    }

    if (!cluster) {
      cluster = document.createElement("div");
      cluster.style.cssText =
        "all: initial; position: fixed; right: 10px; bottom: 10px;" +
        "z-index: " + Z_CONTROLS + "; display: flex; gap: 6px;";
      cluster.append(
        makeButton("Full screen", "Fill the panel with the video", enterTheater, true)
      );
      (document.body || document.documentElement).appendChild(cluster);
      applyScale(cluster);
    }

    cluster.style.display = "flex";
  }

  const watchForVideo = () => {
    syncVideoControls();
    setInterval(syncVideoControls, 1000);
    document.addEventListener("play", syncVideoControls, true);
  };
  if (document.body) watchForVideo();
  else document.addEventListener("DOMContentLoaded", watchForVideo, { once: true });

  // Names a stored desktop-vs-mobile preference tends to use. Deliberately
  // specific: a bare "view" or "ua" would catch unrelated cookies like
  // "language" or "review_count".
  const PREF = /desktop|mobile|platform|device_?type|fullsite|full_site|no_?mobile|use_?desktop|preferred?_?view|view_?mode|layout_?pref|skin|responsive/i;

  // Never clear these, even if the name also looks like a preference. Removing
  // an age or consent record makes the site show its gate again on every load,
  // and removing a session logs the user out, both far worse than a stale
  // layout preference.
  const KEEP = /age|consent|gdpr|cookie|gate|legal|access|adult|confirm|notice|token|session|auth|login|csrf|remember/i;

  // Expire this document's own JS-readable cookies whose name looks like a
  // desktop/mobile preference, and drop matching storage keys. Runs in the
  // frame's origin, so no extension cookie permission is needed, but it cannot
  // touch HttpOnly cookies (server-only preferences need a clean profile).
  // Returns what it cleared, for the panel to show.
  function clearPrefs() {
    const cleared = { cookies: [], storage: [] };
    const expiry = "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    const registrable = location.hostname.split(".").slice(-2).join(".");
    try {
      for (const pair of document.cookie.split(";")) {
        const name = pair.split("=")[0].trim();
        if (name && PREF.test(name) && !KEEP.test(name)) {
          document.cookie = name + expiry;
          document.cookie = name + expiry + "; domain=." + registrable;
          cleared.cookies.push(name);
        }
      }
    } catch {}
    for (const store of [localStorage, sessionStorage]) {
      try {
        const keys = [];
        for (let i = 0; i < store.length; i += 1) keys.push(store.key(i));
        for (const k of keys) {
          if (k && PREF.test(k) && !KEEP.test(k)) {
            store.removeItem(k);
            cleared.storage.push(k);
          }
        }
      } catch {}
    }
    return cleared;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.source !== "goontek") return;
    if (msg.type === "scale") {
      const v = Number(msg.value);
      if (Number.isFinite(v) && v > 0) {
        frameScale = v;
        rescaleAll();
      }
    } else if (msg.type === "clearPrefs") {
      const cleared = clearPrefs();
      parent.postMessage({ source: "goontek", type: "cleared", cleared }, "*");
    } else if (msg.type === "volume") {
      volume = Math.min(1, Math.max(0, Number(msg.value) || 0));
      muted = volume === 0 || Boolean(msg.muted);
      applyAll(true);
    } else if (msg.type === "ping") {
      // Diagnostics. Reaching this at all proves the content script registered
      // and its extension-frame guard passed.
      const doc = document.documentElement;
      const viewport = document.querySelector('meta[name="viewport"]');
      // Can this frame persist the kind of cookie a site actually sets?
      //
      // The panel embeds sites cross-site, which is a third-party context. A
      // cookie marked SameSite=None; Secure survives that; a default cookie
      // (SameSite=Lax), which is what an age gate or consent banner writes,
      // does not. Testing only the None flavour reports success and hides the
      // real problem, so both are measured separately.
      let cookieLax = false;
      let cookieNone = false;
      try {
        const kill = (n) => {
          document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        };
        document.cookie = "__goontek_lax=1; path=/";
        cookieLax = document.cookie.includes("__goontek_lax");
        kill("__goontek_lax");
        document.cookie = "__goontek_none=1; path=/; SameSite=None; Secure";
        cookieNone = document.cookie.includes("__goontek_none");
        kill("__goontek_none");
      } catch {}

      // Names only; values may be session tokens and do not belong in a report
      // the user is about to paste somewhere.
      let cookieNames = [];
      try {
        cookieNames = document.cookie
          .split(";")
          .map((c) => c.split("=")[0].trim())
          .filter(Boolean);
      } catch {}

      let storageWritable = false;
      try {
        localStorage.setItem("__goontek_probe", "1");
        storageWritable = localStorage.getItem("__goontek_probe") === "1";
        localStorage.removeItem("__goontek_probe");
      } catch {}

      // What the page itself sees, recorded by the main-world script. This is
      // the only meaningful reading: navigator below belongs to the isolated
      // world and always reports the real browser.
      let mainWorld = null;
      try {
        const raw = doc.getAttribute("data-goontek-seen");
        if (raw) mainWorld = JSON.parse(raw);
      } catch {}

      let uaData = null;
      try {
        uaData = navigator.userAgentData
          ? { mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
          : "absent";
      } catch {}
      parent.postMessage(
        {
          source: "goontek",
          type: "pong",
          url: location.href,
          innerWidth: window.innerWidth,
          scrollWidth: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0),
          // Set by content/mobile.js in the main world; absent means it did
          // not run, even though this isolated-world script did.
          mobilePatched: doc.hasAttribute("data-goontek-ua"),
          fsPatched: doc.hasAttribute("data-goontek-fs"),
          inTheater: doc.hasAttribute("data-goontek-theater"),
          viewport: viewport ? viewport.content : null,
          readyState: document.readyState,
          // The decisive fields: what the site actually sees. If the UA is an
          // iPhone and innerWidth is ~390 but the layout is still desktop, the
          // site is not deciding layout from either: it is server-side or a
          // stored preference, and no client-side spoof can change it.
          mainWorld,
          seenUA: navigator.userAgent,
          seenUAData: uaData,
          seenPlatform: navigator.platform,
          seenTouchPoints: navigator.maxTouchPoints,
          seenScreen: `${screen.width}x${screen.height}`,
          dpr: window.devicePixelRatio,
          coarsePointer: matchMedia("(pointer: coarse)").matches,
          mqMobile600: matchMedia("(max-width: 600px)").matches,
          hasCookies: document.cookie.length > 0,
          cookieLax,
          cookieNone,
          cookieCount: cookieNames.length,
          cookieNames: cookieNames.slice(0, 40),
          storageWritable,
        },
        "*"
      );
    } else if (msg.type === "pause") {
      // Panic/minimize: stop anything audible immediately.
      muted = true;
      for (const el of document.querySelectorAll("video, audio")) {
        try {
          el.muted = true;
          el.pause();
        } catch {}
      }
    }
  });

  // Catch media that appears later, or that resets its own volume on play.
  document.addEventListener("play", (e) => {
    if (e.target instanceof HTMLMediaElement) applyTo(e.target, false);
  }, true);


  const start = () => {
    applyAll(false);
    // Players and single-page apps mutate constantly. Coalesce to one sweep per
    // microtask turn: without it, a document-wide querySelectorAll runs dozens
    // of times a second on a busy page.
    let queued = false;
    const sweep = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        // Never pass the mutation list through: a truthy first argument means
        // "force", which would re-assert over the user's own mute.
        applyAll(false);
      });
    };
    new MutationObserver(sweep).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  // ---------------------------------------------------------------- width

  // Measurements are only meaningful before the panel applies a scale, so the
  // panel keeps the first overflowing report per navigation and ignores the
  // rest. That also stops a widen/re-measure/shrink oscillation.
  const MAX_WIDTH = 1600;

  /**
   * Widest in-flow content, for pages where scrollWidth lies.
   *
   * `overflow-x: hidden` on the root or body clips the overflow instead of
   * scrolling it, which pins scrollWidth to the viewport width. The page then
   * measures as fitting while its content is visibly cut off. Walking the tree
   * finds the real extent.
   *
   * Elements designed to scroll sideways are measured but not descended into,
   * so a carousel's off-screen items don't inflate the result.
   */
  function widestContent() {
    const body = document.body;
    if (!body) return 0;

    let max = 0;
    let budget = 3000;

    const walk = (el) => {
      if (budget-- <= 0) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") return;

      const rect = el.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) {
        max = Math.max(max, rect.right + window.scrollX);
      }
      // A px min-width forces layout even while the box is clipped.
      if (cs.minWidth.endsWith("px")) {
        max = Math.max(max, parseFloat(cs.minWidth) || 0);
      }

      if (cs.overflowX === "auto" || cs.overflowX === "scroll") return;
      for (const child of el.children) walk(child);
    };

    walk(body);
    return max;
  }

  function measure() {
    const doc = document.documentElement;
    const body = document.body;
    if (!doc) return;

    const viewport = window.innerWidth;
    let needed = Math.max(
      doc.scrollWidth,
      body ? body.scrollWidth : 0,
      doc.getBoundingClientRect().width
    );

    // Only fall back to the tree walk when the page clips its own overflow,
    // which is the case scrollWidth cannot see. Sites that scroll normally
    // already report correctly and are left alone.
    const clipped = [doc, body].some(
      (el) => el && /^(hidden|clip)$/.test(getComputedStyle(el).overflowX)
    );
    if (clipped && needed <= viewport + 8) {
      const walked = widestContent();
      // Ignore implausible results rather than shrinking a page to nothing.
      if (walked > viewport + 8 && walked <= viewport * 4) needed = walked;
    }

    if (needed > viewport + 8) {
      parent.postMessage(
        { source: "goontek", type: "fit", required: Math.min(Math.ceil(needed), MAX_WIDTH) },
        "*"
      );
    }
  }

  // Sites lay out at very different times, so sample a few points rather than
  // trusting any single one.
  const schedule = () => {
    measure();
    setTimeout(measure, 400);
    setTimeout(measure, 1200);
    setTimeout(measure, 3000);
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
  document.addEventListener("DOMContentLoaded", measure, { once: true });
})();
