// Report window logic: gate on setup, load the stored screenshot + context, let the user
// crop / record / narrate, transcribe + auto-fill via Groq, and create a Trello card.
(function () {
  const { storage, markdown, trello, capture, groq } = globalThis.Wingman;
  const $ = (id) => document.getElementById(id);

  const state = {
    screenshot: null,
    context: {},
    mode: "screenshot", // "screenshot" | "recording"
    cropRect: null,
    recorder: null,
    micRecorder: null,
    videoBlob: null,
    posterBlob: null,
    audioBlob: null,
    transcript: "",
  };

  // ---- init ----
  async function init() {
    const settings = await storage.getSettings();

    // Not configured yet → show the setup screen instead of the app.
    if (!settings.apiKey || !settings.token || !settings.listId || !settings.groqApiKey) {
      showSetup();
      return;
    }

    const { "wingman:capture": cap } = await chrome.storage.local.get("wingman:capture");
    if (!cap) {
      $("shotHint").textContent = "No capture found. Close this window and try again.";
      return;
    }
    state.screenshot = cap.screenshot;
    state.context = cap.context || {};
    $("shotImg").src = state.screenshot;
    chrome.storage.local.remove("wingman:capture");

    wireTabs();
    wireCrop();
    wireRecording();
    wireMic();
    $("submit").addEventListener("click", submit);
  }

  function showSetup() {
    $("appContent").hidden = true;
    $("footer").hidden = true;
    $("setup").hidden = false;
    $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  }

  // ---- tabs ----
  function wireTabs() {
    $("tabScreenshot").addEventListener("click", () => setMode("screenshot"));
    $("tabRecording").addEventListener("click", () => setMode("recording"));
  }

  function setMode(mode) {
    state.mode = mode;
    $("tabScreenshot").classList.toggle("is-active", mode === "screenshot");
    $("tabRecording").classList.toggle("is-active", mode === "recording");
    $("screenshotSection").hidden = mode !== "screenshot";
    $("recordingSection").hidden = mode !== "recording";
  }

  // ---- crop ----
  function wireCrop() {
    const img = $("shotImg");
    const sel = $("sel");
    const useFull = $("useFull");
    let start = null;

    const point = (e) => {
      const r = img.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
      const y = Math.min(Math.max(e.clientY - r.top, 0), r.height);
      return { x, y, sx: img.naturalWidth / r.width, sy: img.naturalHeight / r.height };
    };

    img.addEventListener("mousedown", (e) => {
      e.preventDefault();
      start = point(e);
      sel.hidden = false;
      Object.assign(sel.style, { left: start.x + "px", top: start.y + "px", width: "0px", height: "0px" });
    });

    window.addEventListener("mousemove", (e) => {
      if (!start) return;
      const p = point(e);
      Object.assign(sel.style, {
        left: Math.min(start.x, p.x) + "px",
        top: Math.min(start.y, p.y) + "px",
        width: Math.abs(p.x - start.x) + "px",
        height: Math.abs(p.y - start.y) + "px",
      });
    });

    window.addEventListener("mouseup", (e) => {
      if (!start) return;
      const p = point(e);
      const w = Math.abs(p.x - start.x);
      const h = Math.abs(p.y - start.y);
      if (w > 8 && h > 8) {
        state.cropRect = {
          x: Math.min(start.x, p.x) * start.sx,
          y: Math.min(start.y, p.y) * start.sy,
          width: w * start.sx,
          height: h * start.sy,
        };
        $("shotHint").textContent = "Cropped region selected.";
        useFull.hidden = false;
      }
      start = null;
    });

    useFull.addEventListener("click", () => {
      state.cropRect = null;
      sel.hidden = true;
      useFull.hidden = true;
      $("shotHint").textContent = "Drag on the image to crop.";
    });
  }

  // ---- screen recording (with mic narration) ----
  function wireRecording() {
    $("startRec").addEventListener("click", startRec);
    $("recAgain").addEventListener("click", () => {
      state.videoBlob = null;
      state.posterBlob = null;
      $("recordDone").hidden = true;
      $("recordIdle").hidden = false;
    });
  }

  async function startRec() {
    try {
      const rec = await capture.startRecording({ onEnded: stopRec });
      state.recorder = rec;
      $("startRec").textContent = "Stop recording";
      $("startRec").onclick = stopRec;
    } catch (err) {
      showMsg(err.message, "error");
    }
  }

  async function stopRec() {
    if (!state.recorder) return;
    const rec = state.recorder;
    state.recorder = null;
    $("startRec").textContent = "Start recording";
    $("startRec").onclick = startRec;
    try {
      const { videoBlob, audioBlob } = await rec.stop();
      state.videoBlob = videoBlob;
      state.audioBlob = audioBlob;
      state.posterBlob = await capture.posterFromVideoBlob(videoBlob).catch(() => null);
      $("recVideo").src = URL.createObjectURL(videoBlob);
      $("recordIdle").hidden = true;
      $("recordDone").hidden = false;
      if (audioBlob) transcribeAndFill(audioBlob);
      else voiceStatus("No microphone audio captured — fill the form manually.", "info");
    } catch (err) {
      showMsg(err.message, "error");
    }
  }

  // ---- mic recording (screenshot mode) ----
  function wireMic() {
    $("micBtn").addEventListener("click", toggleMic);
  }

  async function toggleMic() {
    if (state.micRecorder) {
      const rec = state.micRecorder;
      state.micRecorder = null;
      $("micBtn").textContent = "🎙 Record voice";
      const blob = await rec.stop();
      state.audioBlob = blob;
      transcribeAndFill(blob);
      return;
    }
    try {
      state.micRecorder = await capture.recordMic();
      $("micBtn").textContent = "⏹ Stop voice";
      voiceStatus("Recording… speak now, then click Stop.", "info");
    } catch (err) {
      voiceStatus(err.message, "error");
    }
  }

  // ---- transcription + auto-fill ----
  async function transcribeAndFill(audioBlob) {
    if (!audioBlob) return;
    const settings = await storage.getSettings();
    if (!settings.groqApiKey) {
      voiceStatus("Add a Groq key in options to transcribe and auto-fill.", "info");
      return;
    }
    try {
      voiceStatus("Transcribing…", "info");
      const transcript = await groq.transcribe(settings.groqApiKey, audioBlob);
      state.transcript = transcript;
      $("transcript").value = transcript;
      $("transcriptField").hidden = !transcript;

      if (!transcript) {
        voiceStatus("No speech detected.", "info");
        return;
      }

      voiceStatus("Filling form…", "info");
      const fields = await groq.extractFields(settings.groqApiKey, transcript);
      fillForm(fields);
      voiceStatus("Done — review and edit before submitting.", "success");
    } catch (err) {
      voiceStatus(err.message, "error");
    }
  }

  function fillForm(fields) {
    // Always set the selects (they have valid defaults); only overwrite text fields when
    // the model actually produced something.
    if (fields.type) $("type").value = fields.type;
    if (fields.severity) $("severity").value = fields.severity;
    for (const k of ["title", "whatHappened", "expectedBehavior", "stepsToReproduce", "notes"]) {
      if (fields[k]) $(k).value = fields[k];
    }
  }

  function voiceStatus(text, kind) {
    const s = $("voiceStatus");
    s.hidden = false;
    s.className = "wm-voice-status wm-msg-" + (kind || "info");
    s.textContent = text;
  }

  // ---- submit ----
  function readForm() {
    return {
      type: $("type").value,
      title: $("title").value,
      whatHappened: $("whatHappened").value,
      expectedBehavior: $("expectedBehavior").value,
      stepsToReproduce: $("stepsToReproduce").value,
      severity: $("severity").value,
      notes: $("notes").value,
    };
  }

  function showMsg(text, kind, node) {
    const m = $("msg");
    m.hidden = false;
    m.className = "wm-msg wm-msg-" + (kind || "info");
    m.textContent = "";
    m.append(node || document.createTextNode(text));
  }

  async function submit() {
    const fields = readForm();
    if (!fields.title.trim()) return showMsg("Please enter a title.", "error");

    const settings = await storage.getSettings();
    const auth = { apiKey: settings.apiKey, token: settings.token };
    if (!auth.apiKey) return showMsg("Missing Trello API key. Open Wingman options.", "error");
    if (!auth.token) return showMsg("Missing Trello token. Open Wingman options.", "error");
    if (!settings.listId) return showMsg("No Trello list selected. Open Wingman options.", "error");
    if (state.mode === "recording" && !state.videoBlob) {
      return showMsg("Record a video first, or switch to Screenshot.", "error");
    }

    $("submit").disabled = true;
    showMsg("Creating card…", "info");

    try {
      const context = {
        url: state.context.url || "",
        pageTitle: state.context.title || "",
        userAgent: state.context.userAgent || navigator.userAgent,
        viewportWidth: state.context.viewportWidth || "",
        viewportHeight: state.context.viewportHeight || "",
        timestamp: new Date().toISOString(),
        reporterName: settings.reporterName,
      };

      const name = markdown.buildTitle(fields);
      const desc = markdown.buildDescription(fields, context, state.mode, state.transcript);
      const labelIds = await trello
        .resolveLabelIds(auth, settings.boardId, settings.defaultLabels)
        .catch(() => []);

      const card = await trello.createCard(auth, { listId: settings.listId, name, desc, labelIds });

      if (state.mode === "recording") {
        await trello.attachToCard(auth, card.id, state.videoBlob, "recording.webm");
        if (state.posterBlob) await trello.attachToCard(auth, card.id, state.posterBlob, "poster.png");
      } else {
        const blob = state.cropRect
          ? await capture.cropDataUrl(state.screenshot, state.cropRect)
          : capture.dataUrlToBlob(state.screenshot);
        await trello.attachToCard(auth, card.id, blob, "screenshot.png");
      }

      const link = document.createElement("a");
      link.href = card.shortUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "wm-link";
      link.textContent = "Open the Trello card →";
      const wrap = document.createElement("span");
      wrap.append("Card created. ", link);
      showMsg(null, "success", wrap);
      $("submit").textContent = "Done";
    } catch (err) {
      $("submit").disabled = false;
      showMsg(err.message || "Something went wrong.", "error");
    }
  }

  init();
})();
