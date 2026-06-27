// The in-page capture/report UI, rendered inside a Shadow DOM root (style-isolated).
// Talks to Trello directly for screenshots (CORS-friendly) and proxies Groq through the
// background. Screen recording lives in an offscreen document (so it survives page reloads)
// and is driven through the service worker; this file just shows the panel + the floating
// recording controls and re-attaches them when the page reloads mid-recording.
(function () {
  const { storage, markdown, trello, capture, r2, draw } = globalThis.Wingman;

  const HOST_ID = "wingman-host";

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
              <button id="tabScreenshot" class="wm-tab">Screenshot</button>
              <button id="tabRecording" class="wm-tab is-active">Screen recording</button>
            </div>

            <section id="screenshotSection" hidden>
              <div class="wm-shot">
                <img id="shotImg" class="wm-shotimg" alt="screenshot" />
                <div id="sel" class="wm-sel" hidden></div>
                <canvas id="drawCanvas" class="wm-draw" hidden></canvas>
              </div>
              <div class="wm-marktools">
                <button id="toolCrop" class="wm-marktool is-active" type="button">&#9986;&#65039; Crop</button>
                <button id="toolPen" class="wm-marktool" type="button">&#9999;&#65039; Draw</button>
                <span id="swatches" class="wm-swatches"></span>
                <button id="toolClear" class="wm-marktool" type="button">&#129533; Clear</button>
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

            <section id="recordingSection">
              <div id="recordIdle">
                <p class="wm-hint">
                  Pick a tab, window, or screen and narrate as you go. We'll record your mic
                  and transcribe it. Stop when you're done.
                </p>
                <button id="startRec" class="wm-btn">Start recording</button>
              </div>
              <div id="recordDone" hidden>
                <img id="recPoster" class="wm-video" alt="recording preview" hidden />
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

  let cssText = null;
  let state = null;
  // Floating recording controls (stop bar + live draw overlay). Kept separate from the panel
  // `state` so they can be shown WITHOUT a mounted panel — that's what lets the content script
  // re-attach them after the recorded page reloads (the panel is hidden during recording).
  let recordingUI = null; // { stopBar, drawOverlay, onStop }

  async function getCss() {
    if (cssText == null) {
      cssText = await fetch(chrome.runtime.getURL("src/styles.css"))
        .then((r) => r.text())
        .catch(() => "");
    }
    return cssText;
  }

  function makeHost() {
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);
    return { host, root };
  }

  // Mount the panel. `screenshot` is a data URL for the Screenshot tab (null when restored
  // after a reload — the Screenshot tab is then hidden since we have no clean capture).
  async function mountPanel({ screenshot = null, consoleLogs = [] } = {}) {
    const css = await getCss();
    const { host, root } = makeHost();
    root.innerHTML = `<style>${css}</style>` + MARKUP;
    const $ = (id) => root.getElementById(id);

    state = {
      host,
      root,
      $,
      screenshot,
      mode: "recording",
      tool: "crop",
      cropRect: null,
      drawSurface: null,
      micRecorder: null, // screenshot-mode voice memo (stays in-page; short-lived)
      audioBlob: null,
      transcript: "",
      segmentCount: 0, // > 0 once a recording is finished and pending submit
      submitted: false,
      consoleLogs: Array.isArray(consoleLogs) ? consoleLogs : [],
      onMove: null,
      onUp: null,
    };

    $("close").addEventListener("click", close);
    const backdrop = root.querySelector(".wm-backdrop");
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", onKeydown, true);

    await init();
    return state;
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
    // Abandon a finished-but-unsubmitted recording so it doesn't linger in the offscreen
    // doc or pop back up on the next page load.
    if (state.segmentCount && !state.submitted) {
      chrome.runtime.sendMessage({ type: "WM_DISCARD_RECORDING" }).catch(() => {});
    }
    removeRecordingControls();
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

    if (state.screenshot) {
      $("shotImg").src = state.screenshot;
    } else {
      // No clean screenshot (panel restored after a reload) — hide the Screenshot tab.
      $("tabScreenshot").hidden = true;
    }
    wireTabs();
    wireCrop();
    wireDraw();
    wireRecording();
    wireMic();
    $("submit").addEventListener("click", submit);
    setMode("recording");
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

  // ---- screenshot markup (draw on the preview, baked into the PNG on submit) ----
  function wireDraw() {
    const { $ } = state;
    const img = $("shotImg");
    const canvas = $("drawCanvas");

    // Size the canvas backing store to the screenshot's real pixels so the baked-in markup
    // is crisp; CSS stretches it over the (smaller) preview, and draw.js maps coordinates.
    const setup = () => {
      if (!img.naturalWidth || state.drawSurface) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      state.drawSurface = draw.createSurface(canvas, { color: draw.PALETTE[0] });
    };
    if (img.complete && img.naturalWidth) setup();
    else img.addEventListener("load", setup, { once: true });

    // Color swatches — single source of truth is draw.PALETTE.
    const swatches = $("swatches");
    draw.PALETTE.forEach((color, i) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "wm-swatch" + (i === 0 ? " is-active" : "");
      sw.style.background = color;
      sw.addEventListener("click", () => {
        swatches
          .querySelectorAll(".wm-swatch")
          .forEach((s) => s.classList.remove("is-active"));
        sw.classList.add("is-active");
        if (state.drawSurface) state.drawSurface.setColor(color);
        setDrawTool("pen");
      });
      swatches.append(sw);
    });

    $("toolCrop").addEventListener("click", () => setDrawTool("crop"));
    $("toolPen").addEventListener("click", () => setDrawTool("pen"));
    $("toolClear").addEventListener("click", () => {
      if (state.drawSurface) state.drawSurface.clear();
    });

    setDrawTool("crop");
  }

  function setDrawTool(tool) {
    const { $ } = state;
    state.tool = tool;
    const canvas = $("drawCanvas");
    canvas.hidden = false;
    // Crop: canvas is inert so the image's crop drag (wireCrop) works. Pen: the canvas
    // sits above the image and intercepts pointer events for drawing.
    canvas.style.pointerEvents = tool === "crop" ? "none" : "auto";
    $("toolCrop").classList.toggle("is-active", tool === "crop");
    $("toolPen").classList.toggle("is-active", tool === "pen");
    const hint = $("shotHint");
    if (tool === "crop") {
      hint.textContent = state.cropRect
        ? "Cropped region selected."
        : "Drag on the image to crop.";
    } else {
      hint.textContent = "Draw on the screenshot to highlight.";
    }
  }

  // ---- screen recording (handled in the offscreen doc, driven via the service worker) ----
  function wireRecording() {
    const { $ } = state;
    $("startRec").addEventListener("click", startRec);
    $("recAgain").addEventListener("click", recordAgain);
  }

  async function startRec() {
    const res = await chrome.runtime
      .sendMessage({ type: "WM_START_RECORDING" })
      .catch(() => null);
    if (!res || !res.ok) {
      showMsg((res && res.error) || "Could not start recording.", "error");
      return;
    }
    // Hide the panel so it isn't in the recording; show the floating controls + draw overlay.
    if (state) state.host.style.display = "none";
    showRecordingControls({ onStop: stopRecording });
  }

  async function recordAgain() {
    await chrome.runtime.sendMessage({ type: "WM_DISCARD_RECORDING" }).catch(() => {});
    if (!state) return;
    state.segmentCount = 0;
    state.transcript = "";
    state.$("recordDone").hidden = true;
    state.$("recordIdle").hidden = false;
  }

  // Stop the recording (from the stop bar, the panel, or a restored session) and flip the
  // panel into its "recording ready" review state. Safe to call without a mounted panel —
  // it mounts one. Idempotent on the offscreen side.
  async function stopRecording() {
    removeRecordingControls();
    const res = await chrome.runtime
      .sendMessage({ type: "WM_STOP_RECORDING" })
      .catch(() => null);
    if (!res || !res.ok) {
      if (state) {
        state.host.style.display = "block";
        showMsg((res && res.error) || "Could not stop recording.", "error");
      }
      return;
    }
    await showRecordingDone({ ...res, consoleLogs: state ? state.consoleLogs : [] });
  }

  // Show the panel in "recording ready" state given the small artifacts the offscreen doc
  // produced (poster + mic audio, both base64). Mounts a fresh panel if none is open (the
  // case after the recorded page reloaded and was then stopped).
  async function showRecordingDone(payload) {
    if (!state) {
      await mountPanel({ consoleLogs: payload.consoleLogs || [] });
    }
    if (!state) return;
    const { $ } = state;
    state.host.style.display = "block";
    setMode("recording");
    state.segmentCount = payload.segmentCount || 1;
    if (payload.posterBase64) {
      $("recPoster").src = `data:${payload.posterType || "image/png"};base64,${payload.posterBase64}`;
      $("recPoster").hidden = false;
    }
    $("recordIdle").hidden = true;
    $("recordDone").hidden = false;
    if (payload.audioBase64) transcribeAndFillBase64(payload.audioBase64, payload.audioType);
    else voiceStatus("No microphone audio captured — fill the form manually.", "info");
  }

  // ---- floating recording controls (light DOM, panel-independent) ----
  function showRecordingControls(opts = {}) {
    removeRecordingControls();
    recordingUI = { stopBar: null, drawOverlay: null, onStop: opts.onStop || stopRecording };
    showStopBar();
    showDrawOverlay();
  }

  function removeRecordingControls() {
    removeStopBar();
    removeDrawOverlay();
    recordingUI = null;
  }

  // Floating stop control. Lives in the light DOM (not the shadow host) so it stays visible
  // while the host is hidden, and so it can exist with no panel mounted at all.
  function showStopBar() {
    removeStopBar();
    if (!recordingUI) return;
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
    btn.onclick = () => {
      if (recordingUI && recordingUI.onStop) recordingUI.onStop();
    };
    bar.append(dot, label, btn);
    document.body.append(bar);
    recordingUI.stopBar = bar;
  }

  function removeStopBar() {
    if (recordingUI && recordingUI.stopBar) {
      recordingUI.stopBar.remove();
      recordingUI.stopBar = null;
    }
  }

  // Live-page markup during recording. A transparent full-viewport canvas plus a floating
  // tool palette, both in the light DOM (like the stop bar) so they survive the host being
  // hidden and a page reload re-creating them. getDisplayMedia captures the strokes straight
  // into the video — as long as the user is sharing the tab/window/screen that shows this
  // page. The canvas only intercepts pointer events while "Draw" is on, so the user can
  // otherwise click/scroll/demo freely.
  async function showDrawOverlay() {
    removeDrawOverlay();
    // Remember the pen mode the user last chose (defaults to permanent).
    const { drawMode } = await storage.getSettings();
    let vanishing = drawMode === "vanishing";
    if (!recordingUI) return; // stopped while awaiting settings
    const dpr = window.devicePixelRatio || 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none;";
    document.body.append(canvas);

    const surface = draw.createSurface(canvas, {
      color: draw.PALETTE[0],
      penWidth: Math.max(3, Math.round(3 * dpr)),
      fade: vanishing,
    });

    const bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;z-index:2147483647;bottom:60px;left:50%;transform:translateX(-50%);" +
      "background:#1e293b;padding:6px 10px;border-radius:100px;display:flex;gap:6px;" +
      "align-items:center;box-shadow:0 8px 25px rgba(0,0,0,.35);" +
      "font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    const BTN =
      "background:#334155;color:#fff;border:0;border-radius:100px;padding:4px 10px;" +
      "font:inherit;cursor:pointer;line-height:1.4;";
    const mkBtn = (label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = BTN;
      return b;
    };
    const setActive = (b, on) => {
      b.style.background = on ? "#3b82f6" : "#334155";
    };

    let annotate = false;
    const drawBtn = mkBtn("✏️ Draw");
    const vanishBtn = mkBtn("🪄 Vanishing");
    const clearBtn = mkBtn("🧽 Clear");

    const setAnnotate = (on) => {
      annotate = on;
      canvas.style.pointerEvents = on ? "auto" : "none";
      setActive(drawBtn, on);
      drawBtn.textContent = on ? "✓ Done" : "✏️ Draw";
    };

    // Vanishing pen: each stroke holds, then fades on its own clock. Remember the choice.
    const setVanishing = (on, persist) => {
      vanishing = on;
      surface.setFade(on);
      setActive(vanishBtn, on);
      if (persist) storage.saveSettings({ drawMode: on ? "vanishing" : "permanent" });
    };

    drawBtn.onclick = () => setAnnotate(!annotate);
    vanishBtn.onclick = () => setVanishing(!vanishing, true);
    clearBtn.onclick = () => surface.clear();

    setActive(vanishBtn, vanishing);
    bar.append(drawBtn, vanishBtn);
    draw.PALETTE.forEach((color, i) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.style.cssText =
        "width:16px;height:16px;padding:0;border-radius:50%;cursor:pointer;background:" +
        color +
        ";border:2px solid " +
        (i === 0 ? "#fff" : "transparent") + ";";
      sw.onclick = () => {
        bar
          .querySelectorAll("[data-swatch]")
          .forEach((s) => (s.style.borderColor = "transparent"));
        sw.style.borderColor = "#fff";
        surface.setColor(color);
        if (!annotate) setAnnotate(true);
      };
      sw.setAttribute("data-swatch", "1");
      bar.append(sw);
    });
    bar.append(clearBtn);

    document.body.append(bar);
    recordingUI.drawOverlay = { canvas, bar, surface };
  }

  function removeDrawOverlay() {
    if (recordingUI && recordingUI.drawOverlay) {
      recordingUI.drawOverlay.surface.destroy();
      recordingUI.drawOverlay.canvas.remove();
      recordingUI.drawOverlay.bar.remove();
      recordingUI.drawOverlay = null;
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
    const audioBase64 = await capture.blobToBase64(audioBlob);
    return transcribeAndFillBase64(audioBase64, audioBlob.type);
  }

  async function transcribeAndFillBase64(audioBase64, mime) {
    if (!state) return;
    const { $ } = state;
    try {
      voiceStatus("Transcribing…", "info");
      const tRes = await chrome.runtime.sendMessage({
        type: "WM_TRANSCRIBE",
        audioBase64,
        mime,
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

  function pageContext(settings) {
    return {
      url: location.href,
      pageTitle: document.title,
      userAgent: navigator.userAgent,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      timestamp: new Date().toISOString(),
      reporterName: settings.reporterName,
    };
  }

  function consoleLogsText() {
    if (!state.consoleLogs.length) return "";
    return state.consoleLogs
      .map((l) => `[${l.time}] ${String(l.level).toUpperCase().padEnd(9)} ${l.text}`)
      .join("\n");
  }

  function showMsg(text, kind, node) {
    const m = state.$("msg");
    m.hidden = false;
    m.className = "wm-msg wm-msg-" + (kind || "info");
    m.textContent = "";
    m.append(node || document.createTextNode(text));
  }

  function showCardCreated(shortUrl) {
    const { $ } = state;
    const link = document.createElement("a");
    link.href = shortUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "wm-link";
    link.textContent = "Open the Trello card →";
    const wrap = document.createElement("span");
    wrap.append("Card created. ", link);
    showMsg(null, "success", wrap);
    $("submit").textContent = "Done";
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

    if (state.mode === "recording") {
      if (!state.segmentCount) {
        return showMsg("Record a video first, or switch to Screenshot.", "error");
      }
      return submitRecording(fields, settings);
    }
    return submitScreenshot(fields, auth, settings);
  }

  // Recording: the blobs live in the offscreen doc, so the create+attach happens there.
  // We just hand over the form fields, page context, transcript, and console text.
  async function submitRecording(fields, settings) {
    const { $ } = state;
    $("submit").disabled = true;
    showMsg("Creating card…", "info");
    const res = await chrome.runtime
      .sendMessage({
        type: "WM_SUBMIT_RECORDING",
        payload: {
          fields,
          context: pageContext(settings),
          transcript: state.transcript,
          consoleText: consoleLogsText(),
        },
      })
      .catch(() => null);
    if (!res || !res.ok) {
      $("submit").disabled = false;
      return showMsg((res && res.error) || "Something went wrong.", "error");
    }
    state.submitted = true;
    showCardCreated(res.shortUrl);
  }

  // Screenshot: the PNG is produced and uploaded in-page (it never leaves this context).
  async function submitScreenshot(fields, auth, settings) {
    const { $ } = state;
    $("submit").disabled = true;
    showMsg("Creating card…", "info");
    try {
      const context = pageContext(settings);
      const name = markdown.buildTitle(fields);
      const desc = markdown.buildDescription(fields, context, "screenshot", state.transcript, 0);
      const labelIds = await trello
        .resolveLabelIds(auth, settings.boardId, settings.defaultLabels)
        .catch(() => []);
      const card = await trello.createCard(auth, { listId: settings.listId, name, desc, labelIds });

      const r2Links = [];
      const attach = async (blob, filename) => {
        const result = await r2.uploadAttachment(auth, card.id, blob, filename, settings);
        if (result.via === "r2") r2Links.push(result);
      };

      const hasMarkup = state.drawSurface && !state.drawSurface.isEmpty();
      let blob;
      if (hasMarkup) {
        blob = await capture.compositeScreenshot(state.screenshot, $("drawCanvas"), state.cropRect);
      } else if (state.cropRect) {
        blob = await capture.cropDataUrl(state.screenshot, state.cropRect);
      } else {
        blob = capture.dataUrlToBlob(state.screenshot);
      }
      await attach(blob, "screenshot.png");

      const consoleText = consoleLogsText();
      if (consoleText) {
        await attach(new Blob([consoleText], { type: "text/plain" }), "console-logs.txt");
      }

      if (r2Links.length) {
        const lines = r2Links.map((l) => `📎 [${l.filename}](${l.url})`).join("\n");
        await trello
          .updateCardDesc(auth, card.id, `${desc}\n\n## Media\n${lines}`)
          .catch(() => {});
      }

      state.submitted = true;
      showCardCreated(card.shortUrl);
    } catch (err) {
      $("submit").disabled = false;
      showMsg(err.message || "Something went wrong.", "error");
    }
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.overlay = {
    mountPanel,
    showRecordingControls,
    removeRecordingControls,
    showRecordingDone,
    stopRecording,
    close,
  };
})();
