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
const RULE_ADBLOCK_MEDIA = 4;

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
const DOMAINS_KEY = "goontek:panelDomains";

// A service worker is evicted whenever it goes idle, which would drop the set
// and silently stop covering in-frame navigation mid-session. Mirror it into
// session storage (cleared on browser shutdown, like the panel's own tabs) and
// reload it whenever the worker starts cold.
let domainsReady = null;
function loadPanelDomains() {
  if (!domainsReady) {
    domainsReady = chrome.storage.session
      .get(DOMAINS_KEY)
      .then((got) => {
        for (const d of got[DOMAINS_KEY] || []) panelDomains.add(d);
      })
      .catch(() => {});
  }
  return domainsReady;
}

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
  await loadPanelDomains();
  const domain = registrableDomain(url);
  if (!domain || panelDomains.has(domain)) return;
  if (panelDomains.size >= MAX_PANEL_DOMAINS) {
    panelDomains.delete(panelDomains.values().next().value); // drop oldest
  }
  panelDomains.add(domain);
  await chrome.storage.session
    .set({ [DOMAINS_KEY]: [...panelDomains] })
    .catch(() => {});
  await syncRules();
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await sync();
});

chrome.runtime.onStartup.addListener(sync);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "panic-hide") return;
  // The shortcut toggles. While collapsed the panel does not exist, so there is
  // nobody to receive a message and the worker has to reopen it itself.
  if (await isCollapsed()) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) reopen(tab.id);
    return;
  }
  // No receiver when the panel is closed for other reasons, which is not an error.
  chrome.runtime.sendMessage({ type: "goontek:panic" }).catch(() => {});
});

// ------------------------------------------------------------- collapse
//
// Hiding closes the side panel outright so the page gets its width back. The
// only thing left behind is a rail injected into the page, which asks to open
// the panel again. The flag lives in session storage because the worker is
// evicted whenever it goes idle.

const COLLAPSED_KEY = "goontek:collapsed";

async function isCollapsed() {
  const got = await chrome.storage.session.get(COLLAPSED_KEY).catch(() => ({}));
  return got[COLLAPSED_KEY] === true;
}

/**
 * Draw the rail on one tab, and report whether it took.
 *
 * No extension can inject into chrome:// and brave:// pages, the Web Store, or
 * the PDF viewer, so on those there is nowhere to put a rail at all. The badge
 * is the fallback: it is drawn on the toolbar icon, which is outside the page
 * and therefore always available.
 */
async function showRail(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/rail.js"],
    });
    return true;
  } catch {
    return false;
  }
}

function markCollapsed(on) {
  chrome.action.setBadgeText({ text: on ? "‹‹" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#3a3a38" }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" }).catch(() => {});
  chrome.action
    .setTitle({ title: on ? "goontek is hidden. Click to reopen." : "goontek" })
    .catch(() => {});
}

async function hideRails() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: () => document.getElementById("goontek-reopen-rail")?.remove(),
        })
        .catch(() => {})
    )
  );
}

async function collapse() {
  await chrome.storage.session.set({ [COLLAPSED_KEY]: true }).catch(() => {});
  markCollapsed(true);

  // Every tab in the window, not just the active one. If the active tab is a
  // browser page the rail cannot be drawn there at all, and this way switching
  // to any ordinary tab already has one waiting.
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true }).catch(() => []);
  await Promise.all(tabs.map((tab) => showRail(tab.id)));
}

/**
 * open() has to be called in a user gesture. A click on the rail is one, but
 * the gesture belongs to the page's renderer and does not always survive the
 * hop into the worker. When it does not, say so rather than doing nothing: the
 * caller leaves the rail up and shows the shortcut instead.
 */
async function reopen(tabId) {
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (err) {
    lastSyncError = `reopen: ${err.message}`;
    return false;
  }
  await chrome.storage.session.set({ [COLLAPSED_KEY]: false }).catch(() => {});
  markCollapsed(false);
  await hideRails();
  return true;
}

