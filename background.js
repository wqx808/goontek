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
      scrubUrls([msg.url]).then(() => sendResponse({ ok: true }));
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
      condition: { resourceTypes: ["sub_frame"], initiatorDomains: [self] },
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
    // sub_frame only. An xmlhttprequest condition cannot match here: requests a
    // framed page makes are attributed to that page's origin, not to the
    // extension, so initiatorDomains never matches them.
    condition: {
      resourceTypes: ["sub_frame"],
      initiatorDomains: [self],
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
