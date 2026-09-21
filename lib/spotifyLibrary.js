// Spotify Web API calls the "Personal DJ mix" feature needs on top of
// lib/spotifyOAuth.js (which stays focused on the OAuth dance + the
// top-artists genre match): reading a listener's playlists and top tracks,
// batch-fetching artist genres, and writing the finished mix back to their
// account as a private playlist. All calls take the listener's own access
// token (Authorization Code flow) — none of this works with the app-only
// Client Credentials token in lib/spotifyApi.js.
//
// Everything still works on Spotify's post-Nov-2024 API surface:
//   /v1/me/playlists, /v1/playlists/{id}/tracks, /v1/me/top/tracks,
//   /v1/artists, /v1/me/playlists (POST), /v1/playlists/{id}/tracks (POST).
// Nothing here touches audio-features/recommendations/preview_url.
const { fetchWithTimeout } = require('./httpClient');

const MAX_PLAYLISTS = 12; // most-recent first as Spotify lists them
const MAX_TRACKS = 400; // hard cap on what we'll even consider analysing
const TRACK_FIELDS = 'items(track(id,uri,name,duration_ms,popularity,external_ids(isrc),artists(id,name))),next';

async function spotifyGet(url, accessToken) {
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify GET ${url.replace('https://api.spotify.com', '')} failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function spotifyPost(url, accessToken, body) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify POST ${url.replace('https://api.spotify.com', '')} failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

function normaliseTrack(t, sourceLabel) {
  if (!t || !t.id || !t.duration_ms) return null; // local files / podcasts have no id
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
  };
}

// Listener's own playlists (owned + followed) plus their medium-term top
// tracks, de-duplicated by track id. Top tracks are flagged `highlight`
// so the planner (lib/mixEngine.js) favours the songs they actually play.
async function getListenerTracks(accessToken) {
  const byId = new Map();
  const add = (t, highlight) => {
    if (!t) return;
    const existing = byId.get(t.id);
    if (existing) {
      existing.highlight = Math.max(existing.highlight || 0, highlight);
      return;
    }
    byId.set(t.id, { ...t, highlight });
  };

  // Top tracks first — they're the taste signal and there are only 50.
  try {
    const top = await spotifyGet('https://api.spotify.com/v1/me/top/tracks?time_range=medium_term&limit=50', accessToken);
    for (const t of top.items || []) add(normaliseTrack(t, 'top'), 3);
  } catch (err) {
    console.error('spotifyLibrary: top tracks failed (continuing with playlists):', err.message);
  }

  const lists = await spotifyGet(`https://api.spotify.com/v1/me/playlists?limit=${MAX_PLAYLISTS}`, accessToken);
  const playlists = (lists.items || []).filter((p) => p && p.id && p.tracks?.total > 0);
  for (const p of playlists) {
    if (byId.size >= MAX_TRACKS) break;
    let url = `https://api.spotify.com/v1/playlists/${p.id}/tracks?limit=100&fields=${encodeURIComponent(TRACK_FIELDS)}`;
    // Spotify lists playlist items oldest-first; for a big playlist the
    // most recently added tracks say more about current taste, so start
    // from the tail.
    if (p.tracks.total > 200) url += `&offset=${p.tracks.total - 200}`;
    while (url && byId.size < MAX_TRACKS) {
      const page = await spotifyGet(url, accessToken);
      for (const item of page.items || []) add(normaliseTrack(item.track, `playlist:${p.name}`), 0);
      url = page.next;
    }
  }
  return { tracks: [...byId.values()], playlistNames: playlists.map((p) => p.name) };
}

// artistId -> genres[] for up to hundreds of ids, 50 per request (Spotify's
// batch limit). Used to rank which tracks are worth analysing first (dance
// material before acoustic ballads) — see lib/musicLoversMix.js.
async function getArtistGenres(accessToken, artistIds) {
  const ids = [...new Set(artistIds.filter(Boolean))];
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const json = await spotifyGet(`https://api.spotify.com/v1/artists?ids=${batch.join(',')}`, accessToken);
      for (const a of json.artists || []) if (a) out[a.id] = a.genres || [];
    } catch (err) {
      console.error('spotifyLibrary: artist genres batch failed:', err.message);
    }
  }
  return out;
}

// Creates a private playlist on the listener's account and fills it in
// set order. Needs the playlist-modify-private scope (see
// spotifyOAuth.js's MIX_SCOPES). Returns { id, url }.
async function createMixPlaylist(accessToken, { name, description, uris }) {
  const created = await spotifyPost('https://api.spotify.com/v1/me/playlists', accessToken, {
    name,
    description,
    public: false,
  });
  for (let i = 0; i < uris.length; i += 100) {
    await spotifyPost(`https://api.spotify.com/v1/playlists/${created.id}/tracks`, accessToken, { uris: uris.slice(i, i + 100) });
  }
  return { id: created.id, url: created.external_urls?.spotify || `https://open.spotify.com/playlist/${created.id}` };
}

module.exports = { getListenerTracks, getArtistGenres, createMixPlaylist };
