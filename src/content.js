// Content script: on activation, capture a clean screenshot (after removing any existing
// overlay), then mount the Wingman overlay inside an isolated Shadow DOM.
(function () {
  const HOST_ID = "wingman-host";
  let cssText = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "WM_ACTIVATE") activate();
  });

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

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);

    globalThis.Wingman.overlay.mount(host, root, res.screenshot, cssText);
  }
})();
