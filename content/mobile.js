// Mobile emulation. Main world, document_start.
//
// The network rule rewrites the User-Agent request header, which decides the
// markup a server sends. Client-side code reads navigator.userAgent,
// navigator.userAgentData and touch support instead, and those come from the
// browser rather than the header. Patching only the header lets a site serve
// mobile HTML and then correct the layout back to desktop itself.
//
// Main world is required: an isolated-world script patches its own copy of
// navigator, which the page never sees. document_start is required so the
// values are in place before framework bootstrap reads them.

(() => {
  // A main-world script matching <all_urls> with allFrames runs in every frame
  // in the browser. Only act on frames hosted by an extension page.
  const chain = location.ancestorOrigins;
  if (!chain || chain.length === 0) return;
  let rooted = false;
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].startsWith("chrome-extension://")) rooted = true;
  }
  if (!rooted) return;

  // Must match the User-Agent the network rule sets, or the two contradict.
  const UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

  const define = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch {
      // Some pages freeze navigator; nothing more to do for that property.
    }
  };

  define(navigator, "userAgent", UA);
  define(navigator, "appVersion", UA.slice("Mozilla/".length));
  define(navigator, "platform", "iPhone");
  define(navigator, "vendor", "Apple Computer, Inc.");
  define(navigator, "maxTouchPoints", 5);

  // Safari exposes no userAgentData at all. Leaving Chrome's in place next to an
  // iPhone User-Agent is the single clearest tell, so hide it.
  define(navigator, "userAgentData", undefined);

  // Screen and pixel ratio. Sites that gate on screen.width rather than the
  // viewport (or pick image density from devicePixelRatio) read these, so an
  // iPhone 14/15's values back up the User-Agent. iOS reports CSS pixels here.
  define(screen, "width", 390);
  define(screen, "height", 844);
  define(screen, "availWidth", 390);
  define(screen, "availHeight", 844);
  define(screen, "colorDepth", 24);
  define(screen, "pixelDepth", 24);
  define(window, "devicePixelRatio", 3);

  // Fullscreen interception.
  //
  // A side panel cannot go fullscreen: a real requestFullscreen either fills
  // only the narrow panel or is refused, and players that take the iOS path
  // call video.webkitEnterFullscreen(), which does not exist in desktop Chrome
  // at all — so the button silently does nothing.
  //
  // Route every route to the panel's theater view instead. The handler lives in
  // the isolated world, and a CustomEvent on the shared document is the way to
  // reach it from here.
  // The element the player asked to fullscreen is the authoritative answer to
  // "which video". Guessing instead picks the wrong one on pages with an
  // autoplaying ad. Worlds cannot share objects, so mark it in the DOM.
  const askTheater = (type, target) => {
    try {
      const prev = document.querySelector("[data-goontek-fs-target]");
      if (prev) prev.removeAttribute("data-goontek-fs-target");
      if (target && target.setAttribute) target.setAttribute("data-goontek-fs-target", "1");
      document.dispatchEvent(new CustomEvent("goontek:theater-" + type));
    } catch {}
    return Promise.resolve();
  };
  const inTheater = () => document.documentElement.hasAttribute("data-goontek-theater");

  try {
    for (const name of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen", "mozRequestFullScreen", "msRequestFullscreen"]) {
      Object.defineProperty(Element.prototype, name, {
        value: function () {
          // Toggle: players that track fullscreen state internally call enter
          // again on their own button rather than exit, so a second enter has
          // to close theater or the button appears dead.
          return askTheater(inTheater() ? "exit" : "enter", this);
        },
        writable: true,
        configurable: true,
      });
    }
    for (const name of ["exitFullscreen", "webkitExitFullscreen", "webkitCancelFullScreen", "mozCancelFullScreen", "msExitFullscreen"]) {
      Object.defineProperty(Document.prototype, name, {
        value: function () {
          return askTheater("exit");
        },
        writable: true,
        configurable: true,
      });
    }

    // Report theater as fullscreen, so a player's button toggles correctly
    // rather than trying to enter again, and its icon reflects the state.
    const currentEl = () =>
      inTheater() ? document.querySelector("video[data-goontek-tv]") : null;
    for (const name of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement", "mozFullScreenElement", "msFullscreenElement"]) {
      Object.defineProperty(Document.prototype, name, { get: currentEl, configurable: true });
    }
    for (const name of ["fullscreenEnabled", "webkitFullscreenEnabled", "mozFullScreenEnabled", "msFullscreenEnabled"]) {
      Object.defineProperty(Document.prototype, name, { get: () => true, configurable: true });
    }

    // The iOS-only video API, for players that prefer it once the UA says iPhone.
    const VP = HTMLVideoElement.prototype;
    Object.defineProperty(VP, "webkitSupportsFullscreen", { get: () => true, configurable: true });
    Object.defineProperty(VP, "webkitDisplayingFullscreen", {
      get() {
        return inTheater() && this.hasAttribute("data-goontek-tv");
      },
      configurable: true,
    });
    Object.defineProperty(VP, "webkitEnterFullscreen", {
      value: function () {
        askTheater(inTheater() ? "exit" : "enter", this);
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(VP, "webkitExitFullscreen", {
      value: function () {
        askTheater("exit");
      },
      writable: true,
      configurable: true,
    });
    // Record that the interception is in place, so diagnostics can tell
    // "never patched" apart from "patched but the player never called it".
    document.documentElement.setAttribute("data-goontek-fs", "1");
  } catch {}

  // Touch capability: many sites branch on these existing at all.
  if (!("ontouchstart" in window)) {
    try {
      window.ontouchstart = null;
    } catch {}
  }

  // Width-based media queries are left alone: the panel really is narrow, so
  // they already resolve the way a mobile client would.

  // Marker on the shared DOM so the isolated-world script can confirm this ran.
  // Isolated world cannot see main-world variables, but both see the DOM.
  try {
    document.documentElement.setAttribute("data-goontek-ua", "1");
    // Also record what the page-facing navigator now reports. An isolated-world
    // content script has its own navigator and always reads the real browser
    // values, so reading it there says nothing about whether this patch worked.
    // The DOM is the only channel between the two worlds.
    document.documentElement.setAttribute(
      "data-goontek-seen",
      JSON.stringify({
        ua: navigator.userAgent,
        platform: navigator.platform,
        touch: navigator.maxTouchPoints,
        uaData: navigator.userAgentData === undefined ? "absent" : "present",
        screen: `${screen.width}x${screen.height}`,
        dpr: window.devicePixelRatio,
      })
    );
  } catch {}

  // Ensure a mobile viewport even when the server sent desktop markup.
  const WANT = "width=device-width, initial-scale=1, viewport-fit=cover";
  const setViewport = () => {
    if (!document.head) return;
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    if (meta.content !== WANT) meta.content = WANT;
  };
  if (document.head) setViewport();
  else document.addEventListener("DOMContentLoaded", setViewport, { once: true });

  // Some sites rewrite the viewport meta to a fixed desktop width when their
  // JavaScript switches to a desktop layout after load. Watch for that and put
  // the mobile viewport back. Cheap: one observer, only reacting to head changes.
  const guardViewport = () => {
    if (!document.head) return;
    new MutationObserver(setViewport).observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["content"],
    });
  };
  if (document.head) guardViewport();
  else document.addEventListener("DOMContentLoaded", guardViewport, { once: true });
})();
