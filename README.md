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
| Settings | `Ctrl+,` or the gear |
| Layout width | dropdown in the panel |

Every shortcut above except tab switching can be rebound under Settings →
Shortcuts. The two browser-level ones (open panel, hide) are Chrome commands and
can only be changed at `chrome://extensions/shortcuts`, which the settings panel
links to.

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
- **Not every site will load.** `X-Frame-Options` and CSP framing headers are
  stripped for sites you open in the panel (including links you click within
  them), but sites that detect framing in JavaScript — most login flows and
  banks — will still refuse.
- It makes no network requests of its own. `<all_urls>` is needed because the
  panel can load any site; the `history` permission is only ever used to delete.

### Ad blocking is browser-wide

It's always on, and it isn't limited to the panel. Requests made by a framed
page are attributed to that page rather than to the extension, so Chrome gives
no way to scope the rules to the side panel. Everything in
`rules/blocklist.json` is blocked everywhere for as long as Goontek is
installed, and uninstalling is the only way to turn it off.

## Width, and why it renders like a phone

The width dropdown sets the width the page is *laid out at*, then zooms that to
fit the panel. This is the single most important control for how a site looks.

- **phone (390) / phone S (360)** — the default. The page is told it has a
  ~390px screen, exactly like an iPhone, so responsive sites serve their mobile
  layout. The result is zoomed up to fill the panel.
- **tablet (768)** — a middle ground for sites whose phone layout is too sparse.
- **auto** — lays out at the panel's real width and only intervenes if the page
  overflows. Good for sites that are already responsive at desktop widths.
- **desktop (1100 / 1280)** — forces the full desktop layout, zoomed down.

Why a fixed 390 rather than just using the panel width: a side panel is often
~450–550px, and many sites treat that as a small *desktop* window and serve the
desktop layout, which then overflows and shrinks. Pinning the layout to 390px is
unambiguously a phone, so the mobile layout wins — the same reason the site looks
right on an actual iPhone. Zooming up to fill the panel is done with CSS `zoom`,
so text stays sharp rather than blurring.

### When a site stays desktop anyway

A few sites (Pornhub is one) decide desktop-vs-mobile from a preference they
stored the first time you visited in a normal tab, not from the screen. The
panel shares your profile's cookies, so it inherits that preference and forcing a
phone width only crops the desktop layout instead of switching it.

**Settings → Troubleshooting → Request mobile version of this site** clears that
one site's stored desktop preference and reloads. It only touches cookies and
storage whose names look like a device preference, so it won't wipe your session
wholesale — but it may sign you out of that site. Server-set preferences
(HttpOnly cookies) can't be cleared this way; those need a separate profile.

Both this and **Diagnostics** live under Settings → Troubleshooting as buttons.
Use the buttons, not the keyboard shortcuts: once you click into the framed page,
keyboard focus is inside the site's iframe and the panel's shortcuts stop firing.

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
