// Trello REST API helpers. Used from both the options page and the in-page overlay.
// Every call appends the saved key + token. Functions throw Error with clear,
// user-facing messages; callers catch and display them.
(function () {
  const BASE = "https://api.trello.com/1";

  function requireAuth(auth) {
    if (!auth || !auth.apiKey) throw new Error("Missing Trello API key.");
    if (!auth.token) throw new Error("Missing Trello token.");
  }

  // Build a URL with key/token and any extra query params.
  function url(path, auth, params) {
    const u = new URL(BASE + path);
    u.searchParams.set("key", auth.apiKey);
    u.searchParams.set("token", auth.token);
    for (const [k, v] of Object.entries(params || {})) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async function getJson(res, whatFailed) {
    if (res.status === 401) throw new Error("Invalid Trello credentials.");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${whatFailed} (HTTP ${res.status}). ${text}`.trim());
    }
    return res.json();
  }

  // GET /members/me — verifies credentials, returns the member.
  async function testConnection(auth) {
    requireAuth(auth);
    const res = await fetch(url("/members/me", auth, { fields: "fullName,username" }));
    return getJson(res, "Could not connect to Trello");
  }

  async function getBoards(auth) {
    requireAuth(auth);
    const res = await fetch(
      url("/members/me/boards", auth, { fields: "name", filter: "open" })
    );
    return getJson(res, "Could not fetch boards");
  }

  async function getListsForBoard(auth, boardId) {
    requireAuth(auth);
    if (!boardId) throw new Error("No board selected.");
    const res = await fetch(
      url(`/boards/${boardId}/lists`, auth, { fields: "name", filter: "open" })
    );
    return getJson(res, "Could not fetch lists");
  }

  // Match comma-separated label names against the board's labels. Unmatched names
  // are skipped quietly. Returns an array of label IDs.
  async function resolveLabelIds(auth, boardId, names) {
    const wanted = (names || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!wanted.length || !boardId) return [];
    const res = await fetch(
      url(`/boards/${boardId}/labels`, auth, { fields: "name,color", limit: "1000" })
    );
    const labels = await getJson(res, "Could not fetch labels");
    return labels
      .filter((l) => l.name && wanted.includes(l.name.toLowerCase()))
      .map((l) => l.id);
  }

  // POST /cards — returns { id, shortUrl }.
  async function createCard(auth, { listId, name, desc, labelIds }) {
    requireAuth(auth);
    if (!listId) throw new Error("No list selected.");
    const params = { idList: listId, name, desc };
    if (labelIds && labelIds.length) params.idLabels = labelIds.join(",");
    const res = await fetch(url("/cards", auth, params), { method: "POST" });
    if (res.status === 401) throw new Error("Invalid Trello credentials.");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to create the Trello card (HTTP ${res.status}). ${text}`.trim());
    }
    return res.json();
  }

  // POST /cards/{id}/attachments — uploads a Blob as a multipart file.
  async function attachToCard(auth, cardId, blob, filename) {
    requireAuth(auth);
    const form = new FormData();
    form.append("file", blob, filename);
    const res = await fetch(url(`/cards/${cardId}/attachments`, auth), {
      method: "POST",
      body: form,
    });
    if (res.status === 401) throw new Error("Invalid Trello credentials.");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Failed to attach "${filename}" (HTTP ${res.status}). ${text}`.trim()
      );
    }
    return res.json();
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.trello = {
    testConnection,
    getBoards,
    getListsForBoard,
    resolveLabelIds,
    createCard,
    attachToCard,
  };
})();
