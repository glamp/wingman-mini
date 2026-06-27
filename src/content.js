// Content script: activates the Wingman overlay on demand, and — crucially — re-attaches the
// recording controls when a page reloads mid-recording. The recording itself lives in an
// offscreen document driven by the service worker, so it keeps going across reloads; this
// script just brings its on-screen UI back.
(function () {
  const HOST_ID = "wingman-host";
  const REC_KEY = "wingman:recording";

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "WM_ACTIVATE") activate();
    else if (msg.type === "WM_RECORDING_ENDED") onRecordingEnded(msg);
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

  // Icon/shortcut activation: capture a clean screenshot, then mount the overlay panel.
  async function activate() {
    if (document.getElementById(HOST_ID)) return;
    const res = await chrome.runtime.sendMessage({ type: "WM_CAPTURE" }).catch(() => null);
    if (!res || !res.ok) return;
    const consoleLogs = await getConsoleLogs();
    await globalThis.Wingman.overlay.mountPanel({ screenshot: res.screenshot, consoleLogs });
  }

  // The user ended the recording from Chrome's native "Stop sharing" bar — show the review
  // panel with the poster the offscreen doc handed back.
  async function onRecordingEnded(msg) {
    globalThis.Wingman.overlay.removeRecordingControls();
    const consoleLogs = await getConsoleLogs();
    await globalThis.Wingman.overlay.showRecordingDone({ ...msg, consoleLogs });
  }

  // On (re)load, if a recording is in flight for this tab, bring its UI back. The cheap local
  // storage read short-circuits the common no-recording case without waking the service worker.
  restore();
  async function restore() {
    let rec = null;
    try {
      const out = await chrome.storage.local.get(REC_KEY);
      rec = out[REC_KEY];
    } catch (e) {
      return;
    }
    if (!rec || !rec.phase) return;

    // Confirm with the SW that this is the recording tab (it knows our tab id).
    const status = await chrome.runtime
      .sendMessage({ type: "WM_RECORDING_STATUS" })
      .catch(() => null);
    if (!status || !status.phase) return;

    if (status.phase === "recording") {
      // Still rolling — re-show the floating stop bar + draw overlay.
      globalThis.Wingman.overlay.showRecordingControls();
    } else if (status.phase === "done") {
      // Stopped before the page came back — re-open the review panel with the poster.
      const stop = await chrome.runtime
        .sendMessage({ type: "WM_STOP_RECORDING" })
        .catch(() => null); // idempotent: returns the already-finalized artifacts
      if (stop && stop.ok) {
        const consoleLogs = await getConsoleLogs();
        await globalThis.Wingman.overlay.showRecordingDone({ ...stop, consoleLogs });
      }
    }
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
