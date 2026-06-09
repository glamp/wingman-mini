// Options page: configure Trello credentials, pick a board + list from dropdowns,
// and save everything to chrome.storage.local.
(function () {
  const { storage, trello } = globalThis.Wingman;

  const $ = (id) => document.getElementById(id);
  const els = {
    apiKey: $("apiKey"),
    token: $("token"),
    reporterName: $("reporterName"),
    defaultLabels: $("defaultLabels"),
    groqApiKey: $("groqApiKey"),
    r2UploadUrl: $("r2UploadUrl"),
    r2UploadToken: $("r2UploadToken"),
    board: $("board"),
    list: $("list"),
    testBtn: $("testBtn"),
    testMsg: $("testMsg"),
    saveBtn: $("saveBtn"),
    saveMsg: $("saveMsg"),
  };

  let saved = null;

  function auth() {
    return { apiKey: els.apiKey.value.trim(), token: els.token.value.trim() };
  }

  function msg(node, text, kind) {
    node.textContent = text;
    node.className = "wm-inline-msg wm-inline-" + (kind || "info");
  }

  function fillSelect(select, items, placeholder) {
    select.innerHTML = "";
    select.append(new Option(placeholder, ""));
    for (const it of items) select.append(new Option(it.name, it.id));
    select.disabled = items.length === 0;
  }

  // ---- load existing settings ----
  async function init() {
    saved = await storage.getSettings();
    els.apiKey.value = saved.apiKey;
    els.token.value = saved.token;
    els.reporterName.value = saved.reporterName;
    els.defaultLabels.value = saved.defaultLabels;
    els.groqApiKey.value = saved.groqApiKey;
    els.r2UploadUrl.value = saved.r2UploadUrl;
    els.r2UploadToken.value = saved.r2UploadToken;

    // If we already have credentials, populate the dropdowns and re-select.
    if (saved.apiKey && saved.token) {
      await loadBoards(saved.boardId);
      if (saved.boardId) await loadLists(saved.boardId, saved.listId);
    }
  }

  async function loadBoards(selectId) {
    const boards = await trello.getBoards(auth());
    fillSelect(els.board, boards, "Select a board…");
    if (selectId) els.board.value = selectId;
  }

  async function loadLists(boardId, selectId) {
    fillSelect(els.list, [], "Loading…");
    const lists = await trello.getListsForBoard(auth(), boardId);
    fillSelect(els.list, lists, "Select a list…");
    if (selectId) els.list.value = selectId;
  }

  // ---- events ----
  els.testBtn.addEventListener("click", async () => {
    msg(els.testMsg, "Connecting…", "info");
    try {
      const me = await trello.testConnection(auth());
      msg(els.testMsg, `Connected as ${me.fullName || me.username}.`, "success");
      await loadBoards(els.board.value || saved.boardId);
      if (els.board.value) await loadLists(els.board.value, saved.listId);
    } catch (err) {
      msg(els.testMsg, err.message, "error");
    }
  });

  els.board.addEventListener("change", async () => {
    if (!els.board.value) {
      fillSelect(els.list, [], "Select a board first…");
      return;
    }
    msg(els.testMsg, "", "info");
    try {
      await loadLists(els.board.value);
    } catch (err) {
      msg(els.testMsg, err.message, "error");
    }
  });

  els.saveBtn.addEventListener("click", async () => {
    const boardName = els.board.selectedOptions[0]?.textContent || "";
    const listName = els.list.selectedOptions[0]?.textContent || "";
    try {
      await storage.saveSettings({
        apiKey: els.apiKey.value.trim(),
        token: els.token.value.trim(),
        reporterName: els.reporterName.value.trim(),
        defaultLabels: els.defaultLabels.value.trim(),
        groqApiKey: els.groqApiKey.value.trim(),
        r2UploadUrl: els.r2UploadUrl.value.trim(),
        r2UploadToken: els.r2UploadToken.value.trim(),
        boardId: els.board.value,
        boardName: els.board.value ? boardName : "",
        listId: els.list.value,
        listName: els.list.value ? listName : "",
      });
      saved = await storage.getSettings();
      msg(els.saveMsg, "Saved.", "success");
    } catch (err) {
      msg(els.saveMsg, "Could not save: " + err.message, "error");
    }
  });

  init().catch((err) => msg(els.testMsg, err.message, "error"));
})();
