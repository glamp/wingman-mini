# Wingman

A small internal Chrome extension for capturing bugs and feedback straight into Trello.

Click the toolbar icon (or press **Alt+Shift+W**), grab a **screenshot** or a **screen
recording**, fill in a short form, and Wingman creates a clean Trello card in your
configured board/list with the media attached.

Plain JavaScript, HTML, and CSS — Manifest V3, no backend, no build step.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `amigo/` folder.

## Set up Trello

1. Get an API key at <https://trello.com/app-key>.
2. On that same page, generate a **token** (grant read/write).
3. Open Wingman's **options** page (right-click the icon → *Options*, or via
   `chrome://extensions`).
4. Paste your **API key**, **token**, and **reporter name**.
5. Click **Test Trello connection** — you should see "Connected as …".
6. Pick a **board**, then a **list**, optionally add **default labels**, and **Save**.

Settings are stored in `chrome.storage.local`.

## Use it

1. Go to any normal `http://`/`https://` page (Wingman can't run on `chrome://` or the
   Web Store).
2. Click the Wingman icon or press **Alt+Shift+W**.
3. Choose **Screenshot** (drag to crop, or submit to use the full shot) or
   **Screen recording** (pick a tab/window/screen, then **Stop**).
4. Fill in the form and click **Create Trello card**.
5. Follow the success link to the new card.

> Screen recording requires a secure page (`https` or `localhost`).

## Project layout

The capture/report UI runs in its own small popup window (not injected into the page),
so there are no page-layout conflicts and the screenshot never contains Wingman's own UI.

```
manifest.json          MV3 config, permissions, keyboard command
icons/                 toolbar icons (16/48/128)
src/
  background.js        captures the visible tab + page context, opens the report window
  report.html/.js      the capture/report UI (mode toggle, crop, recording, form, submit)
  capture.js           recording, poster-frame extraction, screenshot cropping
  trello.js            Trello API calls (test, boards, lists, create card, attach)
  markdown.js          deterministic card title + description
  storage.js           chrome.storage.local wrapper
  options.html/.js     setup page (credentials + board/list dropdowns)
  styles.css           report + options styling
```
