// Tempo / key / mode / energy that Spotify's (now retired) audio-features
// endpoint reported for Henry's "Henry" playlist, exported before the
// endpoint closed in Nov 2024 (Exportify CSV → data/owner-track-seed.json,
// keyed by Spotify track id). lib/trackFeatures.js consults it first for
// any track it's asked about — a visitor's own library overlaps with it
// too — the same way it would GetSongBPM: an authoritative tempo and key,
// with the iTunes preview analysis still run afterwards for the beat
// offset and preview URL the teaser needs. Kept in its own module so
// trackFeatures.js and ownerLibrary.js don't require each other.
const path = require('path');

let seed = null;

function getSeed(trackId) {
  if (seed === null) {
    try {
      seed = require(path.join(__dirname, '..', 'data', 'owner-track-seed.json'));
    } catch (err) {
      console.error('ownerSeed: no data/owner-track-seed.json (continuing without it):', err.message);
      seed = {};
    }
  }
  const s = trackId && seed[trackId];
  if (!s || !s.bpm) return null;
  return { bpm: s.bpm, key: s.key ?? null, mode: s.mode ?? null, energy: s.energy ?? null, source: 'spotify-seed' };
}

module.exports = { getSeed };