// A page navigation wipes the injected rail, and a tab the user switches to
// never had one. Redraw so the way back is always on screen while collapsed.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (await isCollapsed()) showRail(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  if (await isCollapsed()) showRail(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "goontek:visited":
      // Both must finish before the response, or an idle worker can be evicted
      // part-way through rebuilding the rules, leaving the new domain uncovered
      // until something else triggers a sync.
      Promise.all([notePanelDomain(msg.url), scrubUrls([msg.url])]).then(() =>
        sendResponse({ ok: true })
      );
      return true;

    case "goontek:frame-domains":
      // Panel reports its open tabs' domains on init, so a restarted worker
      // (which loses the in-memory set) recovers coverage without a reload.
      Promise.all((msg.urls || []).map(notePanelDomain)).then(() =>
        sendResponse({ ok: true })
      );
      return true;

    case "goontek:sync":
      // A setting that affects the network rules (e.g. ad blocking) changed.
      syncRules().then(() => sendResponse({ ok: true }));
      return true;

    case "goontek:clear-history":
      scrubUrls(msg.urls || []).then((n) => sendResponse({ ok: true, count: n }));
      return true;

    case "goontek:collapse":
      collapse().then(() => sendResponse({ ok: true }));
      return true;

    case "goontek:reopen":
      reopen(sender.tab?.id).then((ok) => sendResponse({ ok }));
      return true;

    case "goontek:opened":
      // The panel is running, so it is by definition not collapsed. Clears the
      // flag and any stale rail after a reopen by icon or shortcut.
      chrome.storage.session.set({ [COLLAPSED_KEY]: false }).catch(() => {});
      markCollapsed(false);
      hideRails().then(() => sendResponse({ ok: true }));
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
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    out.rules = rules.map((r) => r.id);
    // The conditions matter more than the ids when framing fails, so surface
    // them here rather than requiring a service-worker console.
    out.ruleConditions = rules.map(
      (r) =>
        `${r.id} ${r.action.type} <- ${(r.condition.initiatorDomains || ["(any)"]).join(", ")}`
    );
  } catch (e) {
    out.errors.push(`getDynamicRules: ${e.message}`);
  }
  out.panelDomains = [...panelDomains];
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
      // history permission revoked or malformed URL, so skip it.
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
  await loadPanelDomains();
  const self = chrome.runtime.id;

  // The framing and User-Agent rules apply to sub-frame requests initiated by
  // the extension (the first load, which the panel drives) OR by a site the
  // user has actually opened in the panel. The latter is needed because when
  // the user clicks a link inside the frame, the frame navigates itself and
  // the request is initiated by that site's origin, not the extension, so
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
          // Cross-Origin-Resource-Policy is checked on nested navigations, not
          // just on subresources, so `same-origin` refuses the frame on its own
          // even with X-Frame-Options and the CSP already gone. x.com is the
          // case that surfaced this: it sends all three.
          { header: "cross-origin-resource-policy", operation: "remove" },
          { header: "cross-origin-embedder-policy", operation: "remove" },
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

  const cfg = (await chrome.storage.local.get("goontek:config"))["goontek:config"] || {};
  const adblockOn = cfg.adblock !== false; // default on
  const domains = adblockOn ? await loadBlocklist() : [];
  if (domains.length) {
    addRules.push({
      id: RULE_ADBLOCK,
      priority: 2,
      action: { type: "block" },
      condition: {
        requestDomains: domains,
        // main_frame is excluded so a blocked domain can never strand a
        // top-level navigation on a blank page. media is excluded because a
        // dead media request hangs the player: see RULE_ADBLOCK_MEDIA.
        resourceTypes: [
          "sub_frame",
          "script",
          "image",
          "xmlhttprequest",
          "font",
          "stylesheet",
          "ping",
          "websocket",
          "other",
        ],
      },
    });

    // A video player treats a blocked pre-roll as a request still in flight and
    // waits for it, which leaves the real video stalled with its audio running.
    // Answering with an empty file instead makes the media element fail
    // immediately, so the player gives up on the ad and moves on.
    addRules.push({
      id: RULE_ADBLOCK_MEDIA,
      priority: 2,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/rules/noop.mp4" },
      },
      condition: { requestDomains: domains, resourceTypes: ["media"] },
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_FRAME_HEADERS, RULE_MOBILE_UA, RULE_ADBLOCK, RULE_ADBLOCK_MEDIA],
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
