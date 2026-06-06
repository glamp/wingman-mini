# Wingman

A small internal Chrome extension for capturing bugs and feedback straight into Trello.

Click the toolbar icon (or press **⌘+Shift+K** on Mac / **Alt+Shift+K** on Windows/Linux), grab a **screenshot** or a **screen
recording**, optionally **describe the bug out loud**, and Wingman creates a clean Trello
card in your configured board/list with the media attached.

Wingman transcribes your voice (Whisper) and auto-fills the form (GPT-OSS 120B), then adds
the transcript to the card. A Groq API key is required.

Plain JavaScript, HTML, and CSS — Manifest V3, no backend, no build step.

## Install

Install from the Chrome Web Store:

1. Open <https://chromewebstore.google.com/detail/wingman/hdbmgfgonajjmibdlaljefopoiogfmlf>.
2. Click **Add to Chrome**, then **Add extension**.
3. Wingman now appears in your toolbar. (If you don't see it, click the puzzle-piece icon
   and pin it.)

Chrome keeps the extension up to date automatically — there's nothing to re-download when
a new version ships.

### Install (unpacked, for development)

To run from source instead:

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repo folder.

> Note: unpacked installs do **not** auto-update — use the Web Store link above for that.

## Set up Trello

1. Get an API key at <https://trello.com/app-key>.
2. On that same page, generate a **token** (grant read/write).
3. Open Wingman's **options** page (right-click the icon → *Options*, or via
   `chrome://extensions`).
4. Paste your **API key**, **token**, and **reporter name**.
5. Click **Test Trello connection** — you should see "Connected as …".
6. Pick a **board**, then a **list**, optionally add **default labels**, and **Save**.
7. Paste a **Groq API key** (from <https://console.groq.com/keys>) — required for voice
   transcription and form auto-fill.

Settings are stored in `chrome.storage.local`. Until Trello **and** Groq are configured,
opening Wingman shows a setup prompt with a button to the options page.

## Use it

1. Go to any normal `http://`/`https://` page (Wingman can't run on `chrome://` or the
   Web Store).
2. Click the Wingman icon or press **⌘+Shift+K** (Mac) / **Alt+Shift+K** (Windows/Linux).
3. Choose **Screenshot** (drag to crop, or submit to use the full shot) or
   **Screen recording** (pick a tab/window/screen, then **Stop**).
4. (Optional) Click **🎙 Record voice** (screenshot mode) or just narrate while screen
   recording — Wingman transcribes it and fills the form for you to review.
5. Edit anything, then click **Create Trello card**.
6. Follow the success link to the new card.

> Screen recording requires a secure page (`https` or `localhost`).

## Project layout

The capture/report UI is an in-page modal rendered inside a Shadow DOM (style-isolated from
the page). The screenshot is captured *before* the overlay is drawn, so it never contains
Wingman's own UI. Groq calls go through the background service worker (a content script can't
call Groq directly because of CORS); Trello is called straight from the overlay.

```
manifest.json          MV3 config, permissions, content scripts, keyboard command
icons/                 toolbar icons (16/48/128)
src/
  background.js        triggers the overlay, captures the tab, proxies Groq calls
  content.js           builds the Shadow-DOM host and mounts the overlay
  overlay.js           the capture/report UI (setup gate, crop, recording, voice, submit)
  capture.js           screen + mic recording, poster-frame extraction, screenshot cropping
  groq.js              Whisper transcription + chat-model form auto-fill (runs in background)
  trello.js            Trello API calls (test, boards, lists, create card, attach)
  markdown.js          deterministic card title + description
  storage.js           chrome.storage.local wrapper
  options.html/.js     setup page (credentials + board/list dropdowns)
  styles.css           overlay + options styling
```
