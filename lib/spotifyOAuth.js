// Spotify Web API — Authorization Code flow (user-consent OAuth) for the
// Music Lovers "Connect your Spotify" step (frontend/music-lovers.html) —
// reads a listener's own top artists to infer a genre bucket automatically,
// instead of asking them to pick one via henry_musicselection. Separate
// from lib/spotifyApi.js's Client Credentials flow (app-only, used only for
// track preview lookups) — this one needs the listener's own consent and a
// stored refresh token, see demo-notes.md's "Spotify access" section for
// why these are kept apart.
//
// Needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (same Spotify app as
// spotifyApi.js — one app can run both flows) and SPOTIFY_REDIRECT_URI.
// SPOTIFY_REDIRECT_URI must:
//   (a) be added to the app's Redirect URIs allow-list at
//       https://developer.spotify.com/dashboard (Settings > Redirect URIs),
//       exactly matching this value (Spotify checks it verbatim), and
//   (b) point at server.js's GET /api/spotify-callback route.
// Also: while the app is in Spotify's "Development Mode" (the default,
// before requesting extended quota), only Spotify accounts explicitly
// added under the app's dashboard "User Management" tab (by email, up to
// 25) can complete this flow — anyone else sees "You're not able to test
// this app" on Spotify's consent screen. Add Henry's own account (and any
// tester's) there first.
const crypto = require('crypto');

const SCOPES = 'user-top-read';

// Short-lived state->{phone,name} mapping so the OAuth `state` param can't
// be reused to attach someone else's Spotify connection to an
// attacker-chosen phone number. Deliberately NOT persisted to Redis like
// the rest of store.js — a connect flow that spans a Render restart (a few
// minutes, worst case) is rare and low-stakes enough for a demo that
// asking the listener to tap Connect again is the simpler tradeoff.
const pendingState = new Map(); // token -> { phone, name, createdAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function createPendingState(phone, name) {
  const token = crypto.randomBytes(16).toString('hex');
  pendingState.set(token, { phone, name, createdAt: Date.now() });
  return token;
}

function consumePendingState(token) {
  const entry = pendingState.get(token);
  if (!entry) return null;
  pendingState.delete(token);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry;
}

function getAuthorizeUrl(state) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_REDIRECT_URI not set — see .env.example');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    // Forces Spotify's consent screen every time rather than silently
    // reusing a prior grant — useful while demoing this live to different
    // people from the same shared laptop/Spotify-logged-in browser.
    show_dialog: 'true',
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Spotify code exchange failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json; // { access_token, expires_in, ... } — refresh_token only present if Spotify rotated it
}

// Fetches the listener's top artists (medium_term = ~last 6 months) and
// returns their genre tags ordered by how often they show up — Spotify's
// artist genres are free-text strings ("dance pop", "uk hip hop", etc.),
// not this demo's six-bucket catalog, so matchGenreBucket() below does the
// actual mapping.
async function getTopArtistGenres(accessToken) {
  const res = await fetch('https://api.spotify.com/v1/me/top/artists?time_range=medium_term&limit=20', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Spotify top-artists request failed: ${res.status} ${JSON.stringify(json)}`);
  }
  const genreCounts = {};
  for (const artist of json.items || []) {
    for (const g of artist.genres || []) {
      genreCounts[g] = (genreCounts[g] || 0) + 1;
    }
  }
  return Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([g]) => g);
}

// Maps Spotify's free-text genre tags onto this demo's six-genre catalog
// (musicLoversConfig.GENRES) via keyword matching — good enough for a
// demo; a production build might want a real genre-classification model
// instead. Order matters: checked top-to-bottom per tag, first match wins,
// so a compound tag like "dance pop" resolves to Electronic before Pop
// gets a chance — acceptable ambiguity for this use case.
const BUCKET_KEYWORDS = {
  'Hip-Hop/Rap': ['hip hop', 'rap', 'trap'],
  'R&B': ['r&b', 'rnb', 'soul'],
  Electronic: ['edm', 'house', 'techno', 'electro', 'dance', 'dubstep', 'trance'],
  Rock: ['rock', 'metal', 'punk', 'grunge'],
  'Indie/Alt': ['indie', 'alternative', 'alt '],
  Pop: ['pop'],
};

function matchGenreBucket(genreTags) {
  for (const tag of genreTags) {
    const t = tag.toLowerCase();
    for (const [bucket, keywords] of Object.entries(BUCKET_KEYWORDS)) {
      if (keywords.some((k) => t.includes(k))) return bucket;
    }
  }
  return null; // no confident match — caller should fall back to asking
}

module.exports = {
  createPendingState,
  consumePendingState,
  getAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getTopArtistGenres,
  matchGenreBucket,
};
