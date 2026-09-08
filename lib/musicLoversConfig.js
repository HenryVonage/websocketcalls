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

// Sept 2026: expanded from 6 to 8 genres after Henry's live henry_musicselection
// Flow screenshot showed 2 checkboxes ("Classic", "Movie soundtrack") this
// catalog had no home for at all — any tester picking either one fell
// through to the generic "Sorry, I didnt catch a genre there" message.
// Classical/Soundtrack are the real Spotify-searchable genre names for
// those two checkboxes (see GENRE_SYNONYMS below for how each of the
// Flow's actual 8 checkbox labels maps onto this list).
//
// Order here is the *display* order (this array is also what gets echoed
// back in the "reply with one of: ..." fallback message) and, via GENRES[0],
// the default genre handleSpotifyConnected() falls back to when a Spotify
// listener's own top-artist genres don't confidently bucket into anything —
// so Pop staying first here is deliberate. Match *priority* (which genre
// wins when a phrase could plausibly match more than one) is a separate
// concern, handled by GENRE_MATCH_PRIORITY below rather than by reordering
// this array.
const GENRES = ['Pop', 'Hip-Hop/Rap', 'Indie/Alt', 'Electronic', 'R&B', 'Rock', 'Classical', 'Soundtrack'];

// Explicit label -> genre mapping, covering every one of the 8 real
// checkbox labels from Henry's henry_musicselection Flow ("Electronic Music
// EDM", "Pop music", "Rock (English&US)", "Rock (French)", "Rap and R&B",
// "Classic", "Movie soundtrack", "Indie pop") plus reasonable free-typed
// variants, so matching no longer depends on a checkbox's label happening
// to contain a genre's exact internal name as a lucky substring.
//
// Two deliberate simplifications, both worth revisiting if Henry wants a
// dedicated track per option later:
//  - "Rock (English&US)" and "Rock (French)" both resolve to the single
//    Rock bucket/track for now — the Flow doesn't offer separate tracks
//    per language.
//  - "Rap and R&B" resolves to Hip-Hop/Rap specifically (see
//    GENRE_MATCH_PRIORITY below) since one checkbox can only pick one
//    track bucket; a tester who free-types "R&B" alone still gets the R&B
//    bucket.
const GENRE_SYNONYMS = {
  Pop: ['pop'],
  'Hip-Hop/Rap': ['hip hop', 'hip-hop', 'rap'],
  'Indie/Alt': ['indie', 'alt', 'alternative'],
  Electronic: ['electronic', 'edm'],
  'R&B': ['r&b', 'rnb', 'r n b', 'rhythm and blues'],
  Rock: ['rock'],
  Classical: ['classical', 'classic'],
  Soundtrack: ['soundtrack', 'film score', 'movie score'],
};

// The order matchGenre() (musicLoversFlow.js) actually checks genres in —
// kept separate from GENRES' own display/default order above so fixing a
// matching ambiguity never silently changes handleSpotifyConnected()'s
// fallback default. Same convention, and same underlying reason, as
// spotifyOAuth.js's BUCKET_KEYWORDS: Pop stays last because "pop" is a
// substring of several compound genre phrases this Flow actually sends
// ("Indie pop" from the checkbox, plus free-typed variants like "dance
// pop") — checking Pop first would resolve all of those to Pop instead of
// their real genre. Classical/Soundtrack are checked before Pop for the
// same reason, and Rock is checked before Classical so a free-typed
// "classic rock" resolves to Rock rather than Classical.
const GENRE_MATCH_PRIORITY = ['Hip-Hop/Rap', 'R&B', 'Electronic', 'Rock', 'Indie/Alt', 'Classical', 'Soundtrack', 'Pop'];

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
  Classical: { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
  Soundtrack: { spotifyTrackId: 'REPLACE_ME', youtubeVideoId: 'REPLACE_ME', title: 'TBD', artist: 'TBD' },
};

function trackForGenre(genre) {
  return TRACK_CATALOG[genre] || null;
}

// henry_musicselection's approved image header (confirmed via a live DLR
// rejection, Sept 2026: sending no header component got
// "header: Format mismatch, expected IMAGE, received UNKNOWN" — the
// template has an image header that wasn't visible in the WhatsApp Manager
// screenshot used to fix the body params). Henry confirmed re-using the
// Music Lovers hero image already hosted on the frontend site rather than
// uploading a separate asset just for this header.
const GENRE_PROMPT_HEADER_IMAGE_URL = 'https://henryvonage.github.io/frontend/assets/music-lovers-hero.jpg';

module.exports = {
  FROM_WHATSAPP: businessConfig.FROM_WHATSAPP,
  GENRES,
  GENRE_SYNONYMS,
  GENRE_MATCH_PRIORITY,
  TRACK_CATALOG,
  GENRE_PROMPT_HEADER_IMAGE_URL,
  trackForGenre,
  // Confirmation phrase that triggers the ringtone follow-up (see
  // demo-notes.md's "Ringtone follow-up feature" section) — a loose
  // substring match on purpose, same reasoning as demoRouter.js's greeting
  // detection: small wording variations from a real reply shouldn't
  // silently miss it.
  RINGTONE_CONFIRM_RE: /stuck in my head/i,
  // Sent as its own text message immediately before the audio clip, since
  // WhatsApp audio messages don't support a caption field. Reworded Sept
  // 2026 (Henry's request) from "here's your very own ringtone" — that
  // phrasing promised the actual song trimmed down, which stopped being
  // true once Spotify's preview_url went away for nearly every track and
  // this became almost always the ElevenLabs genre-matched fallback (see
  // ringtoneBuilder.js/elevenLabsMusic.js) rather than a real clip of the
  // song. "Similar" sets the right expectation either way, so this one
  // wording covers both the real-preview and generated paths.
  RINGTONE_GIFT_TEXT: "🎁 Since it's stuck in your head anyway... here's a ringtone similar to it. Enjoy! 😏",
};
