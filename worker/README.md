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

## Range support

The `GET /file/<key>` handler honors HTTP `Range` requests (`206 Partial Content` +
`Content-Range`, and `Accept-Ranges: bytes` on every response). This is required for video
seeking: a browser that sees a media URL ignoring `Range` treats the resource as a
non-seekable stream and disables the scrub bar. Verify after deploy:

```
curl -sI -H 'Range: bytes=0-99' 'https://wingman-files.lamp-greg.workers.dev/file/<key>'
# expect: HTTP/2 206, accept-ranges: bytes, content-range: bytes 0-99/<size>, content-length: 100
```
