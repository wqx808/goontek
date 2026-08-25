# Contributing

Issues and pull requests are welcome.

## Running it

There is no build step and no dependencies. Load the folder as an unpacked
extension at `chrome://extensions` with Developer mode on, and press the reload
button after editing `manifest.json`, `background.js`, or either content script.
Panel markup and CSS only need the panel reopened.

## What fits here

Goontek is a private browsing panel. Features that serve that — better site
compatibility, better keyboard control, less trace left behind — are in scope.
Features that turn it into a general browser are not.

Two rules that are easy to break by accident:

- **Keep network rules scoped.** The framing and User-Agent rules use
  `initiatorDomains` so they only affect requests the panel makes. A rule without
  that scoping applies to every iframe in the browser.
- **Keep content scripts inert outside the panel.** Both scripts match
  `<all_urls>` and must return early unless the frame chain is rooted in an
  extension page.

## Style

Match the surrounding code: plain modern JavaScript, no framework, no
dependencies. Comment the constraints that are not visible in the code, not the
code itself.

## Blocklist

Add ad or tracker domains to `rules/blocklist.json` if their only purpose is
advertising or analytics. Blocking is browser-wide, so anything that also serves
page content does not belong there.

## Pull requests

Say what changed and how you checked it. If it affects site compatibility, name a
site it fixes and a site you confirmed still works.
