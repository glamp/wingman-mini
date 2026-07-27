# wingman-files Worker

Cloudflare Worker that backs Wingman's R2 "large file" store — recordings and screenshots
too big for Trello's 10 MB attachment limit. Wingman POSTs them to `/upload`; the Worker
stores them in R2 and returns a public `/file/<key>` URL that gets attached to the card.

- **URL:** `https://wingman-files.lamp-greg.workers.dev`
- **Bindings:** R2 bucket bound as `FILES`; secret `WINGMAN_UPLOAD_TOKEN` (the bearer token
  Wingman sends on upload — same value as `r2UploadToken` in `src/storage.js`).

## Why `worker.js` lives here

The Worker has historically been edited directly in the Cloudflare dashboard, so there was
no source of truth. This file is that source now — edit it here, commit, then paste it into
the dashboard to deploy.

## Deploy (dashboard)

1. Cloudflare dashboard → **Workers & Pages** → **wingman-files** → **Edit code**.
2. Select all, delete, paste the contents of `worker.js`.
3. **Deploy**.

## Chunked upload

Anything over 10 MB goes up in chunks via R2's multipart API instead of one big POST:

| Step | Request | Returns |
| --- | --- | --- |
| 1 | `POST /upload/create` — file's `Content-Type` + `X-Filename`, empty body | `{ key, uploadId, partSize }` |
| 2 | `POST /upload/part?key=&uploadId=&partNumber=` — chunk as the body, once per chunk | `{ partNumber, etag }` |
| 3 | `POST /upload/complete` — `{ key, uploadId, parts }` | `{ key, url }` |
| — | `POST /upload/abort` — `{ key, uploadId }` (on failure, so parts aren't orphaned) | `{ ok: true }` |

Two problems this solves. Cloudflare's edge rejects any single request body over ~100 MB with
a 413 before Worker code runs, which capped recordings at roughly 7 minutes at the 2 Mbps in
`src/capture.js`. And a one-shot POST of a large blob loses the whole recording if the
connection blips — measured at 99 MB, only one of three attempts survived. Chunks are small
enough that `src/r2.js` retries a failed one on its own (3 attempts, backing off).

`partSize` is the Worker's call, not the client's: R2 requires every part except the last to be
the same size and at least 5 MiB. `src/r2.js` falls back to a single `POST /upload` if
`/upload/create` 404s, so an extension update doesn't break against an undeployed Worker —
but files over ~100 MB then fail with a message telling you to redeploy. Verify after deploy:

```
# 25 MB in 3 chunks, then confirm the bytes came back intact
curl -s -X POST 'https://wingman-files.lamp-greg.workers.dev/upload/create' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: video/webm' -H 'X-Filename: t.webm'
# expect: {"key":"wingman/…","uploadId":"…","partSize":10485760}
```

## Range support

The `GET /file/<key>` handler honors HTTP `Range` requests (`206 Partial Content` +
`Content-Range`, and `Accept-Ranges: bytes` on every response). This is required for video
seeking: a browser that sees a media URL ignoring `Range` treats the resource as a
non-seekable stream and disables the scrub bar. Verify after deploy:

```
curl -sI -H 'Range: bytes=0-99' 'https://wingman-files.lamp-greg.workers.dev/file/<key>'
# expect: HTTP/2 206, accept-ranges: bytes, content-range: bytes 0-99/<size>, content-length: 100
```
