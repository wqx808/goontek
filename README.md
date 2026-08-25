# Goontek

**A private browsing panel that lives beside your work, and disappears with one key.**

Goontek docks any site in the browser's side panel: its own tabs, its own
favourites, its own volume. Nothing it does is written to your browser history,
ads and trackers are blocked before they load, and a single keystroke covers the
whole thing and mutes it.

No accounts. No servers. No telemetry. No build step. Under 800 lines of
dependency-free JavaScript you can read in one sitting.

---

## Why

Side-panel extensions usually wrap a site and stop there. The moment you use one
for anything you would rather not explain, three problems show up: it litters
your history, it runs the same ad and tracker load as a normal tab, and closing
it in a hurry means fumbling for the right tab.

Goontek is built around those three problems.

| | |
|---|---|
| **Leaves no history** | Panel browsing never lands in `chrome://history`, and visited URLs are deleted explicitly on top of that. |
| **Blocks ads and trackers** | ~60 ad and analytics domains are blocked at the network layer, always on. |
| **Vanishes instantly** | One keystroke covers the panel, pauses and mutes every frame, and wipes the session's history. One click brings it all back. |
| **Forgets by default** | Open tabs live in session storage and are gone when the browser closes. Favourites are the only thing kept. |
| **Fits any site** | Mobile emulation plus automatic scaling, so wide desktop-only sites stay readable in a narrow panel. |
| **Sends nothing anywhere** | No network requests of its own, no analytics, no remote config. |

---

## Install

Not on the Chrome Web Store yet. To run it now:

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked**, and pick this folder.
4. Press **Ctrl/Cmd + Shift + Space**, or click the toolbar icon.

Chrome 116 or newer, or any Chromium browser based on it.

## Use

| Action | Shortcut |
|---|---|
| Open / close panel | `Ctrl/Cmd + Shift + Space` |
| Hide, mute, and scrub | `Ctrl/Cmd + Shift + H` |
| Bring it back | same shortcut, or **reopen** |
| New tab / close tab | `Ctrl+T` / `Ctrl+W` |
| Switch to tab *n* | `Ctrl+1` … `Ctrl+8` |
| Address bar | `Ctrl+L` |
| Reload | `Ctrl+R` |
| Favourite this page | `Ctrl+D` |
| Diagnostics | `Ctrl+Shift+D` |

Type a bare domain and it becomes `https://`; type anything else and it becomes a
DuckDuckGo search. Shift-click a favourite to open it in a new tab. Rebind any
shortcut at `chrome://extensions/shortcuts`.

**Hide is a cover, not a close.** It drops a blank panel over everything, pauses
and mutes every frame, and deletes the session's URLs from history. Your tabs
survive untouched, so **reopen** returns you exactly where you were.

---

## Privacy: what is guaranteed, and what is not

Goontek frames sites inside an extension page. That is what makes it useful, and
it is also the limit of what it can promise. The honest version:

**Guaranteed**

- Browsing in the panel does not enter `chrome://history`. Iframe navigations
  inside an extension page never reach it, and every URL loaded is passed to
  `history.deleteUrl()` regardless.
- Open tabs live in `chrome.storage.session` and do not survive a browser restart.
- Hide pauses and mutes all media before it paints, and scrubs the session.
- The extension makes no network requests of its own and contains no analytics,
  no remote configuration, and no third-party code.

**Not guaranteed**

- **Cookies and site storage are not isolated.** Framed pages share your normal
  profile's cookie jar. Manifest V3 gives extensions no per-frame cookie
  container, so this is not something Goontek can fix. If you need true
  isolation, use a separate browser profile.
- **Not every site will load.** Goontek removes `X-Frame-Options` and CSP from
  the panel's own requests, which is enough for many sites. Sites that detect
  framing in JavaScript — most login flows, banks, some video hosts — will still
  refuse. That is a browser-level constraint.
- **Favourites persist.** They are stored on disk and hide does not clear them.
  Everything else is ephemeral; this is the deliberate exception.
- **Your employer, ISP, and the sites themselves still see your traffic.** This
  is a local privacy tool, not a VPN and not anonymity.

### Ad blocking is browser-wide

Ad blocking is always on and has no toggle. It also is not confined to the panel.

