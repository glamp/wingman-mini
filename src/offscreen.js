// Offscreen recorder + uploader. The MediaRecorder, the screen/mic streams, and the
// captured blobs all live here so the recording survives reloads of the page being
// recorded (the offscreen document is not tied to any tab). The service worker relays
// page UI events here and forwards our replies back.
(function () {
  const { capture, storage, markdown, trello, r2 } = globalThis.Wingman;

  // The single in-flight recording. Null when idle.
  // { controller, finishPromise, videoBlobs, audioBlob, posterBlob, endedSent }
  let session = null;

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

  async function submitSession({ fields, context, transcript, consoleText }) {
    if (!session || !session.videoBlobs) {
      throw new Error("No finished recording to submit.");
    }
    const settings = await storage.getSettings();
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
      session.videoBlobs.length
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
    const attach = async (blob, filename) => {
      const result = await r2.uploadAttachment(auth, card.id, blob, filename, settings);
      if (result.via === "r2") r2Links.push({ filename: result.filename, url: result.url });
    };

    const blobs = session.videoBlobs;
    if (blobs.length === 1) {
      await attach(blobs[0], "recording.webm");
    } else {
      for (let i = 0; i < blobs.length; i++) {
        await attach(blobs[i], `recording-${i + 1}.webm`);
      }
    }
    if (session.posterBlob) await attach(session.posterBlob, "poster.png");
    if (consoleText) {
      await attach(new Blob([consoleText], { type: "text/plain" }), "console-logs.txt");
    }

    // For anything stored in R2, also surface the link in the card description.
    if (r2Links.length) {
      const lines = r2Links.map((l) => `📎 [${l.filename}](${l.url})`).join("\n");
      await trello
        .updateCardDesc(auth, card.id, `${desc}\n\n## Media\n${lines}`)
        .catch(() => {}); // URL attachments are already on the card; don't fail the submit
    }

    return { shortUrl: card.shortUrl, r2Links };
  }

  async function discardSession() {
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

    if (msg.type === "WM_OFFSCREEN_SUBMIT") {
      submitSession(msg.payload || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === "WM_OFFSCREEN_DISCARD") {
      discardSession()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;
    }
  });
})();
