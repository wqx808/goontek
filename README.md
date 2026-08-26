<img src="icons/wordmark.jpg" alt="goontek" width="100%">

A private browsing panel for Chromium browsers. Dock any site in the side panel
with its own tabs, blocked ads, no history, and a hide key.

No accounts, no servers, no telemetry, no build step.

## Install

Needs Chrome 116+. Not on the Web Store yet.

1. Open `chrome://extensions` and turn on Developer mode
2. **Load unpacked**, pick this folder
3. Press `Ctrl/Cmd + Shift + Space`

## Shortcuts

| Action | Default |
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

Rebind under Settings → Shortcuts. The two browser-level ones (open, hide) are
Chrome commands, changeable only at `chrome://extensions/shortcuts`.

**Shortcuts stop working once you click into the page.** Focus moves inside the
site's frame. Use the buttons under Settings → Troubleshooting instead.

**Hide** closes the panel, so the page gets its width back, and deletes the
session's URLs from history. A rail appears on the edge of the page to bring it
back; the shortcut and the toolbar icon do the same. Tabs live in session
storage, so reopening restores them. Browser pages (`chrome://`, `brave://`)
take no rail, because no extension can inject into them; the toolbar icon
carries a badge there instead.

## Privacy

- Panel browsing doesn't reach `chrome://history`, and URLs are deleted on top
  of that.
- Open tabs live in session storage and die with the browser. Favourites are
  kept on disk.
- No network requests of its own, no analytics, no third-party code.
- `<all_urls>` is needed because the panel can load any site. `history` is only
  ever used to delete.

**Not isolation.** Framed sites share your normal profile's cookie jar. For real
separation, use a separate browser profile.

**Not every site loads.** Framing headers are stripped for sites you open in the
panel and links you click inside them, but sites that frame-bust in JavaScript
still refuse.

## Ad blocking

On by default, in two layers: ad and tracker domains blocked at the network
level, and ad containers hidden with a stylesheet. Off under Settings → Browsing.

Three limits worth knowing:

- **Browser-wide, not panel-only.** Requests from a framed page are attributed
  to that page, so the rules cannot be scoped to the panel.
- **No first-party ads.** Anything the site serves from its own domain is
  indistinguishable from its real content.
- **No in-player video ads.** A pre-roll comes from the site's own domain,
  through its own player, as the same kind of request as the video itself.
  Blocking it would take the video with it. Use the player's Skip button.

Treat it as tracker reduction, not a full ad blocker.

## Width

The dropdown sets the width the page is *laid out* at, then zooms that to fit
the panel. It is the main control over how a site looks.

- **mobile (390)** and **mobile S (360)**, the default. Forces the phone layout,
  zoomed up to fill the panel.
- **auto** lays out at the panel's real width, stepping in only on overflow.

A side panel is usually 450 to 550px, which many sites read as a small *desktop*
window. Pinning to 390px is unambiguously a phone, so the mobile layout wins.
Zooming uses CSS `zoom`, so text stays sharp.

## Video

A side panel cannot take over the monitor. **Full screen** is the substitute:
while a video plays, a button appears in the corner of the page that blacks out
the page and fills the panel with the video. The player's own fullscreen button
does this too; Escape or **Exit** returns.

The button sits in the page, with the player's own controls, rather than in the
panel's chrome.

For monitor-wide fullscreen, use Settings → Troubleshooting → **Open this page
in a browser tab**.

## Troubleshooting

**Diagnostics** (`Ctrl+Shift+D`) reports what the site actually sees: the
User-Agent and viewport, whether the rules and content scripts are live, cookie
behaviour, and page width against the panel.

**A site asks your age or cookie consent every time.** Framed sites are
third-party, and browsers refuse the ordinary (`SameSite=Lax`) cookies those
prompts write. Manifest V3 gives an extension no way to rewrite `Set-Cookie`.
Either allow third-party cookies for that site (Chrome: Settings → Privacy →
Third-party cookies; Brave: Shields → Cookies), or open it in a browser tab.

**A site stays on its desktop layout.** Some decide from a preference stored the
first time you visited in a normal tab. **Request mobile version of this site**
clears that one site's stored preference and reloads. It only touches names that
look like a device preference, but it may sign you out. Server-set (HttpOnly)
preferences need a separate profile.

**The mobile User-Agent has gaps.** It doesn't reach content the page fetches
after load, because those requests come from the page's own origin.

## Layout

```
manifest.json     MV3 manifest, permissions, shortcuts
background.js     Service worker: panel, history scrubbing, network rules
content/
  mobile.js       Mobile emulation, main world, document_start
  panel.js        Volume, width, full screen, cosmetic ad hiding
  rail.js         Reopen rail, injected into the page while hidden
rules/
  blocklist.json  Ad and tracker domains
sidepanel/        Panel markup, styles, controller
icons/            logo.png is the 1024px master; icon*.png derive from it
```

No build step: edit, then hit reload on `chrome://extensions`.

MIT licensed.
