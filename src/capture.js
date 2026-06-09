// Capture helpers: screen recording, poster-frame extraction, and screenshot cropping.
// All of this runs in the page (content-script) context because MediaRecorder and the
// resulting Blob cannot cross chrome.runtime messaging.
(function () {
  // Blob -> base64 string (no data: prefix). Used to hand small audio to the background.
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Could not read the audio."));
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(",");
    const mime = (header.match(/data:([^;]+)/) || [])[1] || "image/png";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // Pick a webm mime type the browser actually supports.
  function pickVideoMime() {
    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "video/webm";
  }

  function pickAudioMime() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm"];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "audio/webm";
  }

  // Record microphone audio. Returns a controller: { stop(): Promise<Blob> }.
  async function recordMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Microphone recording is not supported in this browser.");
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error("Microphone access was denied.");
    }
    const mimeType = pickAudioMime();
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    let stopResolve;
    const stopped = new Promise((resolve) => (stopResolve = resolve));
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      stopResolve(new Blob(chunks, { type: mimeType }));
    };
    recorder.start();
    return {
      stop() {
        if (recorder.state !== "inactive") recorder.stop();
        return stopped;
      },
    };
  }

  // Recordings are no longer split: large files now go to R2 fallback storage as a single
  // file (see r2.js), so there's no need to keep each segment under Trello's 10 MB limit.
  // Infinity means the size-based roll below never fires and the recorder produces one
  // continuous, independently-playable webm. (The segment-rolling machinery is kept intact
  // in case we ever want to re-enable splitting.)
  const SEGMENT_LIMIT = Infinity;
  // ~2 Mbps ceiling — crisp text for screen content. The encoder spends fewer bits when the
  // screen is static, so typical recordings come in well under this. The one quality lever.
  const VIDEO_BPS = 2_000_000;
  const AUDIO_BPS = 64_000;

  // Start a screen recording with microphone narration. Shows Chrome's native share picker
  // (tab/window/screen). Returns a controller: { stop(): Promise<{videoBlobs, audioBlob}> }.
  // `videoBlobs` is an array of independently-playable webm segments (the screen recording
  // with the mic mixed in), split so each stays under Trello's attachment limit — usually a
  // single file, more for long/busy recordings. `audioBlob` is a small audio-only webm (mic)
  // used for transcription (null if the mic was denied). There is no length cap. If the user
  // ends sharing from Chrome's own UI, onEnded() fires.
  async function startRecording({ onEnded } = {}) {
    if (!window.isSecureContext) {
      throw new Error("Screen recording needs a secure page (https or localhost).");
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("Screen recording is not supported in this browser.");
    }

    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
    } catch (err) {
      throw new Error("Screen share was cancelled or denied.");
    }

    // Try to capture mic narration; proceed video-only if it's denied.
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      micStream = null;
    }

    const videoTrack = displayStream.getVideoTracks()[0];
    const micTrack = micStream ? micStream.getAudioTracks()[0] : null;

    // Combined stream (video + mic) for the saved recording.
    const videoMime = pickVideoMime();
    const combined = new MediaStream(micTrack ? [videoTrack, micTrack] : [videoTrack]);

    // Finished segments accumulate here. Each MediaRecorder session produces one complete,
    // independently-playable webm — byte-splitting a single blob is impossible because only
    // the first chunk carries the container header, so we roll fresh recorders instead.
    const videoBlobs = [];
    let videoRecorder = null;
    let rolling = false; // true while intentionally finalizing one segment to start the next

    let stopResolve;
    const stopped = new Promise((resolve) => (stopResolve = resolve));

    function finalize() {
      displayStream.getTracks().forEach((t) => t.stop());
      if (micStream) micStream.getTracks().forEach((t) => t.stop());
      stopResolve({
        videoBlobs,
        audioBlob: micTrack ? new Blob(audioChunks, { type: audioMime }) : null,
      });
    }

    function makeSegmentRecorder() {
      const r = new MediaRecorder(combined, {
        mimeType: videoMime,
        videoBitsPerSecond: VIDEO_BPS,
        audioBitsPerSecond: AUDIO_BPS,
      });
      const chunks = [];
      let bytes = 0;
      r.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
          bytes += e.data.size;
        }
        // Roll to a new file before the segment grows past the limit.
        if (bytes >= SEGMENT_LIMIT && r.state === "recording") {
          rolling = true;
          r.stop();
        }
      };
      r.onstop = () => {
        if (chunks.length) videoBlobs.push(new Blob(chunks, { type: videoMime }));
        if (rolling) {
          rolling = false;
          videoRecorder = makeSegmentRecorder();
          videoRecorder.start(500);
        } else {
          finalize();
        }
      };
      return r;
    }

    // Separate audio-only recorder (mic) for a small transcription upload.
    let audioRecorder = null;
    const audioChunks = [];
    const audioMime = pickAudioMime();
    if (micTrack) {
      audioRecorder = new MediaRecorder(new MediaStream([micTrack]), { mimeType: audioMime });
      audioRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };
    }

    function stopAll() {
      rolling = false; // a manual/ended stop finalizes rather than rolling
      if (audioRecorder && audioRecorder.state !== "inactive") audioRecorder.stop();
      if (videoRecorder && videoRecorder.state !== "inactive") videoRecorder.stop();
    }

    // The user can stop sharing from Chrome's bar — treat that as "stop".
    videoTrack.addEventListener("ended", () => {
      stopAll();
      if (typeof onEnded === "function") onEnded();
    });

    // 500 ms timeslice so ondataavailable fires ~2×/sec and the size check runs continuously.
    videoRecorder = makeSegmentRecorder();
    videoRecorder.start(500);
    if (audioRecorder) audioRecorder.start();

    return {
      stop() {
        stopAll();
        return stopped;
      },
    };
  }

  // Grab a still poster frame (PNG Blob) from a recorded video Blob.
  function posterFromVideoBlob(blob) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      const objUrl = URL.createObjectURL(blob);
      video.src = objUrl;

      const cleanup = () => URL.revokeObjectURL(objUrl);

      video.onloadeddata = () => {
        // Seek a touch past the start so we don't grab a black first frame.
        try {
          video.currentTime = Math.min(0.1, video.duration || 0.1);
        } catch (e) {
          drawFrame();
        }
      };
      video.onseeked = drawFrame;
      video.onerror = () => {
        cleanup();
        reject(new Error("Could not read the recording for a poster frame."));
      };

      function drawFrame() {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (out) => {
            cleanup();
            if (out) resolve(out);
            else reject(new Error("Could not generate a poster frame."));
          },
          "image/png"
        );
      }
    });
  }

  // Crop a region out of a screenshot data URL. `rect` and `scale` are in screenshot
  // pixels already (the overlay converts from display coordinates). Returns a PNG Blob.
  function cropDataUrl(dataUrl, rect) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(rect.width));
        canvas.height = Math.max(1, Math.round(rect.height));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          img,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        canvas.toBlob((out) => {
          if (out) resolve(out);
          else reject(new Error("Could not crop the screenshot."));
        }, "image/png");
      };
      img.onerror = () => reject(new Error("Could not load the screenshot."));
      img.src = dataUrl;
    });
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.capture = {
    startRecording,
    recordMic,
    posterFromVideoBlob,
    cropDataUrl,
    dataUrlToBlob,
    blobToBase64,
  };
})();
