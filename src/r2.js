// Cloudflare Worker (R2) fallback storage for attachments too large for Trello's
// 10 MB limit. Files >= 9.5 MB (or anything Trello rejects with 413) are POSTed to
// the Worker, which stores them in R2 and returns a public URL we attach to the card.
// The only secret here is the user's R2 upload token — no Cloudflare account/API keys.
//
// Anything bigger than one chunk goes up in pieces (Worker: /upload/create → /upload/part →
// /upload/complete). Recordings are a single continuous webm with no size cap, and a one-shot
// POST of one is fragile in two ways: Cloudflare's edge refuses request bodies over ~100 MB
// outright, and a momentary connection blip loses the entire upload — which surfaces in the
// page as a bare "Failed to fetch". Chunks are small enough to retry one at a time.
(function () {
  // Trello's hard limit is 10 MB; stay comfortably under it.
  const THRESHOLD = 9.5 * 1024 * 1024;
  // Fallback chunk size, used only if the Worker doesn't state its own. R2 requires every part
  // except the last to be identical in size and at least 5 MiB.
  const PART_SIZE = 10 * 1024 * 1024;
  const MIN_PART_SIZE = 5 * 1024 * 1024;
  // Ceiling Cloudflare's edge imposes on a single request body, regardless of Worker code.
  const EDGE_LIMIT = 100 * 1024 * 1024;
  const MAX_ATTEMPTS = 3;
  // fetch has no built-in deadline, so a connection that goes away mid-transfer without
  // resetting (laptop sleep, dropped Wi-Fi) leaves the request pending forever and the
  // submit hangs with no error. Bound every attempt instead; a timeout is just another
  // retryable failure. The part budget is generous — 10 MiB on a slow uplink is minutes.
  const CONTROL_TIMEOUT_MS = 30000;
  const PART_TIMEOUT_MS = 180000;

  function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function configError(size) {
    return new Error(
      `This file is ${mb(size)} MB, larger than Trello's 10 MB attachment limit, ` +
        `and R2 fallback storage is not configured. Add an R2 Worker upload URL and ` +
        `token in Wingman options.`
    );
  }

  // The configured URL points at /upload; the chunked steps are its siblings.
  function endpoint(base, step) {
    return `${base.replace(/\/+$/, "")}/${step}`;
  }

  function authHeaders(settings) {
    return { Authorization: `Bearer ${settings.r2UploadToken}` };
  }

  function tokenError(res) {
    return new Error(
      `R2 upload token looks wrong (HTTP ${res.status}). Check it in Wingman options.`
    );
  }

  async function httpError(res, what) {
    const text = await res.text().catch(() => "");
    return new Error(`R2 upload failed while ${what} (HTTP ${res.status}). ${text}`.trim());
  }

  // A dropped connection is the common failure and it is transient, so say so — the old
  // message blamed the upload URL, sending people to re-check settings that were fine.
  function networkError(err, what) {
    return new Error(
      `Upload to R2 storage failed while ${what}, after ${MAX_ATTEMPTS} attempts — the ` +
        `connection dropped mid-transfer. (${(err && err.message) || err}) If it keeps ` +
        `failing, check the Worker upload URL in Wingman options.`
    );
  }

  // Retry dropped connections and server-side hiccups. Blob bodies are replayable, so
  // re-issuing the identical request is safe. Client errors (401/413/…) come back as a
  // response for the caller to interpret — retrying those would only waste time.
  // The AbortSignal is built per attempt: one that has already fired would abort the
  // retry the instant it started.
  async function requestWithRetry(url, init, what, timeoutMs) {
    const ms = timeoutMs || CONTROL_TIMEOUT_MS;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_ATTEMPTS) {
          await sleep(500 * attempt);
          continue;
        }
        return res;
      } catch (err) {
        const name = err && err.name;
        lastErr =
          name === "TimeoutError" || name === "AbortError"
            ? new Error(`no response within ${Math.round(ms / 1000)}s`)
            : err;
        if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt);
      }
    }
    throw networkError(lastErr, what);
  }

  // Upload in chunks via the Worker's multipart endpoints. Returns { key, url }, or null if
  // the deployed Worker predates those endpoints so the caller can fall back.
  // `onProgress({ partNumber, totalParts })` fires before each part so the UI can show that
  // a big upload is moving rather than sitting on one static "Creating card…".
  async function uploadChunked(blob, settings, filename, onProgress) {
    const base = settings.r2UploadUrl;
    const headers = authHeaders(settings);

    const createRes = await requestWithRetry(
      endpoint(base, "create"),
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": blob.type || "application/octet-stream",
          "X-Filename": filename || "upload",
        },
      },
      "starting the upload"
    );
    if (createRes.status === 401 || createRes.status === 403) throw tokenError(createRes);
    // An older Worker answers anything it doesn't recognize with 404 "Not found".
    if (createRes.status === 404 || createRes.status === 405) return null;
    if (!createRes.ok) throw await httpError(createRes, "starting the upload");
    const created = await createRes.json().catch(() => null);
    if (!created || !created.key || !created.uploadId) return null;

    // The Worker owns the part size — R2 rejects a completed upload whose parts disagree.
    const partSize = Math.max(Number(created.partSize) || PART_SIZE, MIN_PART_SIZE);
    const totalParts = Math.ceil(blob.size / partSize);
    const parts = [];

    try {
      for (let i = 0; i < totalParts; i++) {
        const partNumber = i + 1;
        const chunk = blob.slice(i * partSize, Math.min((i + 1) * partSize, blob.size));
        const what = `uploading part ${partNumber} of ${totalParts}`;
        if (onProgress) onProgress({ partNumber, totalParts });
        const query = new URLSearchParams({
          key: created.key,
          uploadId: created.uploadId,
          partNumber: String(partNumber),
        });
        const res = await requestWithRetry(
          `${endpoint(base, "part")}?${query}`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/octet-stream" },
            body: chunk,
          },
          what,
          PART_TIMEOUT_MS
        );
        if (res.status === 401 || res.status === 403) throw tokenError(res);
        if (!res.ok) throw await httpError(res, what);
        const data = await res.json().catch(() => null);
        if (!data || !data.etag) {
          throw new Error(`R2 upload part ${partNumber} came back without an etag.`);
        }
        parts.push({ partNumber, etag: data.etag });
      }

      const doneRes = await requestWithRetry(
        endpoint(base, "complete"),
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ key: created.key, uploadId: created.uploadId, parts }),
        },
        "finalizing the upload"
      );
      if (doneRes.status === 401 || doneRes.status === 403) throw tokenError(doneRes);
      if (!doneRes.ok) throw await httpError(doneRes, "finalizing the upload");
      const done = await doneRes.json().catch(() => null);
      if (!done || !done.url) {
        throw new Error("R2 upload finished but the Worker did not return a URL.");
      }
      return done;
    } catch (err) {
      // Don't leave the parts we did upload sitting in the bucket as a billable orphan.
      fetch(endpoint(base, "abort"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ key: created.key, uploadId: created.uploadId }),
      }).catch(() => {});
      throw err;
    }
  }

  // POST the whole Blob in one request. Fine for the small end; see the file header for why
  // large files don't come this way.
  async function uploadSingle(blob, settings, filename) {
    const res = await requestWithRetry(
      settings.r2UploadUrl,
      {
        method: "POST",
        headers: {
          ...authHeaders(settings),
          "Content-Type": blob.type || "application/octet-stream",
          "X-Filename": filename || "upload",
        },
        body: blob,
      },
      "uploading the file",
      PART_TIMEOUT_MS
    );
    if (res.status === 401 || res.status === 403) throw tokenError(res);
    if (!res.ok) throw await httpError(res, "uploading the file");
    const data = await res.json().catch(() => null);
    if (!data || !data.url) {
      throw new Error("R2 upload succeeded but the Worker did not return a URL.");
    }
    return data;
  }

  // Store a Blob in R2. Returns { key, url }.
  async function uploadToR2(blob, settings, filename, onProgress) {
    if (!settings.r2UploadUrl || !settings.r2UploadToken) {
      throw configError(blob.size);
    }
    if (blob.size > PART_SIZE) {
      const result = await uploadChunked(blob, settings, filename, onProgress);
      if (result) return result;
      if (blob.size > EDGE_LIMIT) {
        throw new Error(
          `This file is ${mb(blob.size)} MB. Cloudflare rejects single uploads that large, ` +
            `and the Worker at ${settings.r2UploadUrl} doesn't support chunked uploads yet — ` +
            `redeploy worker/worker.js from the Wingman repo.`
        );
      }
    }
    return uploadSingle(blob, settings, filename);
  }

  // Decide where an attachment goes and put it there. Small files upload directly to
  // Trello; large files (or ones Trello 413s on) go to R2 and we attach the URL.
  // Returns { via: "trello" | "r2", filename, url? }.
  async function uploadAttachment(auth, cardId, blob, filename, settings, onProgress) {
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

    const { url } = await uploadToR2(blob, settings, filename, onProgress);
    await trello.attachUrlToCard(auth, cardId, url, filename);
    return { via: "r2", filename, url };
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.r2 = { uploadToR2, uploadAttachment, THRESHOLD };
})();
