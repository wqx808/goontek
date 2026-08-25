// Side panel wiring, history scrubbing, network rules, content registration.
//
// The framing and User-Agent rules are restricted to requests the panel itself
// initiates (initiatorDomains). Unscoped, they would apply to every iframe in
// the browser.
//
// Ad blocking cannot be scoped that way: sub-resources inside a framed page are
// initiated by that page's origin, not by the extension. Those rules are
// browser-wide and unconditional.

const RULE_FRAME_HEADERS = 1;
const RULE_MOBILE_UA = 2;
const RULE_ADBLOCK = 3;

const SCRIPT_MOBILE = "goontek-mobile";
const SCRIPT_PANEL = "goontek-panel";

// iOS Safari rather than Android Chrome. Sites that serve a good mobile layout
// are overwhelmingly tested against iPhone Safari, and it is a more consistent
// disguise: Safari sends no Sec-CH-UA hints and exposes no navigator.userAgentData,
// so there is no Chrome-shaped evidence left behind to contradict the UA.
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Set-up failures are recorded rather than swallowed; without this a failed
// registration looks identical to an extension that simply does nothing.
let lastSyncError = null;

// Registrable domains the user has opened in the panel. The framing and UA
// rules extend to sub-frame requests these initiate, so in-frame link clicks
// (which the site, not the extension, initiates) are covered. Capped so a long
// session cannot grow the rule without bound.
const panelDomains = new Set();
const MAX_PANEL_DOMAINS = 100;

/** Registrable domain of a URL: drops the subdomain, keeps common SLD+ccTLD. */
function registrableDomain(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host)) return null; // skip IPs
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const slds = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);
  const take = slds.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-take).join(".");
}

/** Note a domain the panel loaded; rebuild rules if it is new. */
async function notePanelDomain(url) {
  const domain = registrableDomain(url);
  if (!domain || panelDomains.has(domain)) return;
  if (panelDomains.size >= MAX_PANEL_DOMAINS) {
    panelDomains.delete(panelDomains.values().next().value); // drop oldest
  }
  panelDomains.add(domain);
  await syncRules();
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await sync();
});

chrome.runtime.onStartup.addListener(sync);

chrome.commands.onCommand.addListener((command) => {
  if (command === "panic-hide") {
    // No receiver when the panel is closed, which is not an error.
    chrome.runtime.sendMessage({ type: "goontek:panic" }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "goontek:visited":
      // Register the domain for framing/UA coverage, then scrub from history.
      notePanelDomain(msg.url);
      scrubUrls([msg.url]).then(() => sendResponse({ ok: true }));
      return true;

    case "goontek:frame-domains":
      // Panel reports its open tabs' domains on init, so a restarted worker
      // (which loses the in-memory set) recovers coverage without a reload.
      Promise.all((msg.urls || []).map(notePanelDomain)).then(() =>
        sendResponse({ ok: true })
      );
      return true;

    case "goontek:clear-history":
      scrubUrls(msg.urls || []).then((n) => sendResponse({ ok: true, count: n }));
      return true;

    case "goontek:diagnose":
      diagnose().then(sendResponse);
      return true;
  }
});

/** Report what actually got registered, for the panel's diagnostics view. */
async function diagnose() {
  const out = { id: chrome.runtime.id, rules: [], scripts: [], blocklist: 0, errors: [] };
  if (lastSyncError) out.errors.push(`setup: ${lastSyncError}`);

  try {
    out.rules = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  } catch (e) {
    out.errors.push(`getDynamicRules: ${e.message}`);
  }
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    out.scripts = scripts.map((s) => `${s.id} (${s.world}, ${s.runAt})`);
  } catch (e) {
    out.errors.push(`getRegisteredContentScripts: ${e.message}`);
  }
  try {
    out.blocklist = (await loadBlocklist()).length;
  } catch (e) {
    out.errors.push(`blocklist: ${e.message}`);
  }
  return out;
}

