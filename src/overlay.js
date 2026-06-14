// The in-page capture/report UI, rendered inside a Shadow DOM root (style-isolated).
// Talks to Trello directly (CORS-friendly) and proxies Groq through the background.
(function () {
  const { storage, markdown, trello, capture, r2 } = globalThis.Wingman;

  const MARKUP = `
    <div class="wm-backdrop">
      <div class="wm-panel">
        <header class="wm-header">
          <div>
            <div class="wm-title">Wingman</div>
            <div class="wm-subtitle">File a bug or feedback to Trello</div>
          </div>
          <button id="close" class="wm-close" title="Close (Esc)">&times;</button>
        </header>

        <main class="wm-body">
          <section id="setup" class="wm-setup" hidden>
            <div class="wm-setup-icon">&#9881;&#65039;</div>
            <h2>Finish setting up Wingman</h2>
            <p class="wm-hint" id="setupMsg">
              Before you can file a report, add your Trello API key, token, board &amp; list,
              and your Groq API key.
            </p>
            <button id="openOptions" class="wm-btn wm-btn-primary">Open Wingman settings</button>
          </section>

          <div id="appContent">
            <div class="wm-tabs">
              <button id="tabScreenshot" class="wm-tab is-active">Screenshot</button>
              <button id="tabRecording" class="wm-tab">Screen recording</button>
            </div>

            <section id="screenshotSection">
              <div class="wm-shot">
                <img id="shotImg" class="wm-shotimg" alt="screenshot" />
                <div id="sel" class="wm-sel" hidden></div>
              </div>
              <div class="wm-shotbar">
                <span id="shotHint" class="wm-hint">Drag on the image to crop.</span>
                <button id="useFull" class="wm-link" hidden>Use full screenshot</button>
              </div>
              <div class="wm-voice">
                <button id="micBtn" class="wm-btn">&#127908; Record voice</button>
                <span class="wm-hint">Describe the bug out loud to auto-fill the form.</span>
              </div>
            </section>

            <section id="recordingSection" hidden>
              <div id="recordIdle">
                <p class="wm-hint">
                  Pick a tab, window, or screen and narrate as you go. We'll record your mic
                  and transcribe it. Stop when you're done.
                </p>
                <button id="startRec" class="wm-btn">Start recording</button>
              </div>
              <div id="recordDone" hidden>
                <video id="recVideo" class="wm-video" controls></video>
                <div class="wm-shotbar">
                  <span class="wm-hint">Recording ready to attach.</span>
                  <button id="recAgain" class="wm-link">Record again</button>
                </div>
              </div>
            </section>

            <div id="voiceStatus" class="wm-voice-status" hidden></div>

            <form id="form" class="wm-form" onsubmit="return false">
              <label class="wm-field" id="transcriptField" hidden>
                <span class="wm-label">Transcript</span>
                <textarea id="transcript" class="wm-input wm-textarea" readonly></textarea>
              </label>
              <div class="wm-row">
                <label class="wm-field">
                  <span class="wm-label">Type</span>
                  <select id="type" class="wm-input">
                    <option value="bug">Bug</option>
                    <option value="feedback">Feedback</option>
                    <option value="feature">New Feature</option>
                  </select>
                </label>
                <label class="wm-field">
                  <span class="wm-label">Severity</span>
                  <select id="severity" class="wm-input">
                    <option>Low</option>
                    <option selected>Medium</option>
                    <option>High</option>
                    <option>Critical</option>
                  </select>
                </label>
              </div>
              <label class="wm-field">
                <span class="wm-label">Title</span>
                <input id="title" class="wm-input" type="text" placeholder="Short summary" />
              </label>
              <label class="wm-field">
                <span class="wm-label">What happened?</span>
                <textarea id="whatHappened" class="wm-input wm-textarea" placeholder="What did you see?"></textarea>
              </label>
              <label class="wm-field">
                <span class="wm-label">Expected behavior</span>
                <textarea id="expectedBehavior" class="wm-input wm-textarea" placeholder="What did you expect?"></textarea>
              </label>
              <label class="wm-field">
                <span class="wm-label">Steps to reproduce</span>
                <textarea id="stepsToReproduce" class="wm-input wm-textarea" placeholder="1.&#10;2.&#10;3."></textarea>
              </label>
              <label class="wm-field">
                <span class="wm-label">Notes</span>
                <textarea id="notes" class="wm-input wm-textarea" placeholder="Anything else? (optional)"></textarea>
              </label>
            </form>
          </div>
        </main>

        <footer class="wm-footer" id="footer">
          <span id="msg" class="wm-msg" hidden></span>
          <button id="submit" class="wm-btn wm-btn-primary" title="Submit (Cmd/Ctrl+Enter)">Create Trello card</button>
        </footer>
      </div>
    </div>
  `;

  let state = null;

  function mount(host, root, screenshot, css, consoleLogs = []) {
    root.innerHTML = `<style>${css}</style>` + MARKUP;
    const $ = (id) => root.getElementById(id);

    state = {
      host,
      root,
      $,
      screenshot,
      mode: "screenshot",
      cropRect: null,
      recorder: null,
      micRecorder: null,
      videoBlobs: [],
      posterBlob: null,
      audioBlob: null,
      transcript: "",
      consoleLogs: Array.isArray(consoleLogs) ? consoleLogs : [],
      stopBar: null,
      onMove: null,
      onUp: null,
    };

    $("close").addEventListener("click", close);
    const backdrop = root.querySelector(".wm-backdrop");
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", onKeydown, true);

    init();
  }

  function onKeydown(e) {
    if (!state) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      // Cmd+Enter (Mac) / Ctrl+Enter (Win/Linux) submits the form.
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  }

  function close() {
    if (!state) return;
    document.removeEventListener("keydown", onKeydown, true);
    if (state.onMove) window.removeEventListener("mousemove", state.onMove);
    if (state.onUp) window.removeEventListener("mouseup", state.onUp);
    removeStopBar();
    state.host.remove();
    state = null;
  }

  async function init() {
    const { $ } = state;
    const settings = await storage.getSettings();
    if (!settings.apiKey || !settings.token || !settings.listId || !settings.groqApiKey) {
      $("appContent").hidden = true;
      $("footer").hidden = true;
      $("setup").hidden = false;
      $("openOptions").addEventListener("click", () =>
        chrome.runtime.sendMessage({ type: "WM_OPEN_OPTIONS" })
      );
      return;
    }

    $("shotImg").src = state.screenshot;
    wireTabs();
    wireCrop();
    wireRecording();
    wireMic();
    $("submit").addEventListener("click", submit);
  }

  // ---- tabs ----
  function wireTabs() {
    const { $ } = state;
    $("tabScreenshot").addEventListener("click", () => setMode("screenshot"));
    $("tabRecording").addEventListener("click", () => setMode("recording"));
  }

  function setMode(mode) {
    const { $ } = state;
    state.mode = mode;
    $("tabScreenshot").classList.toggle("is-active", mode === "screenshot");
    $("tabRecording").classList.toggle("is-active", mode === "recording");
    $("screenshotSection").hidden = mode !== "screenshot";
    $("recordingSection").hidden = mode !== "recording";
  }

  // ---- crop ----
  function wireCrop() {
    const { $ } = state;
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

    state.onMove = (e) => {
      if (!start) return;
      const p = point(e);
      Object.assign(sel.style, {
        left: Math.min(start.x, p.x) + "px",
        top: Math.min(start.y, p.y) + "px",
        width: Math.abs(p.x - start.x) + "px",
        height: Math.abs(p.y - start.y) + "px",
      });
    };
    state.onUp = (e) => {
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
    };
    window.addEventListener("mousemove", state.onMove);
    window.addEventListener("mouseup", state.onUp);

    useFull.addEventListener("click", () => {
      state.cropRect = null;
      sel.hidden = true;
      useFull.hidden = true;
      $("shotHint").textContent = "Drag on the image to crop.";
    });
  }

  // ---- screen recording (with mic narration) ----
  function wireRecording() {
    const { $ } = state;
    $("startRec").addEventListener("click", startRec);
    $("recAgain").addEventListener("click", () => {
      state.videoBlobs = [];
      state.posterBlob = null;
      $("recordDone").hidden = true;
      $("recordIdle").hidden = false;
    });
  }

  async function startRec() {
    const { $ } = state;
    try {
      const rec = await capture.startRecording({ onEnded: stopRec });
      state.recorder = rec;
      // Hide the overlay so it isn't in the recording; show a floating stop bar.
      state.host.style.display = "none";
      showStopBar();
    } catch (err) {
      showMsg(err.message, "error");
    }
  }

  async function stopRec() {
    if (!state || !state.recorder) return;
    removeStopBar();
    const { $ } = state;
    const rec = state.recorder;
    state.recorder = null;
    state.host.style.display = "block";
    try {
      const { videoBlobs, audioBlob } = await rec.stop();
      state.videoBlobs = videoBlobs;
      state.audioBlob = audioBlob;
      // Poster + preview use the first segment.
      state.posterBlob = await capture.posterFromVideoBlob(videoBlobs[0]).catch(() => null);
      $("recVideo").src = URL.createObjectURL(videoBlobs[0]);
      $("recordIdle").hidden = true;
      $("recordDone").hidden = false;
      if (audioBlob) transcribeAndFill(audioBlob);
      else voiceStatus("No microphone audio captured — fill the form manually.", "info");
    } catch (err) {
      showMsg(err.message, "error");
    }
  }

  // Floating stop control lives OUTSIDE the shadow host so hiding the host (to keep the
  // overlay out of the recording) doesn't hide the stop button too.
  function showStopBar() {
    removeStopBar();
    const bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);" +
      "background:#1e293b;color:#fff;padding:8px 14px;border-radius:100px;display:flex;gap:10px;" +
      "align-items:center;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "box-shadow:0 8px 25px rgba(0,0,0,.35);";
    const dot = document.createElement("span");
    dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#ef4444;";
    const label = document.createElement("span");
    label.textContent = "Recording…";
    const btn = document.createElement("button");
    btn.textContent = "Stop";
    btn.style.cssText =
      "background:#ef4444;color:#fff;border:0;border-radius:100px;padding:5px 12px;font:inherit;cursor:pointer;";
    btn.onclick = stopRec;
    bar.append(dot, label, btn);
    document.body.append(bar);
    state.stopBar = bar;
  }

  function removeStopBar() {
    if (state && state.stopBar) {
      state.stopBar.remove();
      state.stopBar = null;
    }
  }

  // ---- mic recording (screenshot mode) ----
  function wireMic() {
    state.$("micBtn").addEventListener("click", toggleMic);
  }

  async function toggleMic() {
    const { $ } = state;
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

  // ---- transcription + auto-fill (Groq via background) ----
  async function transcribeAndFill(audioBlob) {
    if (!audioBlob) return;
    const { $ } = state;
    try {
      voiceStatus("Transcribing…", "info");
      const audioBase64 = await capture.blobToBase64(audioBlob);
      const tRes = await chrome.runtime.sendMessage({
        type: "WM_TRANSCRIBE",
        audioBase64,
        mime: audioBlob.type,
      });
      if (!tRes || !tRes.ok) throw new Error((tRes && tRes.error) || "Transcription failed.");

      const transcript = tRes.transcript || "";
      state.transcript = transcript;
      $("transcript").value = transcript;
      $("transcriptField").hidden = !transcript;
      if (!transcript) return voiceStatus("No speech detected.", "info");

      voiceStatus("Filling form…", "info");
      const eRes = await chrome.runtime.sendMessage({ type: "WM_EXTRACT", transcript });
      if (!eRes || !eRes.ok) throw new Error((eRes && eRes.error) || "Form auto-fill failed.");
      fillForm(eRes.fields);
      voiceStatus("Done — review and edit before submitting.", "success");
    } catch (err) {
      voiceStatus(err.message, "error");
    }
  }

  function fillForm(fields) {
    const { $ } = state;
    if (fields.type) $("type").value = fields.type;
    if (fields.severity) $("severity").value = fields.severity;
    for (const k of ["title", "whatHappened", "expectedBehavior", "stepsToReproduce", "notes"]) {
      if (fields[k]) $(k).value = fields[k];
    }
  }

  function voiceStatus(text, kind) {
    const s = state.$("voiceStatus");
    s.hidden = false;
    s.className = "wm-voice-status wm-msg-" + (kind || "info");
    s.textContent = text;
  }

  // ---- submit ----
  function readForm() {
    const { $ } = state;
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
    const m = state.$("msg");
    m.hidden = false;
    m.className = "wm-msg wm-msg-" + (kind || "info");
    m.textContent = "";
    m.append(node || document.createTextNode(text));
  }

  async function submit() {
    const { $ } = state;
    const fields = readForm();
    if (!fields.title.trim()) return showMsg("Please enter a title.", "error");

    const settings = await storage.getSettings();
    const auth = { apiKey: settings.apiKey, token: settings.token };
    if (!auth.apiKey) return showMsg("Missing Trello API key. Open Wingman options.", "error");
    if (!auth.token) return showMsg("Missing Trello token. Open Wingman options.", "error");
    if (!settings.listId) return showMsg("No Trello list selected. Open Wingman options.", "error");
    if (state.mode === "recording" && !state.videoBlobs.length) {
      return showMsg("Record a video first, or switch to Screenshot.", "error");
    }

    $("submit").disabled = true;
    showMsg("Creating card…", "info");

    try {
      const context = {
        url: location.href,
        pageTitle: document.title,
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        timestamp: new Date().toISOString(),
        reporterName: settings.reporterName,
      };

      const name = markdown.buildTitle(fields);
      const desc = markdown.buildDescription(
        fields,
        context,
        state.mode,
        state.transcript,
        state.videoBlobs.length
      );
      const labelIds = await trello
        .resolveLabelIds(auth, settings.boardId, settings.defaultLabels)
        .catch(() => []);

      const card = await trello.createCard(auth, { listId: settings.listId, name, desc, labelIds });

      // Each attachment goes to Trello, or to R2 fallback storage if it's too large.
      const r2Links = [];
      const attach = async (blob, filename) => {
        const result = await r2.uploadAttachment(auth, card.id, blob, filename, settings);
        if (result.via === "r2") r2Links.push(result);
      };

      if (state.mode === "recording") {
        const blobs = state.videoBlobs;
        if (blobs.length === 1) {
          await attach(blobs[0], "recording.webm");
        } else {
          for (let i = 0; i < blobs.length; i++) {
            await attach(blobs[i], `recording-${i + 1}.webm`);
          }
        }
        if (state.posterBlob) await attach(state.posterBlob, "poster.png");
      } else {
        const blob = state.cropRect
          ? await capture.cropDataUrl(state.screenshot, state.cropRect)
          : capture.dataUrlToBlob(state.screenshot);
        await attach(blob, "screenshot.png");
      }

      // Attach the page's buffered console output (logs + uncaught errors) for the dev.
      if (state.consoleLogs.length) {
        const text = state.consoleLogs
          .map((l) => `[${l.time}] ${String(l.level).toUpperCase().padEnd(9)} ${l.text}`)
          .join("\n");
        await attach(new Blob([text], { type: "text/plain" }), "console-logs.txt");
      }

      // For anything stored in R2, also surface the link in the card description.
      if (r2Links.length) {
        const lines = r2Links.map((l) => `📎 [${l.filename}](${l.url})`).join("\n");
        await trello
          .updateCardDesc(auth, card.id, `${desc}\n\n## Media\n${lines}`)
          .catch(() => {}); // the URL attachments are already on the card; don't fail the submit
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

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.overlay = { mount, close };
})();
