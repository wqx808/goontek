# Goontek

A private browsing panel for Chromium browsers. Docks any site in the side panel
with its own tabs, blocks ads, keeps nothing in your history, and hides with one
keystroke.

No accounts, no servers, no telemetry, no build step.

## Install

Not on the Web Store yet. Needs Chrome 116+.

1. Open `chrome://extensions` and turn on Developer mode
2. **Load unpacked**, pick this folder
3. Press `Ctrl/Cmd + Shift + Space`

## Shortcuts

| | |
|---|---|
| Open / close panel | `Ctrl/Cmd + Shift + Space` |
| Hide, and bring it back | `Ctrl/Cmd + Shift + H` |
| New / close tab | `Ctrl+T` / `Ctrl+W` |
| Switch tab | `Ctrl+1` … `Ctrl+8` |
| Address bar / reload | `Ctrl+L` / `Ctrl+R` |
| Favourite | `Ctrl+D` |
| Diagnostics | `Ctrl+Shift+D` |

Hide covers the panel, mutes and pauses every frame, and deletes the session's
URLs from history. Your tabs survive, so reopening puts you back where you were.

## What it does, and what it can't

- Panel browsing doesn't reach `chrome://history`. URLs are deleted explicitly
  on top of that.
- Open tabs live in session storage and die with the browser. Favourites are
  kept on disk and survive hiding.
- **Cookies are not isolated.** Framed pages share your normal profile's cookie
  jar; Manifest V3 offers no per-frame container. Use a separate browser profile
  if you need real isolation.
- **Not every site will load.** Sites that detect framing in JavaScript, such as
  most login flows and banks, will refuse.
- It makes no network requests of its own. `<all_urls>` is needed because the
  panel can load any site; the `history` permission is only ever used to delete.

### Ad blocking is browser-wide

It's always on, and it isn't limited to the panel. Requests made by a framed
page are attributed to that page rather than to the extension, so Chrome gives
no way to scope the rules to the side panel. Everything in
`rules/blocklist.json` is blocked everywhere for as long as Goontek is
installed, and uninstalling is the only way to turn it off.

## Something not rendering?

Press `Ctrl+Shift+D`. It reports whether the network rules and content scripts
registered, whether they're running in the current frame, and whether the page
is wider than the panel.

Two known gaps show up there: the mobile User-Agent doesn't reach content a site
fetches after load, or nested iframes like embedded players, because those
requests come from the page's own origin. Sites that remember a "desktop
version" cookie also override it, since the cookie jar is shared.

## Notes

Icons are placeholders. No build step: edit, then hit reload on
`chrome://extensions`.

MIT licensed.
