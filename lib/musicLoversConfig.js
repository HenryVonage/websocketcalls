// Config for the Music Lovers WhatsApp demo — genre catalog, template
// names, and the shared WABA number. Same pattern as businessConfig.js's
// TICKETING block, kept in its own file since Music Lovers is a genuinely
// new demo rather than a channel variant of an existing one.
//
// Runs on the same WABA number as Henry's Real Estate / Ticketing (see
// businessConfig.js's REAL_ESTATE_WHATSAPP_NUMBER) — same reasoning as
// Ticketing's WHATSAPP.FROM_WHATSAPP: no separate number to provision,
// routing between demos is by greeting text instead (see demoRouter.js).
const businessConfig = require('./businessConfig');

const GENRES = ['Pop', 'Hip-Hop/Rap', 'Indie/Alt', 'Electronic', 'R&B', 'Rock'];

// TODO(Henry): replace every entry with a real pick from your own Spotify
// playlists — see demo-notes.md's "Genre → matched to a song from Henry's
// own Spotify playlists". spotifyTrackId is the bare id from the track's
// Spotify URL (open.spotify.com/track/<this-id>), used both for the
// henry_musicsharing2 template's "Play it on Spotify" button and to look up
// the track's 30-sec preview for the ringtone feature (lib/spotifyApi.js).
// youtubeVideoId is the bare id from the track's official YouTube URL.
const TRACK_CATALOG = {
  Pop: { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
  'Hip-Hop/Rap': { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
  'Indie/Alt': { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
  Electronic: { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
  'R&B': { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
  Rock: { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
};

function trackForGenre(genre) {
  return TRACK_CATALOG[genre] || null;
}

module.exports = {
  FROM_WHATSAPP: businessConfig.FROM_WHATSAPP,
  GENRES,
  TRACK_CATALOG,
  trackForGenre,
  // Confirmation phrase that triggers the ringtone follow-up (see
  // demo-notes.md's "Ringtone follow-up feature" section) — a loose
  // substring match on purpose, same reasoning as demoRouter.js's greeting
  // detection: small wording variations from a real reply shouldn't
  // silently miss it.
  RINGTONE_CONFIRM_RE: /stuck in my head/i,
  // Confirmed copy (see demo-notes.md) — sent as its own text message
  // immediately before the audio clip, since WhatsApp audio messages don't
  // support a caption field.
  RINGTONE_GIFT_TEXT: "🎁 Since it's stuck in your head anyway... here's your very own ringtone. You're welcome 😏",
};
