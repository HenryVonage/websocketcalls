// Spotify Web API — Client Credentials flow (app-only auth, no user login)
// used purely to look up a track's 30-second preview_url for the Music
// Lovers ringtone follow-up feature (see demo-notes.md). Needs
// SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in the environment — create an
// app at https://developer.spotify.com/dashboard to get these, no approval
// wait required for this Client Credentials use case.
//
// Deliberately NOT the OAuth-with-user-consent flow the "Connect your
// Spotify" frontend step (frontend/music-lovers.html) will eventually need
// for reading a listener's own playlists for instant genre matching —
// that's a separate, bigger piece of work (authorization code flow +
// refresh token storage) not built yet, tracked as its own open next step.
// This file only covers the app-level track lookup the genre-matched
// catalog (musicLoversConfig.js) and the ringtone clip need.

const { fetchWithTimeout } = require('./httpClient');

let cachedToken = null; // { value, expiresAt }

async function getAppToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) {
    return cachedToken.value;
  }
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set — see .env.example');
  }
  const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Spotify token request failed: ${res.status} ${JSON.stringify(json)}`);
  }
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

// Returns the track's 30-sec preview MP3 URL, or null if Spotify doesn't
// have one for this track — many newer/catalog tracks no longer do (see
// demo-notes.md's "Ringtone follow-up feature" caveats), so callers need a
// fallback (a royalty-free genre-matched stinger, not yet built) for that
// case rather than treating null as an error.
async function getTrackPreviewUrl(trackId) {
  const token = await getAppToken();
  const res = await fetchWithTimeout(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Spotify track lookup failed:', res.status, JSON.stringify(json));
    return null;
  }
  return json.preview_url || null;
}

// Returns the track's largest album-art image URL, or null if unavailable
// (no images array, or the lookup fails — e.g. a placeholder/invalid track
// id) — used by musicLoversFlow.js's sendMatchedTrack to personalize
// henry_musicsharing2's image header with the actual matched song's
// artwork, falling back to the static Music Lovers hero image on a null.
// Spotify's images array is ordered largest-first (typically 640x640,
// 300x300, 64x64), so images[0] is the one wanted for a WhatsApp header.
async function getTrackAlbumArtUrl(trackId) {
  const token = await getAppToken();
  const res = await fetchWithTimeout(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Spotify track lookup failed (album art):', res.status, JSON.stringify(json));
    return null;
  }
  return json.album?.images?.[0]?.url || null;
}

// Returns every track in a PUBLIC playlist as a flat array of
// { id, name, artists, spotifyUrl, addedAt }, paginating through Spotify's
// /v1/playlists/{id}/tracks endpoint (100 items per page) until exhausted.
// Uses the same app-only Client Credentials token as the lookups above —
// no user OAuth needed, which only works because this reads a playlist
// that's public (confirmed: viewable at open.spotify.com without login).
// A local/private playlist would 404 or come back empty under this flow —
// that would need the separate Authorization Code OAuth flow in
// spotifyOAuth.js instead, scoped to whichever user owns it.
// Local (podcast-episode / unavailable) items have a null `track` and are
// skipped rather than throwing. Hard-capped at 60 pages (6,000 tracks) as a
// runaway-loop guard against a malformed `next` cursor.
async function getPlaylistTracks(playlistId) {
  const token = await getAppToken();
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&fields=items(added_at,track(id,name,artists(name),external_urls,is_local)),next`;
  for (let page = 0; page < 60 && url; page += 1) {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Spotify playlist tracks request failed: ${res.status} ${JSON.stringify(json)}`);
    }
    for (const item of json.items || []) {
      const t = item.track;
      if (!t || t.is_local) continue; // skip local files Spotify can't serve a public URL for
      tracks.push({
        id: t.id,
        name: t.name,
        artists: (t.artists || []).map((a) => a.name).join(', '),
        spotifyUrl: t.external_urls?.spotify || null,
        addedAt: item.added_at || null,
      });
    }
    url = json.next || null;
  }
  return tracks;
}

module.exports = { getTrackPreviewUrl, getTrackAlbumArtUrl, getPlaylistTracks };
