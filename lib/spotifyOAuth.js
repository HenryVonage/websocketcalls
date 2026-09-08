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
// added under the app's dashboard "User Management" tab (by email) can
// complete this flow — anyone else sees "You're not able to test this
// app" on Spotify's consent screen. Add Henry's own account (and any
// tester's) there first. Since Spotify's February 2026 Web API changes,
// Development Mode caps this at 5 users total (was 25 before) — confirmed
// live in this app's dashboard — and also requires the app owner's own
// account to have an active Premium subscription, or the app won't work
// in Development Mode regardless of who's allow-listed.
const crypto = require('crypto');
const { fetchWithTimeout } = require('./httpClient');

const SCOPES = 'user-top-read';

// Sentinel "phone" key used to store Henry's own tokens in store.js's
// phone-keyed spotifyTokens map, distinct from any real visitor phone
// number (which normalizeToE164 always renders as digits, never able to
// collide with this). Authorized once via /api/spotify-auth-start?owner=1
// (server.js), gated by ADMIN_TOKEN instead of a phone number — see
// server.js and the "Top Tracks catalog" section of demo-notes.md.
const OWNER_KEY = '__owner__';

// Short-lived state->{phone,name} mapping so the OAuth `state` param can't
// be reused to attach someone else's Spotify connection to an
// attacker-chosen phone number. Deliberately NOT persisted to Redis like
// the rest of store.js — a connect flow that spans a Render restart (a few
// minutes, worst case) is rare and low-stakes enough for a demo that
// asking the listener to tap Connect again is the simpler tradeoff.
const pendingState = new Map(); // token -> { phone, name, createdAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function createPendingState(phone, name) {
  // Sweep expired entries here rather than on a timer — a visitor who
  // taps "Connect your Spotify" and then abandons the flow (closes the
  // tab, gets distracted) left their entry in this Map forever, since
  // consumePendingState() was the only thing that ever deleted one.
  // Piggybacking the sweep on each new connect keeps this from growing
  // unbounded without adding a background interval for a handful of
  // entries at a time.
  const now = Date.now();
  for (const [key, entry] of pendingState) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingState.delete(key);
  }
  const token = crypto.randomBytes(16).toString('hex');
  pendingState.set(token, { phone, name, createdAt: now });
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
  const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
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
  const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
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
  const res = await fetchWithTimeout('https://api.spotify.com/v1/me/top/artists?time_range=medium_term&limit=20', {
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

// Maps Spotify's free-text genre tags onto this demo's genre catalog
// (musicLoversConfig.GENRES) via keyword matching — good enough for a
// demo; a production build might want a real genre-classification model
// instead. Order matters: checked top-to-bottom per tag, first match wins,
// so a compound tag like "dance pop" resolves to Electronic before Pop
// gets a chance — acceptable ambiguity for this use case. Classical and
// Soundtrack added Sept 2026 alongside the same two genres in
// musicLoversConfig.js's GENRES/GENRE_SYNONYMS (Henry's henry_musicselection
// Flow offers "Classic" and "Movie soundtrack" checkboxes that had no
// bucket here before) — kept before Pop for the same reason every other
// entry is.
const BUCKET_KEYWORDS = {
  'Hip-Hop/Rap': ['hip hop', 'rap', 'trap'],
  'R&B': ['r&b', 'rnb', 'soul'],
  Electronic: ['edm', 'house', 'techno', 'electro', 'dance', 'dubstep', 'trance'],
  Rock: ['rock', 'metal', 'punk', 'grunge'],
  'Indie/Alt': ['indie', 'alternative', 'alt '],
  Classical: ['classical', 'orchestra', 'opera'],
  Soundtrack: ['soundtrack', 'movie tunes', 'hollywood', 'film score'],
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

// Fetches the owner's Top Tracks for a given window and buckets each one
// into this demo's genre catalog by looking up its primary artist's
// genre tags and running them through matchGenreBucket() — the same
// bucketing already used for a visitor's top-artist genres above, just
// applied per-track so a track never lands in a bucket its own artist's
// genres don't support (Henry's own ask: don't let an Electro top track
// surface under a Hip-Hop/Rap pick). A track whose artist's genres don't
// confidently match any bucket is skipped rather than misfiled.
// time_range: 'short_term' (~last 4 weeks), 'medium_term' (~6 months), or
// 'long_term' (several years) — Spotify's own windows.
// Returns { [bucket]: [{ spotifyTrackId, title, artist, popularity }] },
// only including buckets that got at least one match; caller decides what
// to do with genres that got none.
async function getTopTracksBucketedByGenre(accessToken, timeRange = 'short_term') {
  const res = await fetchWithTimeout(`https://api.spotify.com/v1/me/top/tracks?time_range=${timeRange}&limit=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Spotify top-tracks request failed: ${res.status} ${JSON.stringify(json)}`);
  }
  const tracks = json.items || [];

  // Batch-fetch every unique primary artist's genres in as few requests as
  // possible (Spotify allows up to 50 ids per /v1/artists call) rather than
  // one request per track — up to 50 top tracks realistically has well
  // under 50 unique primary artists, so this is usually a single request.
  const artistIds = [...new Set(tracks.map((t) => t.artists?.[0]?.id).filter(Boolean))];
  const artistGenres = {}; // artistId -> genres[]
  for (let i = 0; i < artistIds.length; i += 50) {
    const batch = artistIds.slice(i, i + 50);
    const artistsRes = await fetchWithTimeout(`https://api.spotify.com/v1/artists?ids=${batch.join(',')}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const artistsJson = await artistsRes.json().catch(() => ({}));
    if (!artistsRes.ok) {
      throw new Error(`Spotify artists lookup failed: ${artistsRes.status} ${JSON.stringify(artistsJson)}`);
    }
    for (const a of artistsJson.artists || []) {
      if (a) artistGenres[a.id] = a.genres || [];
    }
  }

  const byGenre = {};
  for (const t of tracks) {
    const primaryArtistId = t.artists?.[0]?.id;
    const bucket = matchGenreBucket(artistGenres[primaryArtistId] || []);
    if (!bucket) continue;
    if (!byGenre[bucket]) byGenre[bucket] = [];
    byGenre[bucket].push({
      spotifyTrackId: t.id,
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', '),
      popularity: t.popularity,
    });
  }
  return byGenre;
}

module.exports = {
  OWNER_KEY,
  createPendingState,
  consumePendingState,
  getAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getTopArtistGenres,
  matchGenreBucket,
  getTopTracksBucketedByGenre,
};
