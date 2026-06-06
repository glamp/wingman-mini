#!/usr/bin/env node
// One-time helper: mint a Chrome Web Store API refresh token.
//
// Prereq: you've created an OAuth client (type "Desktop app") in a Google Cloud
// project that has the Chrome Web Store API enabled, signed in as the account
// that OWNS the store listing. See RELEASE_SETUP.md.
//
// Usage:
//   node scripts/mint-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// It opens a consent page in your browser, captures the auth code on a local
// loopback port, exchanges it, and prints the refresh token.

import http from 'node:http';
import { exec } from 'node:child_process';

const [, , CLIENT_ID, CLIENT_SECRET] = process.argv;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/mint-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const PORT = 8123;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No code in callback.');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Got it — you can close this tab and return to the terminal.');
  server.close();

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
    }),
  });
  const data = await tokenRes.json();
  if (!data.refresh_token) {
    console.error('\nNo refresh_token returned. Response was:\n', data);
    console.error('\nTip: revoke prior access and retry — the token endpoint only');
    console.error('returns a refresh_token on first consent (prompt=consent forces it).');
    process.exit(1);
  }
  console.log('\n=== Chrome Web Store refresh token ===\n');
  console.log(data.refresh_token);
  console.log('\nNow set your repo secrets (see RELEASE_SETUP.md).');
});

server.listen(PORT, () => {
  console.log('Opening consent page in your browser...');
  console.log('If it does not open, paste this URL manually:\n');
  console.log(authUrl + '\n');
  const opener =
    process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start ""'
      : 'xdg-open';
  exec(`${opener} "${authUrl}"`);
});
