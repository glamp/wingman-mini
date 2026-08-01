// Offscreen recorder + uploader. The MediaRecorder, the screen/mic streams, and the
// captured blobs all live here so the recording survives reloads of the page being
// recorded (the offscreen document is not tied to any tab). The service worker relays
// page UI events here and forwards our replies back.
(function () {
  const { capture, storage, markdown, trello, r2 } = globalThis.Wingman;

  // The single in-flight recording. Null when idle.
  // { controller, finishPromise, videoBlobs, audioBlob, posterBlob, endedSent }
  let session = null;

  // The submit runs here, detached from the message that started it: creating the card and
  // pushing a large recording to R2 takes minutes, and holding a chrome.runtime response
  // open that long is a losing bet (the service worker gets torn down, the page can be
  // closed). Instead the page starts the job, then polls this state for progress.
  // { status: "running" | "done" | "error", phase, result, error }
  let submitJob = null;

  async function startSession() {
    if (session) await discardSession();
    const controller = await capture.startRecording({ onEnded: handleEnded });
    session = {
      controller,
      finishPromise: null,
      videoBlobs: null,
      audioBlob: null,
      posterBlob: null,
      endedSent: false,
    };
  }

  // Stop the recorder, finalize the blobs, and build the small artifacts (poster + audio)
  // we hand back to the page. Idempotent: a button-stop and a native "Stop sharing" can
  // both land here, but the work runs once.
  function finishSession() {
    if (!session) return Promise.reject(new Error("No active recording."));
    if (!session.finishPromise) {
      session.finishPromise = (async () => {
        const { videoBlobs, audioBlob } = await session.controller.stop();
        session.videoBlobs = videoBlobs;
        session.audioBlob = audioBlob;
        const posterBlob = videoBlobs[0]
          ? await capture.posterFromVideoBlob(videoBlobs[0]).catch(() => null)
          : null;
        session.posterBlob = posterBlob;
        const posterBase64 = posterBlob ? await capture.blobToBase64(posterBlob) : "";
        const audioBase64 = audioBlob ? await capture.blobToBase64(audioBlob) : "";
        return {
          posterBase64,
          posterType: (posterBlob && posterBlob.type) || "image/png",
          audioBase64,
          audioType: (audioBlob && audioBlob.type) || "",
          segmentCount: videoBlobs.length,
        };
      })();
    }
    return session.finishPromise;
  }

  // The user ended sharing from Chrome's own bar. Finalize and push the result to the SW
  // so the page can flip to its "recording ready" review state.
  async function handleEnded() {
    try {
      const payload = await finishSession();
      if (session && !session.endedSent) {
        session.endedSent = true;
        chrome.runtime.sendMessage({ type: "WM_OFFSCREEN_ENDED", ...payload }).catch(() => {});
      }
    } catch (e) {
      /* nothing the page can do; it can retry via WM_STOP_RECORDING */
    }
  }

  async function submitSession(
    { fields, context, transcript, consoleText, settings: passed },
    onPhase
  ) {
    if (!session || !session.videoBlobs) {
      throw new Error("No finished recording to submit.");
    }
    // Take the blobs now rather than reading session.* as we go: this runs detached and can
    // outlive the session it came from (the user is free to start a new recording while an
    // upload is still going).
    const { videoBlobs, posterBlob } = session;
    const phase = onPhase || (() => {});
    phase("Creating card…");
    // chrome.storage isn't accessible from an offscreen document, so the service worker reads
    // the settings and hands them in. Merge over defaults to fill any unset fields (e.g. R2).
    const settings = Object.assign({}, storage.DEFAULTS, passed || {});
    const auth = { apiKey: settings.apiKey, token: settings.token };
    if (!auth.apiKey) throw new Error("Missing Trello API key. Open Wingman options.");
    if (!auth.token) throw new Error("Missing Trello token. Open Wingman options.");
    if (!settings.listId) throw new Error("No Trello list selected. Open Wingman options.");

    const name = markdown.buildTitle(fields);
    const desc = markdown.buildDescription(
      fields,
      context,
      "recording",
      transcript,
      videoBlobs.length
    );
    const labelIds = await trello
      .resolveLabelIds(auth, settings.boardId, settings.defaultLabels)
      .catch(() => []);
    const card = await trello.createCard(auth, {
      listId: settings.listId,
      name,
      desc,
      labelIds,
    });

    const r2Links = [];
    const attach = async (blob, filename, label) => {
      phase(`Uploading ${label}…`);
      const onProgress = ({ partNumber, totalParts }) =>
        phase(`Uploading ${label} — part ${partNumber} of ${totalParts}…`);
      const result = await r2.uploadAttachment(
        auth,
        card.id,
        blob,
        filename,
        settings,
        onProgress
      );
      if (result.via === "r2") r2Links.push({ filename: result.filename, url: result.url });
    };

    const blobs = videoBlobs;
    if (blobs.length === 1) {
      await attach(blobs[0], "recording.webm", "the recording");
    } else {
      for (let i = 0; i < blobs.length; i++) {
        await attach(blobs[i], `recording-${i + 1}.webm`, `recording ${i + 1} of ${blobs.length}`);
      }
    }
    if (posterBlob) await attach(posterBlob, "poster.png", "the poster");
    if (consoleText) {
      await attach(
        new Blob([consoleText], { type: "text/plain" }),
        "console-logs.txt",
        "the console logs"
      );
    }

    // For anything stored in R2, also surface the link in the card description.
    if (r2Links.length) {
      phase("Finishing up…");
      const lines = r2Links.map((l) => `📎 [${l.filename}](${l.url})`).join("\n");
      await trello
        .updateCardDesc(auth, card.id, `${desc}\n\n## Media\n${lines}`)
        .catch(() => {}); // URL attachments are already on the card; don't fail the submit
    }

    return { shortUrl: card.shortUrl, cardName: name, r2Links };
  }

  // Kick off a submit and return immediately. Idempotent while one is running: the card is
  // created before any upload, so starting a second job would file a duplicate card.
  function startSubmit(payload) {
    if (submitJob && submitJob.status === "running") return submitJob;
    submitJob = { status: "running", phase: "Creating card…" };
    const job = submitJob;
    submitSession(payload, (text) => {
      if (submitJob === job) submitJob.phase = text;
    })
      .then((result) => {
        if (submitJob !== job) return;
        submitJob = { status: "done", result };
        // Tell the service worker even if nobody is polling — the panel may have been
        // closed, and this is what clears the recording state and posts the notification.
        chrome.runtime
          .sendMessage({ type: "WM_OFFSCREEN_SUBMIT_DONE", result })
          .catch(() => {});
      })
      .catch((e) => {
        if (submitJob !== job) return;
        const error = (e && e.message) || "Something went wrong.";
        submitJob = { status: "error", error };
        // Deliberately no cleanup here: the recording stays put so the user can retry.
        chrome.runtime.sendMessage({ type: "WM_OFFSCREEN_SUBMIT_FAILED", error }).catch(() => {});
      });
    return submitJob;
  }

  // Hand the page a slice of a finished recording so it can rebuild the Blob for playback.
  // The Blob can't cross chrome.runtime, so the page pulls it in base64 chunks and reassembles
  // it in its own context. `total` lets the caller know when it has the whole file.
  async function getRecordingChunk({ index = 0, offset = 0, length } = {}) {
    if (!session || !session.videoBlobs) throw new Error("No finished recording.");
    const blob = session.videoBlobs[index];
    if (!blob) throw new Error("No such recording segment.");
    const slice = length ? blob.slice(offset, offset + length) : blob.slice(offset);
    const base64 = await capture.blobToBase64(slice);
    return {
      base64,
      total: blob.size,
      type: blob.type || "video/webm",
      count: session.videoBlobs.length,
    };
  }

  async function discardSession() {
    // A submit in flight is still reading session.videoBlobs. Closing the panel fires a
    // discard, and dropping the blobs mid-upload would kill the very card the user is
    // waiting on — so let the job finish and clean up after itself.
    if (submitJob && submitJob.status === "running") return;
    if (session && session.controller) {
      try {
        await session.controller.stop();
      } catch (e) {
        /* already stopped */
      }
    }
    session = null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "WM_OFFSCREEN_START") {
      startSession()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === "WM_OFFSCREEN_STOP") {
      finishSession()
        .then((payload) => sendResponse({ ok: true, ...payload }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    // Start the job and answer right away; the page polls WM_OFFSCREEN_SUBMIT_STATUS.
    if (msg.type === "WM_OFFSCREEN_SUBMIT") {
      if (!session || !session.videoBlobs) {
        sendResponse({ ok: false, error: "No finished recording to submit." });
        return false;
      }
      startSubmit(msg.payload || {});
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "WM_OFFSCREEN_SUBMIT_STATUS") {
      sendResponse(
        submitJob
          ? { ok: true, ...submitJob }
          : { ok: false, error: "That upload is no longer running." }
      );
      return false;
    }

    if (msg.type === "WM_OFFSCREEN_GET_RECORDING") {
      getRecordingChunk(msg.payload || {})
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === "WM_OFFSCREEN_DISCARD") {
      // `busy` tells the service worker to leave this document alive — closing it would
      // abort an upload that is still running.
      const busy = !!(submitJob && submitJob.status === "running");
      discardSession()
        .then(() => sendResponse({ ok: true, busy }))
        .catch(() => sendResponse({ ok: true, busy }));
      return true;
    }

    // The service worker can't reliably query mic permission, but this offscreen document is
    // a real DOM document and can. The SW uses this to decide whether to open the permission
    // popup before starting (skip it when already granted).
    if (msg.type === "WM_OFFSCREEN_MIC_STATE") {
      (async () => {
        try {
          const status = await navigator.permissions.query({ name: "microphone" });
          return { ok: true, state: status.state }; // "granted" | "prompt" | "denied"
        } catch (e) {
          return { ok: true, state: "prompt" }; // safe fallback: at worst we prompt once
        }
      })().then(sendResponse);
      return true;
    }
  });
})();
