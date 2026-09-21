// Henry's own Spotify library as a mix source for the Music Lovers
// "Personal DJ mix" — the second option on demo.html's "Where should the
// tracks come from?" row. A visitor who'd rather not connect their own
// Spotify (or who isn't an approved tester of the Development-Mode app)
// still gets a real beat-/key-matched set: it's planned from Henry's
// playlists instead of theirs, in the vibe and length they picked, and
// saved as a private playlist on Henry's account (private playlists on
// Spotify still open for anyone with the link — they just don't show on
// the profile).
//
// Three pieces:
//   getOwnerToken()        — a valid access token for Henry's account
//                            (spotifyOAuth.OWNER_KEY in store.js), refreshed
//                            when needed. The one-time authorization is
//                            GET /api/spotify-auth-start?owner=1 — since
//                            this feature that route asks for MIX_SCOPES
//                            (playlist read + private-playlist write), so
//                            an owner token issued before it must be
//                            re-done once.
//   getOwnerTracks(token)  — every track in the playlists Henry owns (or
//                            only those in MIX_OWNER_PLAYLISTS when set),
//                            cached in memory for an hour: it's the same
//                            ~1 000 tracks for every visitor.
//   preanalyse()           — background job that runs lib/trackFeatures.js
//                            over the whole library once (≈1 s per track,
//                            4 in parallel) so a visitor's mix is planned
//                            from cache hits in seconds instead of
//                            analysing 120 tracks live. Kicked off by
//                            GET /admin/music-lovers/mix-preanalyse.
//                            Re-run it whenever Henry adds tracks — only
//                            the new ones get analysed.
//
// data/owner-track-seed.json is the tempo / key / mode / energy Spotify's
// (now retired) audio-features endpoint reported for Henry's "Henry"
// playlist, exported before the endpoint closed. lib/trackFeatures.js
// consults it first (lib/ownerSeed.js), the same way it would GetSongBPM: an
// authoritative tempo and key, with the preview analysis still run for
// the beat offset and preview URL the teaser needs.
const spotifyOAuth = require('./spotifyOAuth');
const { getSpotifyTokens, setSpotifyTokens } = require('./store');
const { fetchWithTimeout } = require('./httpClient');
const { getFeaturesForMany } = require('./trackFeatures');

// Sept 2026: the first live pre-analysis hit the old 1 500 cap mid-way —
// Henry owns more than that across his playlists, so whichever ones
// Spotify listed last were silently dropped (and analysed came out at
// 624/1533). Track objects are ~300 bytes, so 6 000 is nothing in memory;
// store.js's trackFeatures cap was raised alongside.
const MAX_TRACKS = 6000;
const LIBRARY_TTL_MS = 60 * 60 * 1000;
const TRACK_FIELDS = 'items(track(id,uri,name,duration_ms,popularity,external_ids(isrc),artists(id,name))),next';

async function getOwnerToken() {
  let tokens = getSpotifyTokens(spotifyOAuth.OWNER_KEY);
  if (!tokens) {
    throw new Error("No Spotify owner authorization on file — Henry needs to visit GET /api/spotify-auth-start?owner=1&admin_token=<ADMIN_TOKEN> once.");
  }
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 5000) {
    if (!tokens.refreshToken) throw new Error('Owner Spotify token expired with no refresh token — re-authorize via /api/spotify-auth-start?owner=1.');
    const refreshed = await spotifyOAuth.refreshAccessToken(tokens.refreshToken);
    tokens = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
    setSpotifyTokens(spotifyOAuth.OWNER_KEY, tokens);
  }
  return tokens.accessToken;
}

