// Service worker: on icon click or keyboard command, capture the visible tab + page
// context, stash them, and open the report window. The UI lives in its own window
// (report.html) — never injected into the page — so there are no layout conflicts and
// the screenshot never contains our own UI.

chrome.action.onClicked.addListener((tab) => activate(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "activate-wingman") activate(tab);
});

async function activate(tab) {
  if (!tab || !tab.id) return;
  if (!/^https?:\/\//i.test(tab.url || "")) {
    return notify("Wingman can't capture this page (try a normal http/https tab).");
  }

  let screenshot;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    return notify("Couldn't capture the screenshot: " + err.message);
  }

  // Read page context directly from the tab (accurate URL/title/viewport/UA).
  let context = {};
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    });
    context = res?.result || {};
  } catch (err) {
    context = { url: tab.url || "", title: tab.title || "" };
  }

  await chrome.storage.local.set({ "wingman:capture": { screenshot, context } });

  chrome.windows.create({
    url: chrome.runtime.getURL("src/report.html"),
    type: "popup",
    width: 480,
    height: 800,
  });
}

function notify(message) {
  chrome.notifications?.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Wingman",
    message,
  });
}
