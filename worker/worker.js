// Cloudflare Worker backing the R2 "large file" store (bucket binding: FILES).
//
// Wingman POSTs recordings/screenshots too big for Trello's 10 MB attachment limit to
// /upload, and the Worker returns a public /file/<key> URL that gets attached to the card.
//
// Long recordings are uploaded in chunks instead: /upload/create → /upload/part (once per
// chunk) → /upload/complete, backed by R2's multipart API. Two reasons this path exists:
// Cloudflare's edge rejects any single request body over ~100 MB before this code runs, and
// a one-shot POST of a 100 MB blob loses the whole recording if the connection blips —
// per-chunk requests are small enough for the client to retry individually.
//
// The GET handler honors HTTP Range requests (206 + Content-Range, Accept-Ranges: bytes).
// This is required for video seeking: a browser that sees a media URL ignoring Range treats
// the resource as a non-seekable stream and disables the scrub bar entirely.
//
// Deploy: Cloudflare dashboard → Workers & Pages → wingman-files → Edit code → paste →
// Deploy. Bindings: R2 bucket `FILES`; secret `WINGMAN_UPLOAD_TOKEN`.

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB — one-shot /upload only; chunked has no ceiling
// Chunk size advertised to the client. R2 requires every part except the last to be the same
// size and at least 5 MiB, so the client must not pick this on its own.
const PART_SIZE = 10 * 1024 * 1024;

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Filename, Range",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...cors(),
    },
  });
}

function safeName(name) {
  return (name || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 120);
}

function extForType(type) {
  // MediaRecorder reports "video/webm;codecs=vp9,opus"; match on the bare type.
  const base = (type || "").split(";")[0].trim();
  if (base === "image/png") return "png";
  if (base === "image/jpeg") return "jpg";
  if (base === "video/webm") return "webm";
  if (base === "text/plain") return "txt";
  return "bin";
}

function authorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.WINGMAN_UPLOAD_TOKEN}`;
}

// Date-partitioned, collision-proof object key.
function buildKey(originalName, contentType) {
  const now = new Date();
  return [
    "wingman",
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    `${crypto.randomUUID()}-${originalName}.${extForType(contentType)}`,
  ].join("/");
}

function publicUrl(url, key) {
  return `${url.origin}/file/${encodeURIComponent(key)}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // ---- chunked upload (R2 multipart) ----
    // Errors are returned as JSON rather than thrown: an uncaught exception becomes an opaque
    // 500 that the client can't distinguish from a dropped connection.
    if (request.method === "POST" && url.pathname.startsWith("/upload/")) {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
      const step = url.pathname.slice("/upload/".length);

      try {
        // Open an upload. The file's own Content-Type is sent here (the body is empty) so the
        // stored object gets the right type and extension.
        if (step === "create") {
          const contentType = request.headers.get("Content-Type") || "application/octet-stream";
          const originalName = safeName(request.headers.get("X-Filename"));
          const key = buildKey(originalName, contentType);
          const mpu = await env.FILES.createMultipartUpload(key, {
            httpMetadata: { contentType },
            customMetadata: { originalName },
          });
          return json({ key, uploadId: mpu.uploadId, partSize: PART_SIZE });
        }

        // One chunk. Buffered rather than streamed so the part has a known length; at
        // PART_SIZE this is far inside the Worker memory limit.
        if (step === "part") {
          const key = url.searchParams.get("key");
          const uploadId = url.searchParams.get("uploadId");
          const partNumber = Number(url.searchParams.get("partNumber"));
          if (!key || !uploadId || !partNumber) {
            return json({ error: "Missing key, uploadId, or partNumber" }, 400);
          }
          const mpu = env.FILES.resumeMultipartUpload(key, uploadId);
          const part = await mpu.uploadPart(partNumber, await request.arrayBuffer());
          return json({ partNumber: part.partNumber, etag: part.etag });
        }

        // Stitch the parts into the final object. R2 wants them in ascending part order.
        if (step === "complete") {
          const body = await request.json().catch(() => null);
          if (!body || !body.key || !body.uploadId || !Array.isArray(body.parts)) {
            return json({ error: "Missing key, uploadId, or parts" }, 400);
          }
          const parts = body.parts
            .map((p) => ({ partNumber: Number(p.partNumber), etag: p.etag }))
            .sort((a, b) => a.partNumber - b.partNumber);
          const mpu = env.FILES.resumeMultipartUpload(body.key, body.uploadId);
          await mpu.complete(parts);
          return json({ key: body.key, url: publicUrl(url, body.key) });
        }

        // Best-effort cleanup so a failed upload doesn't leave billable orphaned parts.
        if (step === "abort") {
          const body = await request.json().catch(() => null);
          if (!body || !body.key || !body.uploadId) {
            return json({ error: "Missing key or uploadId" }, 400);
          }
          await env.FILES.resumeMultipartUpload(body.key, body.uploadId).abort();
          return json({ ok: true });
        }
      } catch (err) {
        return json({ error: `${step} failed: ${(err && err.message) || err}` }, 500);
      }

      return json({ error: "Unknown upload step" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);

      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      const contentLength = Number(request.headers.get("Content-Length") || "0");

      if (contentLength > MAX_BYTES) {
        return json({ error: "File too large" }, 413);
      }

      const originalName = safeName(request.headers.get("X-Filename"));
      const key = buildKey(originalName, contentType);

      await env.FILES.put(key, request.body, {
        httpMetadata: {
          contentType,
        },
        customMetadata: {
          originalName,
        },
      });

      return json({ key, url: publicUrl(url, key) });
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname.startsWith("/file/")
    ) {
      const key = decodeURIComponent(url.pathname.replace("/file/", ""));
      const rangeHeader = request.headers.get("Range");

      // Look up size + metadata first (cheap, no body) so we can resolve the range ourselves
      // and set Content-Range/Content-Length precisely. Parsing the header by hand is more
      // reliable than trusting R2's returned object.range.
      const head = await env.FILES.head(key);
      if (!head) {
        return new Response("Not found", { status: 404, headers: cors() });
      }
      const size = head.size;

      const headers = {
        "Content-Type": head.httpMetadata?.contentType || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "bytes",
        ETag: head.httpEtag,
        "Access-Control-Expose-Headers":
          "Content-Length, Content-Range, Accept-Ranges, ETag",
        ...cors(),
      };

      // Whole object.
      if (!rangeHeader) {
        const object = request.method === "HEAD" ? null : await env.FILES.get(key);
        return new Response(object ? object.body : null, {
          status: 200,
          headers: { ...headers, "Content-Length": String(size) },
        });
      }

      // "bytes=start-end", "bytes=start-", or "bytes=-suffix".
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      let start, end;
      if (match) {
        const s = match[1];
        const e = match[2];
        if (s === "" && e !== "") {
          const suffix = Math.min(Number(e), size);
          start = size - suffix;
          end = size - 1;
        } else if (s !== "") {
          start = Number(s);
          end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
        }
      }

      if (start === undefined || Number.isNaN(start) || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${size}` },
        });
      }

      const length = end - start + 1;
      const object =
        request.method === "HEAD"
          ? null
          : await env.FILES.get(key, { range: { offset: start, length } });
      return new Response(object ? object.body : null, {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(length),
        },
      });
    }

    return json({ error: "Not found" }, 404);
  },
};
