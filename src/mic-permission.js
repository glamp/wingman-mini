// Microphone permission requester. Runs in a visible extension page (popup window) so it
// can show Chrome's mic prompt — the offscreen recorder can't. A successful grant lands on
// the extension origin, which the offscreen document shares, so it can then record the mic.
// We report the outcome to the service worker BEFORE closing, so a self-close can never beat
// the message; the SW awaits that message (or this window closing) before starting recording.
(function () {
  const status = document.getElementById("status");
  const closeBtn = document.getElementById("closeBtn");
  closeBtn.addEventListener("click", () => window.close());

  (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // we only needed the grant
      chrome.runtime.sendMessage({ type: "WM_MIC_PERMISSION_RESULT", granted: true });
      status.textContent = "Microphone enabled. You can start recording.";
      setTimeout(() => window.close(), 800); // auto-close on grant
    } catch (err) {
      chrome.runtime.sendMessage({ type: "WM_MIC_PERMISSION_RESULT", granted: false });
      status.textContent =
        "Microphone access was blocked. Click the camera/microphone icon in the address " +
        "bar (or this page's site settings) to allow it, then start recording again. " +
        "Recording will still work without narration.";
      closeBtn.style.display = "inline-block";
    }
  })();
})();
