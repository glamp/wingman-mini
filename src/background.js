// Service worker: triggers the in-page overlay, captures clean screenshots on demand, and
// proxies Groq calls (which can't be made from a content script due to CORS).
importScripts("groq.js");

const { groq } = globalThis.Wingman;

chrome.action.onClicked.addListener((tab) => activate(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "activate-wingman") activate(tab);
});

async function activate(tab) {
  if (!tab || !tab.id) return;
  if (!/^https?:\/\//i.test(tab.url || "")) {
    return notify("Wingman can't capture this page (try a normal http/https tab).");
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "WM_ACTIVATE" });
  } catch (err) {
    notify("Wingman isn't active on this tab yet — reload the page and try again.");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "WM_CAPTURE" && sender.tab) {
    chrome.tabs
      .captureVisibleTab(sender.tab.windowId, { format: "png" })
      .then((screenshot) => sendResponse({ ok: true, screenshot }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "WM_TRANSCRIBE") {
    transcribe(msg.audioBase64, msg.mime)
      .then((transcript) => sendResponse({ ok: true, transcript }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "WM_EXTRACT") {
    groqKey()
      .then((key) => groq.extractFields(key, msg.transcript))
      .then((fields) => sendResponse({ ok: true, fields }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "WM_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
});

async function groqKey() {
  const { "wingman:settings": s } = await chrome.storage.local.get("wingman:settings");
  const key = s && s.groqApiKey;
  if (!key) throw new Error("Missing Groq API key (set it in Wingman options).");
  return key;
}

async function transcribe(audioBase64, mime) {
  const key = await groqKey();
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || "audio/webm" });
  return groq.transcribe(key, blob);
}

function notify(message) {
  chrome.notifications?.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Wingman",
    message,
  });
}
