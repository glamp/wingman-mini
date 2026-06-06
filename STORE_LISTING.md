# Chrome Web Store listing copy

Ready-to-paste text for the Developer Dashboard fields that the publishing API
**cannot** set (description, single purpose, permission justifications, privacy
disclosures). Paste these into the dashboard for the `hdbmgfgonajjmibdlaljefopoiogfmlf`
item before/after uploading the new version.

---

## Item name

Wingman

## Summary (short description, ≤132 chars)

Capture a screenshot or screen recording, describe the bug by voice, and file a clean Trello card — without leaving the page.

## Description

Wingman turns "something's broken here" into a well-formed Trello card in seconds.

Press **⌘+Shift+K** (Mac) / **Alt+Shift+K** (Windows/Linux), or click the toolbar icon, on any page, then:

• **Screenshot** — drag to crop, or grab the full visible tab.
• **Screen recording** — record a tab, window, or your whole screen to show the bug in motion.
• **Talk it through** — narrate what's wrong. Wingman transcribes your voice and pre-fills the title and description for you to review.
• **File it** — Wingman creates a Trello card in your configured board and list with the screenshot/recording attached and your notes in the description.

The capture UI renders in an isolated in-page overlay, so it never appears in your screenshot and never clashes with the page's own styles.

**Setup:** Wingman needs your own Trello API key + token (for the board you choose) and a Groq API key (used for voice transcription and auto-fill). Keys are stored locally in your browser and are sent only to Trello and Groq.

Plain, dependency-free Manifest V3. No backend, no accounts, no tracking.

## Single purpose

Wingman lets a user capture a screenshot or screen recording of a web page, optionally describe the issue by voice, and file the result as a Trello card.

---

## Permission justifications

Paste one line per permission into the matching field.

- **activeTab** — Capture a screenshot of the page the user is currently viewing when they invoke Wingman.
- **tabs** — Capture the visible tab image (`captureVisibleTab`) and detect the active tab so the overlay opens on the right page.
- **scripting** — Inject the capture/report overlay into the current page when the user activates Wingman.
- **storage** — Save the user's own settings locally (Trello API key/token, chosen board and list, reporter name, Groq API key) so they don't re-enter them each time.
- **notifications** — Notify the user that a Trello card was created successfully or that an error occurred during capture/upload.
- **Host permission `https://api.trello.com/*`** — Create the Trello card and upload the screenshot/recording attachment to the board and list the user configured.
- **Host permission `https://api.groq.com/*`** — Send the user's voice recording to Groq for transcription (Whisper) and to auto-fill the report form; called from the background service worker to avoid CORS.
- **Content scripts on `https://*/*` and `http://*/*`** — The overlay must be available on any page where the user might find a bug, since bugs can occur on any site. Code runs only after the user explicitly activates Wingman.

---

## Privacy / data-usage disclosures

**What user data the extension handles**

- Screenshots and screen recordings the user captures.
- Voice audio the user records to describe an issue.
- Text the user types into the report form (title, description).
- User-supplied credentials: Trello API key + token, Groq API key, reporter name.

**Where it goes**

- **Trello (api.trello.com):** the card title, description, and the screenshot/recording attachment are sent to the user's own Trello board to create the card.
- **Groq (api.groq.com):** the voice recording (and a short prompt) is sent to Groq to transcribe speech and draft the form fields.
- Nothing else leaves the browser. Credentials and settings are stored only in `chrome.storage.local` on the user's machine.

**What the extension does NOT do**

- No analytics, telemetry, ads, or tracking.
- No data sold or shared with third parties beyond the user's own Trello and Groq accounts described above.
- No remote server operated by the developer; there is no backend.

**Certification checkboxes** (tick all three on the Privacy tab)

- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## ⚠️ Note about this update replacing the previous extension

This version replaces the previously published code with the Wingman Trello
capture tool. Because it requests new host permissions (`api.trello.com`,
`api.groq.com`) and `notifications`, **existing users will be prompted to
re-accept permissions and the extension stays disabled until they do.** Expect a
slightly longer review because of the new host permissions.
