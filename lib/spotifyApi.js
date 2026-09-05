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
  const res = await fetch('https://accounts.spotify.com/api/token', {
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
  const res = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Spotify track lookup failed:', res.status, JSON.stringify(json));
    return null;
  }
  return json.preview_url || null;
}

module.exports = { getTrackPreviewUrl };
