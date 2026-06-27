// Service worker: triggers the in-page overlay, captures clean screenshots on demand, and
// proxies Groq calls (which can't be made from a content script due to CORS).
importScripts("groq.js");

const { groq } = globalThis.Wingman;

chrome.action.onClicked.addListener((tab) => activate(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "activate-wingman") activate(tab);
});

// Read straight from manifest.json so the globalThis.Wingman.* dependency chain loads
// correctly (and in the same order) when we inject programmatically. Deriving it here
// instead of keeping a second hand-maintained copy means the two can never drift. Each entry
// carries its own world (the console-capture entry runs in MAIN, the rest in ISOLATED).
const CONTENT_SCRIPT_ENTRIES = chrome.runtime.getManifest().content_scripts;

// ---- offscreen recording coordination ----
// The actual recording lives in an offscreen document (src/offscreen.html) so it survives
// reloads of the tab being recorded. This service worker owns the lifecycle and relays
// messages between the page UI and the offscreen recorder. The recording phase is mirrored
// into chrome.storage so it survives the service worker itself being torn down, and so a
// freshly-injected content script can tell whether to re-attach the on-screen controls.
const OFFSCREEN_URL = "src/offscreen.html";
const REC_KEY = "wingman:recording";

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DISPLAY_MEDIA", "USER_MEDIA"],
    justification: "Record the screen and microphone so the capture survives page reloads.",
  });
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

async function getRec() {
  const out = await chrome.storage.local.get(REC_KEY);
  return out[REC_KEY] || null;
}

async function setRec(value) {
  if (value) await chrome.storage.local.set({ [REC_KEY]: value });
  else await chrome.storage.local.remove(REC_KEY);
}

async function activate(tab) {
  if (!tab || !tab.id) return;
  if (!/^https?:\/\//i.test(tab.url || "")) {
    return notify("Wingman can't capture this page (try a normal http/https tab).");
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "WM_ACTIVATE" });
  } catch (err) {
    // Content script not present (e.g. the tab predates install — declarative content
    // scripts only inject into pages loaded after the extension was enabled). Inject the
    // scripts on demand, then retry. Trying sendMessage first means already-injected tabs
    // never get a second copy of the listeners/overlay.
    try {
      // Inject each manifest entry into its declared world. Note: because this runs after the
      // page already loaded, the MAIN-world console capture only buffers logs from here on —
      // predate-install tabs have no history. Normal (declaratively-injected) tabs are fine.
      for (const entry of CONTENT_SCRIPT_ENTRIES) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: entry.js,
          world: entry.world || "ISOLATED",
        });
      }
      await chrome.tabs.sendMessage(tab.id, { type: "WM_ACTIVATE" });
    } catch (injectErr) {
      notify("Wingman couldn't start on this page. Try reloading and clicking again.");
    }
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

  // ---- recording relays (page <-> offscreen) ----

  if (msg.type === "WM_START_RECORDING") {
    (async () => {
      const existing = await getRec();
      if (existing && existing.phase === "recording") {
        return { ok: false, error: "A recording is already in progress." };
      }
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({ type: "WM_OFFSCREEN_START" }).catch(
        () => null
      );
      if (res && res.ok) {
        await setRec({ phase: "recording", tabId: sender.tab && sender.tab.id, startedAt: Date.now() });
        return { ok: true };
      }
      await closeOffscreen();
      return { ok: false, error: (res && res.error) || "Could not start recording." };
    })().then(sendResponse);
    return true;
  }

  if (msg.type === "WM_STOP_RECORDING") {
    (async () => {
      const res = await chrome.runtime.sendMessage({ type: "WM_OFFSCREEN_STOP" }).catch(
        () => null
      );
      if (res && res.ok) {
        const rec = await getRec();
        if (rec) await setRec({ ...rec, phase: "done" });
      }
      return res || { ok: false, error: "No recording to stop." };
    })().then(sendResponse);
    return true;
  }

  if (msg.type === "WM_SUBMIT_RECORDING") {
    (async () => {
      const res = await chrome.runtime
        .sendMessage({ type: "WM_OFFSCREEN_SUBMIT", payload: msg.payload })
        .catch(() => null);
      if (res && res.ok) {
        await setRec(null);
        await closeOffscreen();
      }
      return res || { ok: false, error: "Could not create the card." };
    })().then(sendResponse);
    return true;
  }

  if (msg.type === "WM_DISCARD_RECORDING") {
    (async () => {
      await chrome.runtime.sendMessage({ type: "WM_OFFSCREEN_DISCARD" }).catch(() => {});
      await setRec(null);
      await closeOffscreen();
      return { ok: true };
    })().then(sendResponse);
    return true;
  }

  if (msg.type === "WM_RECORDING_STATUS") {
    (async () => {
      const rec = await getRec();
      const tabId = sender.tab && sender.tab.id;
      if (rec && rec.tabId === tabId) return { phase: rec.phase || "recording" };
      return { phase: null };
    })().then(sendResponse);
    return true;
  }

  // Native "Stop sharing" ended the capture inside the offscreen doc. Flip phase to "done"
  // and tell the recording tab so it can show the review panel.
  if (msg.type === "WM_OFFSCREEN_ENDED") {
    (async () => {
      const rec = await getRec();
      if (!rec) return;
      await setRec({ ...rec, phase: "done" });
      if (rec.tabId != null) {
        chrome.tabs
          .sendMessage(rec.tabId, {
            type: "WM_RECORDING_ENDED",
            posterBase64: msg.posterBase64,
            posterType: msg.posterType,
            audioBase64: msg.audioBase64,
            audioType: msg.audioType,
            segmentCount: msg.segmentCount,
          })
          .catch(() => {});
      }
    })();
    return false;
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
  const { text, language } = await groq.transcribe(key, blob);
  // Translate to English when Whisper detects a non-English language so the transcript,
  // auto-filled form, and Trello card all come out in English.
  const lang = (language || "").toLowerCase();
  const isEnglish = !lang || lang === "english" || lang === "en";
  return isEnglish ? text : groq.translate(key, text);
}

function notify(message) {
  chrome.notifications?.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Wingman",
    message,
  });
}
