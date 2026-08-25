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

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.source !== "goontek") return;
    if (msg.type === "volume") {
      volume = Math.min(1, Math.max(0, Number(msg.value) || 0));
      muted = volume === 0 || Boolean(msg.muted);
      applyAll();
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

  function measure() {
    const doc = document.documentElement;
    const body = document.body;
    if (!doc) return;
    const needed = Math.max(
      doc.scrollWidth,
      body ? body.scrollWidth : 0,
      doc.getBoundingClientRect().width
    );
    const viewport = window.innerWidth;
    // Ignore noise; only report a genuine overflow.
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
