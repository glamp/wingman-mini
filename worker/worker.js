// Cloudflare Worker backing the R2 "large file" store (bucket binding: FILES).
//
// Wingman POSTs recordings/screenshots too big for Trello's 10 MB attachment limit to
// /upload, and the Worker returns a public /file/<key> URL that gets attached to the card.
//
// The GET handler honors HTTP Range requests (206 + Content-Range, Accept-Ranges: bytes).
// This is required for video seeking: a browser that sees a media URL ignoring Range treats
// the resource as a non-seekable stream and disables the scrub bar entirely.
//
// Deploy: Cloudflare dashboard → Workers & Pages → wingman-files → Edit code → paste →
// Deploy. Bindings: R2 bucket `FILES`; secret `WINGMAN_UPLOAD_TOKEN`.

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

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
  if (type === "image/png") return "png";
  if (type === "image/jpeg") return "jpg";
  if (type === "video/webm") return "webm";
  return "bin";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.WINGMAN_UPLOAD_TOKEN}`) {
        return json({ error: "Unauthorized" }, 401);
      }

      const contentType = request.headers.get("Content-Type") || "application/octet-stream";
      const contentLength = Number(request.headers.get("Content-Length") || "0");

      if (contentLength > MAX_BYTES) {
        return json({ error: "File too large" }, 413);
      }

      const originalName = safeName(request.headers.get("X-Filename"));
      const ext = extForType(contentType);
      const now = new Date();
      const id = crypto.randomUUID();

      const key = [
        "wingman",
        now.getUTCFullYear(),
        String(now.getUTCMonth() + 1).padStart(2, "0"),
        String(now.getUTCDate()).padStart(2, "0"),
        `${id}-${originalName}.${ext}`,
      ].join("/");

      await env.FILES.put(key, request.body, {
        httpMetadata: {
          contentType,
        },
        customMetadata: {
          originalName,
        },
      });

      return json({
        key,
        url: `${url.origin}/file/${encodeURIComponent(key)}`,
      });
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
