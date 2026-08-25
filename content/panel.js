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
  // that happen inside the frame, and cannot offer back or forward.
  const announce = () => {
    parent.postMessage({ source: "goontek", type: "located", url: location.href }, "*");
  };
  announce();
  document.addEventListener("DOMContentLoaded", announce, { once: true });

  document.addEventListener("fullscreenchange", () => {
    const el = document.fullscreenElement;
    parent.postMessage({ source: "goontek", type: "fullscreen", on: Boolean(el) }, "*");
    if (!el) return;

    // A side panel cannot give a video the whole monitor; fullscreen just fills
    // the narrow panel. Picture-in-Picture floats free of the panel, so convert
    // to it. This runs in the same task as the user's fullscreen click, which is
    // what lets the PiP request keep its activation. Exit fullscreen only if PiP
    // actually starts, so a site whose player forbids PiP is left as it was.
    const video = el.tagName === "VIDEO" ? el : el.querySelector && el.querySelector("video");
    if (!video || !document.pictureInPictureEnabled || video.disablePictureInPicture) return;

    video
      .requestPictureInPicture()
      .then(() => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      })
      .catch(() => {});
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.source !== "goontek") return;
    if (msg.type === "volume") {
      volume = Math.min(1, Math.max(0, Number(msg.value) || 0));
      muted = volume === 0 || Boolean(msg.muted);
      applyAll();
    } else if (msg.type === "ping") {
      // Diagnostics. Reaching this at all proves the content script registered
      // and its extension-frame guard passed.
      const doc = document.documentElement;
      const viewport = document.querySelector('meta[name="viewport"]');
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