async function spotifyGet(url, accessToken) {
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify GET ${url.replace('https://api.spotify.com', '')} failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

function normaliseTrack(t, sourceLabel) {
  if (!t || !t.id || !t.duration_ms) return null;
  return {
    id: t.id,
    uri: t.uri,
    url: `https://open.spotify.com/track/${t.id}`,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    artistIds: (t.artists || []).map((a) => a.id).filter(Boolean),
    durationSec: Math.round(t.duration_ms / 1000),
    popularity: t.popularity || 0,
    isrc: t.external_ids?.isrc || null,
    source: sourceLabel,
    highlight: 0,
  };
}

let libraryCache = null; // { at, tracks, playlistNames }

// Which of Henry's playlists feed the mix: MIX_OWNER_PLAYLISTS (comma-
// separated playlist names or ids, e.g. "Henry,Electro 2026") or, unset,
// every playlist he owns. Followed playlists are skipped either way — a
// visitor's mix should come from Henry's own crate, not someone else's.
function playlistFilter() {
  const raw = String(process.env.MIX_OWNER_PLAYLISTS || '').trim();
  if (!raw) return null;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

async function getOwnerTracks(accessToken, { force = false } = {}) {
  if (!force && libraryCache && Date.now() - libraryCache.at < LIBRARY_TTL_MS) return libraryCache;
  const me = await spotifyGet('https://api.spotify.com/v1/me', accessToken);
  const wanted = playlistFilter();
  const playlists = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
  while (url) {
    const page = await spotifyGet(url, accessToken);
    for (const p of page.items || []) {
      if (!p || !p.id || !(p.tracks?.total > 0)) continue;
      if (wanted) {
        if (!wanted.has(p.id.toLowerCase()) && !wanted.has(String(p.name || '').toLowerCase())) continue;
      } else if (p.owner?.id && me.id && p.owner.id !== me.id) continue;
      playlists.push(p);
    }
    url = page.next;
  }
  // Biggest playlists first, so if the cap is ever hit it's the small
  // ones that get cut, not the main crate.
  playlists.sort((a, b) => (b.tracks?.total || 0) - (a.tracks?.total || 0));
  const byId = new Map();
  const read = [];
  for (const p of playlists) {
    const before = byId.size;
    let next = `https://api.spotify.com/v1/playlists/${p.id}/tracks?limit=100&fields=${encodeURIComponent(TRACK_FIELDS)}`;
    while (next && byId.size < MAX_TRACKS) {
      const page = await spotifyGet(next, accessToken);
      for (const item of page.items || []) {
        const t = normaliseTrack(item.track, `henry:${p.name}`);
        if (t && !byId.has(t.id)) byId.set(t.id, t);
      }
      next = page.next;
    }
    read.push({ name: p.name, total: p.tracks?.total || 0, added: byId.size - before });
    if (byId.size >= MAX_TRACKS) {
      console.error(`ownerLibrary: MAX_TRACKS (${MAX_TRACKS}) reached — ${playlists.length - read.length} playlist(s) skipped`);
      break;
    }
  }
  libraryCache = { at: Date.now(), tracks: [...byId.values()], playlistNames: playlists.map((p) => p.name), playlists: read, skipped: playlists.length - read.length };
  return libraryCache;
}

// ---------- pre-analysis job ----------
const job = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, analysed: 0, error: null, playlists: [], skipped: 0 };

async function preanalyse() {
  if (job.running) return { ...job };
  Object.assign(job, { running: true, startedAt: Date.now(), finishedAt: null, total: 0, done: 0, analysed: 0, error: null });
  (async () => {
    try {
      const token = await getOwnerToken();
      const { tracks, playlists, skipped } = await getOwnerTracks(token, { force: true });
      job.total = tracks.length;
      job.playlists = playlists;
      job.skipped = skipped;
      // No time budget: this is an admin job, not a visitor waiting on
      // WhatsApp. Cache hits return instantly so a re-run is cheap.
      const out = await getFeaturesForMany(tracks, {
        budgetMs: 6 * 60 * 60 * 1000,
        onProgress: (done) => {
          job.done = done;
          if (done % 100 === 0) console.log(`ownerLibrary: pre-analysed ${done}/${tracks.length}`);
        },
      });
      job.analysed = out.filter((t) => t.bpm).length;
    } catch (err) {
      job.error = err.message;
      console.error('ownerLibrary: pre-analysis failed:', err);
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
    }
  })();
  return { ...job };
}

function preanalyseStatus() {
  return { ...job };
}

module.exports = { getOwnerToken, getOwnerTracks, preanalyse, preanalyseStatus };
