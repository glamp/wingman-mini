# Release setup — one-time

Wires up automated publishing so `git tag v1.0.x && git push --tags` ships a new
version to the Chrome Web Store. You only do this once. **Do everything while
signed in as the Google account that owns the listing** (the store page shows
`lamp.greg@gmail.com`).

The extension ID is `hdbmgfgonajjmibdlaljefopoiogfmlf`.

---

## 1. Google Cloud project + Chrome Web Store API

1. Go to <https://console.cloud.google.com/> → create a project (or pick one),
   e.g. **wingman-publish**.
2. Enable the API: <https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com>
   → **Enable**.

## 2. OAuth consent screen

1. <https://console.cloud.google.com/apis/credentials/consent>
2. User type:
   - **Internal** if `lamp.greg@gmail.com` is part of a Google Workspace org — simplest.
   - **External** otherwise. Fill the required name/email, then under **Test users**
     add `lamp.greg@gmail.com`. (Test mode is fine — no app verification needed for
     your own use.)
3. Scope: you don't need to add scopes here; the script requests
   `.../auth/chromewebstore` at runtime.

## 3. OAuth client (Desktop app)

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials** →
   **OAuth client ID**.
2. Application type: **Desktop app**. Name it anything.
3. Copy the **Client ID** and **Client secret**.

> Desktop-app clients allow the `http://localhost` loopback redirect the mint
> script uses.

## 4. Mint a refresh token

Requires Node 18+ (for built-in `fetch`). No npm install needed.

```bash
node scripts/mint-token.mjs <CLIENT_ID> <CLIENT_SECRET>
```

A browser tab opens → approve (you'll see an "unverified app" warning in External
test mode; click **Continue**). The script prints a **refresh token**.

> If it returns no refresh token, revoke the app at
> <https://myaccount.google.com/permissions> and run it again — Google only emits
> a refresh token on first consent.

## 5. Add the 4 repo secrets

```bash
gh secret set CHROME_EXTENSION_ID  --body 'hdbmgfgonajjmibdlaljefopoiogfmlf'
gh secret set CHROME_CLIENT_ID     --body '<CLIENT_ID>'
gh secret set CHROME_CLIENT_SECRET --body '<CLIENT_SECRET>'
gh secret set CHROME_REFRESH_TOKEN --body '<REFRESH_TOKEN>'
```

(Run from this repo. Verify with `gh secret list` — names only; values are
write-only.)

## 6. First release

1. Make sure `STORE_LISTING.md` content is pasted into the dashboard's
   description + privacy/permission fields (otherwise review rejects the update).
2. Tag and push:
   ```bash
   git tag v1.0.5 && git push origin v1.0.5
   ```
3. Watch **Actions** → the `Release` workflow packages `wingman.zip` and uploads
   it. Then the dashboard shows v1.0.5 "Pending review."

Future releases: bump `version` in `manifest.json`, then tag `v1.0.6`, etc.

## Troubleshooting

- **403 on upload** — the refresh token's account doesn't own the listing, or the
  Chrome Web Store API isn't enabled on its project. Re-mint under the owning
  account.
- **`invalid_grant`** — refresh token revoked/expired; re-run step 4.
- **Uploads but never goes live** — the workflow sets `publish: true`, but a new
  permission set still requires review to pass first. Flip to `publish: false` in
  `.github/workflows/release.yml` if you'd rather click publish in the dashboard.
