// Content script: on activation, capture a clean screenshot (after removing any existing
// overlay), then mount the Wingman overlay inside an isolated Shadow DOM.
(function () {
  const HOST_ID = "wingman-host";
  let cssText = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "WM_ACTIVATE") activate();
  });

  // Keyboard fallback for activation, in case the Chrome command binding is unset or
  // conflicts: Cmd+Shift+K on Mac, Alt+Shift+K elsewhere (matches the manifest command).
  const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");
  document.addEventListener(
    "keydown",
    (e) => {
      const combo = IS_MAC
        ? e.metaKey && e.shiftKey && e.key === "K"
        : e.altKey && e.shiftKey && e.key === "K";
      if (!combo) return;
      // Already open: do nothing (re-activating would tear down and re-capture).
      if (document.getElementById(HOST_ID)) return;
      e.preventDefault();
      e.stopPropagation();
      activate();
    },
    true
  );

  async function activate() {
    // Tear down any existing overlay BEFORE capturing so it isn't in the screenshot.
    document.getElementById(HOST_ID)?.remove();

    const res = await chrome.runtime.sendMessage({ type: "WM_CAPTURE" }).catch(() => null);
    if (!res || !res.ok) return;

    if (cssText == null) {
      cssText = await fetch(chrome.runtime.getURL("src/styles.css"))
        .then((r) => r.text())
        .catch(() => "");
    }

    const consoleLogs = await getConsoleLogs();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);

    globalThis.Wingman.overlay.mount(host, root, res.screenshot, cssText, consoleLogs);
  }

  // Ask the MAIN-world console-capture script for its buffered logs. It lives in the page's
  // own JS world (separate globals), so we talk to it over window.postMessage. Resolve to []
  // on timeout so a missing/older capture script never blocks the overlay.
  function getConsoleLogs() {
    return new Promise((resolve) => {
      const nonce = `${Date.now()}-${Math.random()}`;
      let done = false;
      const finish = (logs) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        resolve(logs);
      };
      const onMessage = (e) => {
        const d = e.data;
        // Match on source/type/nonce rather than e.source === window: the reply comes from
        // the page's MAIN world, whose WindowProxy isn't reliably === this isolated world's
        // `window`. The unique nonce is what actually correlates request and response.
        if (
          d &&
          d.source === "wingman" &&
          d.type === "WM_LOGS_RESPONSE" &&
          d.nonce === nonce
        ) {
          finish(Array.isArray(d.logs) ? d.logs : []);
        }
      };
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "wingman", type: "WM_LOGS_REQUEST", nonce }, "*");
      setTimeout(() => finish([]), 500);
    });
  }
})();
