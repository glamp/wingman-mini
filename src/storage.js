// Thin wrapper over chrome.storage.local. All Wingman settings live under one key.
(function () {
  const KEY = "wingman:settings";

  const DEFAULTS = {
    apiKey: "",
    token: "",
    reporterName: "",
    boardId: "",
    boardName: "",
    listId: "",
    listName: "",
    defaultLabels: "", // comma-separated label names
    groqApiKey: "", // for voice transcription + form auto-fill
    // Cloudflare Worker (R2) fallback for files too large for Trello's 10 MB limit.
    r2UploadUrl: "https://wingman-files.lamp-greg.workers.dev/upload",
    r2UploadToken: "b67d73ec257da9774b56795f96976569",
  };

  async function getSettings() {
    try {
      const result = await chrome.storage.local.get(KEY);
      return Object.assign({}, DEFAULTS, result[KEY] || {});
    } catch (err) {
      console.error("Wingman: failed to read settings", err);
      return Object.assign({}, DEFAULTS);
    }
  }

  // Merge a partial update into the saved settings.
  async function saveSettings(partial) {
    const current = await getSettings();
    const next = Object.assign({}, current, partial);
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.storage = { getSettings, saveSettings, DEFAULTS };
})();
