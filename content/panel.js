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

  let volume = 1;
  let muted = false;

  function applyTo(el) {
    try {
      el.volume = volume;
      el.muted = muted;
    } catch {
      // Some players guard their media element; skip it.
    }
  }

  function applyAll() {
    for (const el of document.querySelectorAll("video, audio")) applyTo(el);
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

  // Pick the video most likely meant: the one playing, else the largest.
  function pickVideo(hint) {
    if (hint && hint.tagName === "VIDEO") return hint;
    if (hint && hint.querySelector) {
      const inside = hint.querySelector("video");
      if (inside) return inside;
    }
    const vids = [...document.querySelectorAll("video")];
    const playing = vids.find((v) => !v.paused && !v.ended && v.readyState > 2);
    if (playing) return playing;
    return vids.sort(
      (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
    )[0];
  }

  function toPiP(hint) {
    const video = pickVideo(hint);
    if (!video || !document.pictureInPictureEnabled || video.disablePictureInPicture) return;
    if (document.pictureInPictureElement === video) return;
    video
      .requestPictureInPicture()
      .then(() => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      })
      .catch(() => {});
  }

  // A side panel cannot give a video the whole monitor. Fullscreen either fills
  // just the narrow panel or is rejected outright; Picture-in-Picture floats
  // free of the panel, so hand off to it in both cases. Both handlers run in the
  // same task as the user's fullscreen click, which preserves the activation the
  // PiP request needs.
  document.addEventListener("fullscreenchange", () => {
    const el = document.fullscreenElement;
    parent.postMessage({ source: "goontek", type: "fullscreen", on: Boolean(el) }, "*");
    if (el) toPiP(el);
  });
  document.addEventListener("fullscreenerror", (e) => toPiP(e.target));

  // Names a stored desktop-vs-mobile preference tends to use. Deliberately
  // specific: a bare "view" or "ua" would catch unrelated cookies like
  // "language" or "review_count".
  const PREF = /desktop|mobile|platform|device_?type|fullsite|full_site|no_?mobile|use_?desktop|preferred?_?view|view_?mode|layout_?pref|skin|responsive/i;

  // Never clear these, even if the name also looks like a preference. Removing
  // an age or consent record makes the site show its gate again on every load,
  // and removing a session logs the user out — both far worse than a stale
  // layout preference.
  const KEEP = /age|consent|gdpr|cookie|gate|legal|access|adult|confirm|notice|token|session|auth|login|csrf|remember/i;

  // Expire this document's own JS-readable cookies whose name looks like a
  // desktop/mobile preference, and drop matching storage keys. Runs in the
  // frame's origin, so no extension cookie permission is needed — but it cannot
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
    if (msg.type === "clearPrefs") {
      const cleared = clearPrefs();
      parent.postMessage({ source: "goontek", type: "cleared", cleared }, "*");
    } else if (msg.type === "pip") {
      toPiP(null);
    } else if (msg.type === "volume") {
      volume = Math.min(1, Math.max(0, Number(msg.value) || 0));
      muted = volume === 0 || Boolean(msg.muted);
      applyAll();
    } else if (msg.type === "ping") {
      // Diagnostics. Reaching this at all proves the content script registered
      // and its extension-frame guard passed.
      const doc = document.documentElement;
      const viewport = document.querySelector('meta[name="viewport"]');
      // Can this frame persist a cookie at all? The panel embeds the site
      // cross-site, which is a third-party context, and Chrome blocks
      // third-party cookies. If this fails, the site cannot remember anything
      // cookie-based — age gates and consent banners will return on every
      // navigation no matter what the panel does.
      let cookieWritable = false;
      try {
        const probe = "__goontek_probe";
        document.cookie = `${probe}=1; path=/; SameSite=None; Secure`;
        cookieWritable = document.cookie.includes(probe);
        if (!cookieWritable) {
          document.cookie = `${probe}=1; path=/`; // retry without SameSite=None
          cookieWritable = document.cookie.includes(probe);
        }
        document.cookie = `${probe}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      } catch {}

      let storageWritable = false;
      try {
        localStorage.setItem("__goontek_probe", "1");
        storageWritable = localStorage.getItem("__goontek_probe") === "1";
        localStorage.removeItem("__goontek_probe");
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
          viewport: viewport ? viewport.content : null,
          readyState: document.readyState,
          // The decisive fields: what the site actually sees. If the UA is an
          // iPhone and innerWidth is ~390 but the layout is still desktop, the
          // site is not deciding layout from either — it is server-side or a
          // stored preference, and no client-side spoof can change it.
          seenUA: navigator.userAgent,
          seenUAData: uaData,
          seenPlatform: navigator.platform,
          seenTouchPoints: navigator.maxTouchPoints,
          seenScreen: `${screen.width}x${screen.height}`,
          dpr: window.devicePixelRatio,
          coarsePointer: matchMedia("(pointer: coarse)").matches,
          mqMobile600: matchMedia("(max-width: 600px)").matches,
          hasCookies: document.cookie.length > 0,
          cookieWritable,
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
    if (e.target instanceof HTMLMediaElement) applyTo(e.target);
  }, true);

  document.addEventListener("volumechange", (e) => {
    const el = e.target;
    if (el instanceof HTMLMediaElement && Math.abs(el.volume - volume) > 0.01) applyTo(el);
  }, true);

  const start = () => {
    applyAll();
    new MutationObserver(applyAll).observe(document.documentElement, {
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
