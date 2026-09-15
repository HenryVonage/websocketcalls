// Channel-agnostic Music Lovers matching/picking logic — genre matching,
// Top Tracks catalog lookups, and the negative-feedback alternate-track /
// pretend-concert helpers. Extracted from lib/musicLoversFlow.js (Sept
// 2026) when lib/musicLoversRcsFlow.js was added, so the WhatsApp and RCS
// journeys share exactly one copy of this business logic instead of two
// copies that can quietly drift apart — the same lesson already learned the
// hard way in this codebase (see lib/demoRouter.js's isResetGreetingFor
// comment on the three hand-rolled greeting-reset copies, and
// lib/ticketingMarkers.js's own extraction) is being applied up front here
// rather than after a second bug.
//
// Everything below is pure/state-reading only — no sendVonageMessage calls,
// no template/card building, nothing channel-specific. musicLoversFlow.js
// (WhatsApp) and musicLoversRcsFlow.js (RCS) both import from here and only
// differ in how they turn the results into an outbound message.
const musicConfig = require('./musicLoversConfig');
const { getTopTracksCatalogForGenre } = require('./store');

// Matches free text (or a Flow answer's/RCS chip's flattened text) against
// the genre catalog — case-insensitive, via musicConfig.GENRE_SYNONYMS (see
// that file's comments for the full list of real Flow checkbox labels each
// genre covers, e.g. "Electronic Music EDM" -> Electronic, "Rap and R&B" ->
// Hip-Hop/Rap, "Classic" -> Classical, "Movie soundtrack" -> Soundtrack).
// Checks musicConfig.GENRE_MATCH_PRIORITY rather than GENRES itself — a
// separate, deliberately-ordered list so an ambiguous phrase (e.g. "Indie
// pop" containing both "indie" and "pop") resolves to the more specific
// genre instead of whichever happens to be listed first in GENRES.
//
// Returns every genre that matches, not just the first — the WhatsApp
// Flow's genre question is "Choose all that apply" (multi-select, and the
// RCS genre-picker sends one chip per genre so a tester can also tap more
// than one in a row), so pickTrackForGenres() below can fall back to a
// different one of the listener's OWN picks when the highest-priority match
// has no cached Top Track. matchGenre() (kept for every other, single-genre
// call site) is just this list's first entry.
function matchAllGenres(text) {
  const t = String(text || '').toLowerCase();
  const matches = [];
  for (const genre of musicConfig.GENRE_MATCH_PRIORITY) {
    const synonyms = musicConfig.GENRE_SYNONYMS[genre] || [];
    if (synonyms.some((s) => t.includes(s))) matches.push(genre);
  }
  return matches;
}

function matchGenre(text) {
  return matchAllGenres(text)[0] || null;
}

// Picks the track to send for a matched genre — prefers the cached
// last-4-weeks Top Tracks catalog (server.js's
// /admin/music-lovers/refresh-top-tracks-catalog, built from Henry's own
// Spotify listening, see spotifyOAuth.js's getTopTracksBucketedByGenre) and
// falls back to musicLoversConfig.js's static TRACK_CATALOG when that genre
// has no cached match yet (never refreshed, or genuinely nothing in Henry's
// recent listening matched this bucket).
function pickTrackForGenre(genre) {
  const cached = getTopTracksCatalogForGenre(genre);
  const staticTrack = musicConfig.trackForGenre(genre);
  if (cached && cached.tracks && cached.tracks.length > 0) {
    const top = cached.tracks[0];
    return {
      ...staticTrack,
      spotifyTrackId: top.spotifyTrackId,
      title: top.title,
      artist: top.artist,
      youtubeVideoId: top.youtubeVideoId || staticTrack.youtubeVideoId,
    };
  }
  return staticTrack;
}

function hasCachedTopTrack(genre) {
  const cached = getTopTracksCatalogForGenre(genre);
  return !!(cached && cached.tracks && cached.tracks.length > 0);
}

