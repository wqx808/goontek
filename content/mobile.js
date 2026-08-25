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
  } catch {}

  // Ensure a mobile viewport even when the server sent desktop markup.
  const setViewport = () => {
    if (!document.head) return;
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    meta.content = "width=device-width, initial-scale=1, viewport-fit=cover";
  };
  if (document.head) setViewport();
  else document.addEventListener("DOMContentLoaded", setViewport, { once: true });
})();
