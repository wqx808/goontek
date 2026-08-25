<img src="icons/wordmark.jpg" alt="goontek" width="100%">

A private browsing panel for Chromium browsers. Dock any site in the side panel
with its own tabs, blocked ads, no history, and a hide key.

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
| Back / forward | `Alt+←` / `Alt+→` |
| Address bar / reload | `Ctrl+L` / `Ctrl+R` |
| Favourite | `Ctrl+D` |
| Request mobile site | `Ctrl+Shift+M` |
| Diagnostics | `Ctrl+Shift+D` |
| Settings | `Ctrl+,` |

All of these except tab switching can be rebound under Settings → Shortcuts. The
two browser-level ones (open panel, hide) are Chrome commands, changeable only at
`chrome://extensions/shortcuts`, which Settings links to.

**Shortcuts stop working once you click into the page.** Focus moves inside the
site's frame and the panel stops seeing keystrokes. The equivalents are buttons
under Settings → Troubleshooting.

**Hide** closes the panel outright, so the page gets its width back, and deletes
the session's URLs from history. A small rail appears on the edge of the page to
bring it back; the shortcut and the toolbar icon do the same. Tabs live in
session storage, so reopening puts you back where you were.

## Privacy

- Panel browsing doesn't reach `chrome://history`, and URLs are deleted
  explicitly on top of that.
- Open tabs live in session storage and die with the browser. Favourites are
  kept on disk and survive hiding.
- No network requests of its own, no analytics, no third-party code.
- `<all_urls>` is needed because the panel can load any site. `history` is only
  ever used to delete.

**Not isolation.** Framed sites are third-party to the panel, which has two
consequences: some cookies are refused (see below), and nothing here guarantees
separation from your normal profile. For real isolation, use a separate browser
profile.

**Not every site loads.** Framing headers are stripped for sites you open in the
panel and links you click inside them, but sites that detect framing in
JavaScript (most login flows and banks) still refuse.

## Ad blocking

On by default, in two layers: known ad and tracker domains are blocked at the
network level, and known ad containers are hidden with a stylesheet. Turn it off
under Settings → Browsing.

Two honest limits. It is **browser-wide**, not panel-only, because requests
from a framed page are attributed to that page, so there is no way to scope the
rules to the panel. And it cannot stop ads a site serves from its own domain.
Treat it as tracker reduction, not a full ad blocker.

## Width, and why sites render like a phone

The width dropdown sets the width the page is *laid out at*, then zooms that to
fit the panel. It is the main control over how a site looks.

- **mobile (390)** and **mobile S (360)**, the default. The page is told it has a
  phone screen, so responsive sites serve their mobile layout, zoomed up to fill
  the panel.
- **auto** lays out at the panel's real width, stepping in only if the page
  overflows.
- **desktop (1100)** forces the desktop layout, zoomed down.

A side panel is often 450 to 550px, which many sites read as a small *desktop*
window. Pinning the layout to 390px is unambiguously a phone, so the mobile
layout wins, the same reason a site looks right on an actual iPhone. Zooming
uses CSS `zoom`, so text stays sharp.

## Video

A side panel cannot go fullscreen. Whenever a video is playing, two controls
appear in the corner of the page:

- **Theater** blacks out the page and fills the panel with the video. The
  player's own fullscreen button does this too. Escape, **Exit**, or that button
  again returns.
- **Pop out** opens Picture-in-Picture, a floating window outside the panel.

They sit in the page rather than the panel because Picture-in-Picture needs a
user gesture in the frame, and a click in the panel doesn't carry one across.

For real monitor-wide fullscreen, use Settings → Troubleshooting → **Open this
page in a browser tab**.

## When something misbehaves

Settings → Troubleshooting → **Diagnostics** reports what the site actually
sees: the User-Agent and viewport, whether the rules and content scripts are
live, cookie behaviour, and page width against the panel.

**A site asks your age or cookie consent every time.** Framed sites are
third-party, and browsers refuse the ordinary (`SameSite=Lax`) cookies those
prompts write, so the site never records your answer. Manifest V3 gives an
extension no way to rewrite `Set-Cookie` to fix this. Either allow third-party
cookies for that site (Chrome: Settings → Privacy → Third-party cookies → add
`[*.]example.com`; Brave: Shields → Cookies), or open it in a browser tab.
Diagnostics confirms it: *normal cookie (SameSite=Lax)* reads `false`.

**A site stays on its desktop layout.** Some sites decide from a preference
stored the first time you visited in a normal tab. **Request mobile version of
this site** clears that one site's stored preference and reloads. It only touches
names that look like a device preference, so your session survives, though it may
sign you out. Server-set (HttpOnly) preferences need a separate profile.

**The mobile User-Agent has gaps.** It doesn't reach content a site fetches after
load, because those requests come from the page's own origin rather than the
extension.

## Layout

```
manifest.json     MV3 manifest, permissions, shortcuts
background.js     Service worker: panel, history scrubbing, network rules
content/
  mobile.js       Mobile emulation, main world, document_start
  panel.js        Volume, width, theater, PiP, cosmetic ad hiding
  rail.js         Reopen rail, injected into the page while hidden
rules/
  blocklist.json  Ad and tracker domains
sidepanel/        Panel markup, styles, controller
icons/            logo.png is the 1024px master; icon*.png derive from it
```

No build step: edit, then hit reload on `chrome://extensions`.

MIT licensed.
