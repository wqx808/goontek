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

  const UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Mobile Safari/537.36";

  const define = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch {
      // Some pages freeze navigator; nothing more to do for that property.
    }
  };

  define(navigator, "userAgent", UA);
  define(navigator, "appVersion", UA.slice("Mozilla/".length));
  define(navigator, "platform", "Linux armv81");
  define(navigator, "vendor", "Google Inc.");
  define(navigator, "maxTouchPoints", 5);

  // Client hints: the modern half of UA sniffing.
  if (navigator.userAgentData) {
    const brands = [
      { brand: "Chromium", version: "131" },
      { brand: "Google Chrome", version: "131" },
      { brand: "Not?A_Brand", version: "24" },
    ];
    define(navigator, "userAgentData", {
      brands,
      mobile: true,
      platform: "Android",
      getHighEntropyValues: async () => ({
        architecture: "",
        bitness: "",
        brands,
        fullVersionList: brands,
        mobile: true,
        model: "Pixel 8",
        platform: "Android",
        platformVersion: "14.0.0",
        uaFullVersion: "131.0.0.0",
      }),
      toJSON: () => ({ brands, mobile: true, platform: "Android" }),
    });
  }

  // Touch capability: many sites branch on these existing at all.
  if (!("ontouchstart" in window)) {
    try {
      window.ontouchstart = null;
    } catch {}
  }

  // Width-based media queries are left alone: the panel really is narrow, so
  // they already resolve the way a mobile client would.

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
