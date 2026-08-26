// The reopen rail, injected into the page while the side panel is closed.
//
// Hiding closes the panel outright, so nothing of it survives to draw a
// control. This is that control: a slim tab on the page's right edge which
// asks the worker to open the panel again.
//
// Injected on demand by background.js rather than declared as a content
// script, so it never runs unless the panel is collapsed.

(() => {
  const ID = "goontek-reopen-rail";
  if (document.getElementById(ID)) return;
  if (!document.body) return;

  const host = document.createElement("div");
  host.id = ID;

  // Positioning on the host, !important in the page cascade, so a site rule
  // cannot move it and a transformed <html> cannot trap it.
  for (const [prop, value] of Object.entries({
    position: "fixed",
    top: "50%",
    right: "0px",
    transform: "translateY(-50%)",
    "z-index": "2147483647",
    margin: "0",
    padding: "0",
    border: "0",
    width: "auto",
    height: "auto",
    "max-width": "none",
    "max-height": "none",
    display: "block",
    visibility: "visible",
    opacity: "1",
    "pointer-events": "auto",
  })) {
    host.style.setProperty(prop, value, "important");
  }

  // A shadow root so no page stylesheet can reach in and restyle or hide it.
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    button {
      width: 26px;
      padding: 14px 0;
      border: 0;
      border-radius: 8px 0 0 8px;
      background: rgba(24, 24, 23, 0.88);
      color: rgba(255, 255, 255, 0.62);
      font: 500 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 2px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 9px;
      box-shadow: -1px 0 10px rgba(0, 0, 0, 0.28);
      transition: color 120ms ease, background 120ms ease, width 120ms ease;
    }
    button:hover { width: 30px; color: #fff; background: rgba(24, 24, 23, 0.96); }
    button:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }
    .arrows { font-size: 12px; letter-spacing: 0; }
    .name { writing-mode: vertical-rl; transform: rotate(180deg); }
    button.hint { width: 30px; color: #fff; letter-spacing: 1px; }
    button.hint .arrows { display: none; }
  `;

  const button = document.createElement("button");
  button.type = "button";
  button.title = "Reopen goontek";
  button.setAttribute("aria-label", "Reopen goontek");
  button.innerHTML =
    '<span class="arrows" aria-hidden="true">‹‹</span>' +
    '<span class="name" aria-hidden="true">goontek</span>';

  const isMac = navigator.platform.startsWith("Mac");
  const SHORTCUT = isMac ? "⌘⇧Space" : "Ctrl+Shift+Space";

  button.addEventListener("click", async () => {
    // The click is the user gesture sidePanel.open() needs, but it belongs to
    // this page and may not survive the hop to the worker.
    const res = await chrome.runtime
      .sendMessage({ type: "goontek:reopen" })
      .catch(() => null);
    if (res?.ok) return;

    button.classList.add("hint");
    button.querySelector(".name").textContent = SHORTCUT;
    button.title = `Press ${SHORTCUT} to reopen goontek`;
  });

  root.append(style, button);
  document.documentElement.appendChild(host);
})();