// Resolves a (possibly multi-select) list of matched genres down to the one
// genre+track to actually send — Henry's Sept 2026 rules for the "Choose
// all that apply" genre question (WhatsApp Flow and, as of the RCS build,
// tapping more than one genre chip in a row):
//  1. However many genres were selected, send exactly one track, never one
//     per genre.
//  2. Prefer whichever selected genre has a real cached Top Track (Henry's
//     own recent Spotify listening) over one that would only fall back to
//     the generic TBD/REPLACE_ME static placeholder — checked in
//     matchAllGenres' priority order, so ties resolve the same way single-
//     genre matching always has.
//  3. If NONE of the selected genres have a cached Top Track, look across
//     the WHOLE catalog for any genre that does, and send that instead —
//     `substituted: true` on the result tells the caller to send a
//     heads-up first, so the listener knows why they got a genre they
//     didn't pick. Genuinely nothing dynamic to send otherwise, and a real
//     song beats a TBD placeholder even when it's not their own pick.
// Falls all the way back to the first selected genre's static placeholder
// (substituted: false, same as this always did before Top Tracks caching
// existed) only if the cached catalog is entirely empty — e.g. the
// /admin/music-lovers/refresh-top-tracks-catalog job has never been run.
function pickTrackForGenres(genres) {
  for (const genre of genres) {
    if (hasCachedTopTrack(genre)) {
      return { genre, track: pickTrackForGenre(genre), substituted: false };
    }
  }
  for (const genre of musicConfig.GENRES) {
    if (hasCachedTopTrack(genre)) {
      return { genre, track: pickTrackForGenre(genre), substituted: true };
    }
  }
  const genre = genres[0];
  return { genre, track: pickTrackForGenre(genre), substituted: false };
}

// Tiny non-cryptographic string hash — only used by buildPretendConcertDetails
// below to deterministically pick the same "pretend" venue for the same
// artist every time, rather than a different one on every resend.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Fabricated concert details — NOT a real Ticketmaster lookup, unlike
// linkResolvers.js's resolveConcertDetails. Used once the negative-feedback
// loop's 2-song cap is reached (Henry's Sept 2026 "pretend the user could be
// interested" request) — a real lookup would need a real artist name, and
// most of this demo's catalog is still TRACK_CATALOG's placeholder data.
// Venue is picked deterministically from the artist's name
// (musicConfig.PRETEND_CONCERT_VENUES) so re-sends for the same artist land
// on the same pretend venue/date rather than a fresh one each time; date is
// formatted the same way resolveConcertDetails formats a real one, ~6 weeks
// out.
function buildPretendConcertDetails(artist) {
  const venues = musicConfig.PRETEND_CONCERT_VENUES;
  const venue = venues[Math.abs(hashString(artist)) % venues.length];
  const when = new Date(Date.now() + 42 * 24 * 60 * 60 * 1000); // ~6 weeks out
  const date = when.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const url = `https://www.ticketmaster.com/search?q=${encodeURIComponent(artist)}`;
  return { venue, date, url };
}

// Picks a candidate track for `genre` whose artist differs from
// `excludeArtist` — Henry's Sept 2026 "push another song suggestion from
// another artist" request, fired on negative feedback (see
// handleNegativeFeedback in both channel-specific flow files). Prefers
// another cached Top Track from the SAME genre (the listener already picked
// this genre, just not this particular song) — getTopTracksCatalogForGenre's
// `tracks` array can hold several candidates per genre (see server.js's
// /admin/music-lovers/refresh-top-tracks-catalog and spotifyOAuth.js's
// getTopTracksBucketedByGenre), of which pickTrackForGenre above only ever
// uses the first (tracks[0]). Falls back to any OTHER genre's own cached top
// pick (same substitution idea as pickTrackForGenres above) if this genre
// has no second artist cached. Returns null if nothing anywhere has a
// different artist (e.g. the Top Tracks catalog has never been refreshed
// and every genre is still its static TRACK_CATALOG placeholder, which
// would make excludeArtist itself "TBD" and every fallback the same "TBD").
function pickAlternateTrack(genre, excludeArtist) {
  const cached = getTopTracksCatalogForGenre(genre);
  if (cached && cached.tracks && cached.tracks.length > 0) {
    const alt = cached.tracks.find((t) => t.artist !== excludeArtist);
    if (alt) {
      const staticTrack = musicConfig.trackForGenre(genre);
      return {
        genre,
        crossGenre: false,
        track: { ...staticTrack, spotifyTrackId: alt.spotifyTrackId, title: alt.title, artist: alt.artist, youtubeVideoId: alt.youtubeVideoId || null },
      };
    }
  }
  for (const g of musicConfig.GENRES) {
    if (g === genre || !hasCachedTopTrack(g)) continue;
    const track = pickTrackForGenre(g);
    if (track.artist !== excludeArtist) return { genre: g, crossGenre: true, track };
  }
  return null;
}

module.exports = {
  matchAllGenres,
  matchGenre,
  pickTrackForGenre,
  hasCachedTopTrack,
  pickTrackForGenres,
  buildPretendConcertDetails,
  pickAlternateTrack,
};