/** Delete the given URLs from browser history. Deleting an absent URL is a no-op. */
async function scrubUrls(urls) {
  let count = 0;
  for (const url of urls) {
    if (typeof url !== "string" || !/^https?:/i.test(url)) continue;
    try {
      await chrome.history.deleteUrl({ url });
      count += 1;
    } catch {
      // history permission revoked or malformed URL — skip it.
    }
  }
  return count;
}

async function sync() {
  try {
    await Promise.all([syncRules(), syncScripts()]);
    lastSyncError = null;
  } catch (e) {
    lastSyncError = e.message || String(e);
    console.error("[goontek] setup failed:", e);
  }
}

// ------------------------------------------------------------ DNR rules

async function syncRules() {
  const self = chrome.runtime.id;

  // The framing and User-Agent rules apply to sub-frame requests initiated by
  // the extension (the first load, which the panel drives) OR by a site the
  // user has actually opened in the panel. The latter is needed because when
  // the user clicks a link inside the frame, the frame navigates itself and
  // the request is initiated by that site's origin, not the extension — so
  // without its domain here, the video page's X-Frame-Options refuses to frame.
  //
  // This is narrower than stripping every sub-frame browser-wide: only domains
  // the user deliberately loaded into the panel are affected, and only while
  // they remain in the set.
  const initiators = [self, ...panelDomains];

  const addRules = [
    {
      id: RULE_FRAME_HEADERS,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "x-frame-options", operation: "remove" },
          { header: "content-security-policy", operation: "remove" },
          { header: "content-security-policy-report-only", operation: "remove" },
          { header: "frame-options", operation: "remove" },
        ],
      },
      condition: { resourceTypes: ["sub_frame"], initiatorDomains: initiators },
    },
  ];

  addRules.push({
    id: RULE_MOBILE_UA,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "user-agent", operation: "set", value: MOBILE_UA },
        // Safari sends no client hints. Removing them is part of the disguise:
        // a Chrome hint next to an iPhone UA is a contradiction that
        // server-side device detection notices.
        { header: "sec-ch-ua", operation: "remove" },
        { header: "sec-ch-ua-mobile", operation: "remove" },
        { header: "sec-ch-ua-platform", operation: "remove" },
      ],
    },
    condition: {
      resourceTypes: ["sub_frame"],
      initiatorDomains: initiators,
    },
  });

  const domains = await loadBlocklist();
  if (domains.length) {
    addRules.push({
      id: RULE_ADBLOCK,
      priority: 2,
      action: { type: "block" },
      condition: {
        requestDomains: domains,
        // main_frame is excluded so a blocked domain can never strand a
        // top-level navigation on a blank page.
        resourceTypes: [
          "sub_frame",
          "script",
          "image",
          "xmlhttprequest",
          "media",
          "font",
          "stylesheet",
          "ping",
          "websocket",
          "other",
        ],
      },
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_FRAME_HEADERS, RULE_MOBILE_UA, RULE_ADBLOCK],
    addRules,
  });
}

let blocklistCache = null;
async function loadBlocklist() {
  if (blocklistCache) return blocklistCache;
  try {
    const res = await fetch(chrome.runtime.getURL("rules/blocklist.json"));
    const data = await res.json();
    blocklistCache = Array.isArray(data.domains) ? data.domains : [];
  } catch {
    blocklistCache = [];
  }
  return blocklistCache;
}

// -------------------------------------------------- content registration

async function syncScripts() {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const have = new Set(existing.map((s) => s.id));

  const wanted = [
    // Volume, pause and width measurement only touch the DOM.
    { id: SCRIPT_PANEL, js: ["content/panel.js"], world: "ISOLATED" },
    // Mobile emulation has to run in the main world; an isolated-world script
    // would patch its own copy of navigator, which the page never sees.
    { id: SCRIPT_MOBILE, js: ["content/mobile.js"], world: "MAIN" },
  ].filter((s) => !have.has(s.id));

  if (!wanted.length) return;

  await chrome.scripting.registerContentScripts(
    wanted.map((s) => ({
      ...s,
      matches: ["<all_urls>"],
      allFrames: true,
      runAt: "document_start",
    }))
  );
}