Requests made *by a framed page* are attributed to that page's origin, not to the
extension, so there is no way to scope those rules to the side panel. The domains
in `rules/blocklist.json` are therefore blocked everywhere in the browser for as
long as Goontek is installed. Removing the extension is the only way to turn it
off. Edit the blocklist and reload the extension to change what is blocked.

This is stated plainly because it is the kind of thing an extension should not do
quietly.

---

## Making sites fit a narrow panel

Two layers, both always on.

**Mobile emulation** persuades responsive sites to serve their phone layout. It
rewrites the `User-Agent` request header, sets the matching client hints, patches
`navigator.userAgent` / `userAgentData` / `platform` / `maxTouchPoints` in the
page's main world at `document_start`, and forces a `width=device-width`
viewport.

That last pair matters more than it looks. Rewriting only the header lets a site
send mobile HTML and then read a desktop `navigator.userAgent` from its own
JavaScript and undo the layout — which looks exactly like nothing happening.

**Fit to width** covers everything emulation cannot. A content script measures
the width the document actually needs; if that exceeds the panel, the frame is
laid out at that width and scaled down with a CSS transform, so the page is
readable rather than clipped. Pages that already fit are never scaled. Fit state
is per tab, resets on navigation, and follows the panel when you resize it.

---

## Layout

```
goontek/
├── manifest.json          MV3 manifest, permissions, shortcuts
├── background.js          Service worker: panel wiring, history scrubbing,
│                          network rules, content script registration
├── content/
│   ├── mobile.js          Main-world mobile emulation (document_start)
│   └── panel.js           Volume, pause, and width measurement in framed pages
├── rules/
│   └── blocklist.json     Ad and tracker domains
├── sidepanel/
│   ├── index.html         Panel markup
│   ├── style.css          Monochrome theme, light and dark
│   └── app.js             Tabs, favourites, navigation, volume, hide
└── icons/                 Placeholder artwork, see below
```

The icons are a plain placeholder mark, not final artwork. Replacing them needs
PNGs at 16, 32, 48 and 128 px named `icon<size>.png`. The 128 px version is the
one the Chrome Web Store lists, so it should read clearly when scaled down to 16.

Both content scripts match `<all_urls>` with `allFrames`, which means they are
offered every frame in the browser. Each one exits immediately unless the frame
chain is rooted in an extension page, so they only ever act inside the panel.

Configuration (favourites, volume) is in `chrome.storage.local`. Session state
(tabs, active tab, visited URLs) is in `chrome.storage.session`.

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | Renders the panel |
| `storage` | Favourites, volume, session tabs |
| `history` | Deleting the panel's own URLs; never reads history |
| `scripting` | Registers the two content scripts |
| `declarativeNetRequest` | Frame headers, mobile User-Agent, ad blocking |
| `<all_urls>` | The panel can load any site, so rules and scripts must be able to apply anywhere |

Goontek never reads your browsing history. The `history` permission is used only
for `deleteUrl`.

## When a site does not render properly

Press **Ctrl+Shift+D** in the panel. The report answers, for the frame you are
looking at:

- whether the network rules and both content scripts actually registered
- whether the content script is running *in that frame* (`NO RESPONSE` means it
  is not, which explains both missing mobile layout and missing scaling)
- whether the main-world mobile patch applied, and what viewport the page ended
  up with
- the document's width against the panel's, and whether scaling was applied

Two known limits show up here. Requests made *by* a framed page are attributed to
that page's origin rather than to the extension, so the mobile User-Agent does
not reach content the site fetches after load, and neither the User-Agent nor the
header stripping reaches nested iframes such as embedded players. Sites that
store a "desktop version" preference as a cookie also override the User-Agent
entirely, because the panel shares your normal cookie jar.

## Development

There is no build. Edit a file, then press the reload button on
`chrome://extensions`. Changes to `manifest.json`, `background.js`, or either
content script need that reload; panel markup and CSS only need the panel
reopened.

To package for upload, zip the contents of this folder — not the folder itself —
excluding `.git` and `_metadata`. Chrome's **Pack extension** button does the
same thing.

## Roadmap

- Config export and import
- Per-domain cookie allow-list
- Full keyboard navigation and a theme toggle
- Firefox support

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
