// Cloudflare Worker (R2) fallback storage for attachments too large for Trello's
// 10 MB limit. Files >= 9.5 MB (or anything Trello rejects with 413) are POSTed to
// the Worker, which stores them in R2 and returns a public URL we attach to the card.
// The only secret here is the user's R2 upload token — no Cloudflare account/API keys.
(function () {
  // Trello's hard limit is 10 MB; stay comfortably under it.
  const THRESHOLD = 9.5 * 1024 * 1024;

  function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  function configError(size) {
    return new Error(
      `This file is ${mb(size)} MB, larger than Trello's 10 MB attachment limit, ` +
        `and R2 fallback storage is not configured. Add an R2 Worker upload URL and ` +
        `token in Wingman options.`
    );
  }

  // POST the raw Blob to the Worker. Returns { key, url }.
  async function uploadToR2(blob, settings, filename) {
    if (!settings.r2UploadUrl || !settings.r2UploadToken) {
      throw configError(blob.size);
    }
    let res;
    try {
      res = await fetch(settings.r2UploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.r2UploadToken}`,
          "Content-Type": blob.type || "application/octet-stream",
          "X-Filename": filename || "upload",
        },
        body: blob,
      });
    } catch (err) {
      throw new Error(
        `Could not reach R2 storage. Check the Worker upload URL in Wingman options. ` +
          `(${err.message})`
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `R2 upload token looks wrong (HTTP ${res.status}). Check it in Wingman options.`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`R2 upload failed (HTTP ${res.status}). ${text}`.trim());
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.url) {
      throw new Error("R2 upload succeeded but the Worker did not return a URL.");
    }
    return data;
  }

  // Decide where an attachment goes and put it there. Small files upload directly to
  // Trello; large files (or ones Trello 413s on) go to R2 and we attach the URL.
  // Returns { via: "trello" | "r2", filename, url? }.
  async function uploadAttachment(auth, cardId, blob, filename, settings) {
    const { trello } = globalThis.Wingman;
    const configured = !!(settings.r2UploadUrl && settings.r2UploadToken);

    if (blob.size < THRESHOLD) {
      try {
        await trello.attachToCard(auth, cardId, blob, filename);
        return { via: "trello", filename };
      } catch (err) {
        // Trello rejected it as too large — fall back to R2 if we can.
        if (err && err.status === 413) {
          if (!configured) throw configError(blob.size);
          // fall through to the R2 path below
        } else {
          throw err;
        }
      }
    } else if (!configured) {
      throw configError(blob.size);
    }

    const { url } = await uploadToR2(blob, settings, filename);
    await trello.attachUrlToCard(auth, cardId, url, filename);
    return { via: "r2", filename, url };
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.r2 = { uploadToR2, uploadAttachment, THRESHOLD };
})();
