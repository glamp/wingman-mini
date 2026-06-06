# Privacy Policy

_Last updated: June 6, 2026_

Wingman is a Chrome extension that lets you capture a screenshot or screen
recording of a web page, optionally describe an issue by voice, and file the
result as a Trello card. This policy explains what data Wingman handles and where
it goes.

## What Wingman handles

- **Screenshots and screen recordings** you capture.
- **Voice audio** you record to describe an issue.
- **Text** you type into the report form (title, description).
- **Your credentials and settings**: your Trello API key and token, your Groq API
  key, your reporter name, and your chosen board/list. These are stored locally in
  your browser via `chrome.storage.local` and never leave your machine except to
  call the services below.

## Where your data goes

Wingman sends data only to the two services you configure, using your own
credentials:

- **Trello (`api.trello.com`)** — the card title, description, and the
  screenshot/recording attachment are sent to your own Trello board to create the
  card.
- **Groq (`api.groq.com`)** — when you record voice, the audio (and a short
  prompt) is sent to Groq to transcribe your speech and draft the form fields.

Your use of those services is governed by their respective privacy policies:

- Trello / Atlassian: <https://www.atlassian.com/legal/privacy-policy>
- Groq: <https://groq.com/privacy-policy/>

## What Wingman does NOT do

- No analytics, telemetry, advertising, or tracking.
- No selling or sharing of your data with any third party, other than the Trello
  and Groq calls described above that you initiate with your own accounts.
- No developer-operated backend or server — there is nowhere else for your data to
  go. Everything runs locally in your browser.

## Data retention

Wingman itself stores nothing beyond your settings in your browser's local
storage. You can clear it at any time by removing the extension or clearing its
storage. Any data you send to Trello or Groq is retained according to those
services' own policies.

## Contact

Questions about this policy: open an issue at
<https://github.com/glamp/wingman-mini> or email greg@airplx.com.
