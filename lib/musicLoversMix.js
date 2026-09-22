// Music Lovers "Personal DJ mix" — the orchestration behind the "Also
// build me a personal DJ mix" option on the Connect your Spotify step
// (frontend/demo.html, Music Lovers family card).
//
// Two sources (demo.html's "Where should the tracks come from?" row):
//   own   — the visitor's own Spotify library, via their OAuth token
//           (the journey below, fired from /api/spotify-callback).
//   henry — Henry's own playlists (lib/ownerLibrary.js), via the stored
//           owner token. No visitor OAuth at all: name + WhatsApp number +
//           vibe + duration come straight from the page through
//           POST /api/music-lovers/henry-mix. The playlist is created on
//           Henry's Spotify (private, link-shareable) and the genre the
//           visitor picked on WhatsApp, if any, nudges the track ranking.
//
// Journey (fired from server.js's /api/spotify-callback right after the
// existing handleSpotifyConnected match, only when the visitor ticked the
// mix option — pending.wantMix):
//   1. WhatsApp text: "building your mix…" so the wait is explained.
//   2. Read their library (lib/spotifyLibrary.js): top tracks + up to 12
//      playlists, ≤400 tracks.
//   3. Rank by "mixability" (artist genre keywords: dance/house/electro
//      first, acoustic/classical last) and analyse the top ~120 for BPM /
//      key / energy (lib/trackFeatures.js — GetSongBPM + iTunes preview
//      analysis, cached forever in store.js).
//   4. Plan a 60-minute harmonic set (lib/mixEngine.js).
//   5. Create it as a private playlist on THEIR Spotify
//      (lib/spotifyLibrary.js createMixPlaylist).
//   6. WhatsApp text with the tracklist + playlist link + the Spotify
//      Crossfade tip, then "the arc" chart as an image. (The beat-matched
//      audio teaser was retired in Sept 2026 — MIX_TEASER=1 re-enables.)
//
// Failure handling mirrors the rest of musicLoversFlow.js: every external
// step is best-effort and the listener always gets *some* message — if
// the library has too few analysable dance tracks they're told so rather
// than left hanging. Total wall-clock is bounded to ~2 minutes by
// trackFeatures' budget so it stays a demo-length wait.
//
// WhatsApp caveat (same as the ringtone follow-up): the text + audio sends
// here are free-form messages, which Meta only delivers inside a 24-hour
// customer-service window opened by the listener messaging the business.
// In the demo journey that window is open because the visitor started
// from the wa.me deep link ("Hi…") before connecting Spotify; a visitor
// who connects Spotify without ever messaging first would get the
// henry_musicsharing3 template (handleSpotifyConnected) but these
// follow-ups would be rejected by Meta — visible as a DLR error in the
// logs page, not as a crash here.
const { randomUUID } = require('crypto');
const musicConfig = require('./musicLoversConfig');
const spotifyOAuth = require('./spotifyOAuth');
const { getListenerTracks, getArtistGenres, createMixPlaylist } = require('./spotifyLibrary');
const { getFeaturesForMany } = require('./trackFeatures');
const ownerLibrary = require('./ownerLibrary');
const { planSet, formatClock } = require('./mixEngine');
const { buildTeaser } = require('./mixTeaser');
const { renderArcPng } = require('./mixArcImage');
const { getVibe, vibeKey, normaliseDuration } = require('./mixVibes');
const { sendVonageMessage } = require('./vonageApi');
const { getSpotifyTokens, setSpotifyTokens, setMixPlan, getMixPlan, getMusicLoversState } = require('./store');
const { logEvent, redactPhone } = require('./activityLog');

const MAX_ANALYSE = 120; // tracks sent through BPM/key lookup per mix
const MAX_ANALYSE_OWNER = 320; // Henry's library is pre-analysed, so cache hits are free
const ANALYSIS_BUDGET_MS = 100000;

// The genre a visitor picked on WhatsApp (musicLoversConfig.GENRES) →
// artist-genre keywords, used as a bonus when the mix comes from Henry's
// library: it's his crate, so their pick is the one taste signal we have.
const GENRE_HINTS = {
  Pop: /pop/i,
  'Hip-Hop/Rap': /hip hop|rap|trap|drill/i,
  'Indie/Alt': /indie|alternative/i,
  Electronic: /electro|house|techno|edm|dance|trance|drum and bass|garage|breakbeat/i,
  'R&B': /r&b|soul|neo soul/i,
  Rock: /rock|punk|metal|grunge/i,
  Classical: /classical|orchestra|piano|baroque/i,
  Soundtrack: /soundtrack|score|film/i,
};

function genreHintScore(track, artistGenres, genre) {
  const re = genre && GENRE_HINTS[genre];
  if (!re) return 0;
  const genres = (track.artistIds || []).flatMap((id) => artistGenres[id] || []);
  return genres.some((g) => re.test(g)) ? 2 : 0;
}

// Genre keywords → how mixable a track is likely to be FOR THE CHOSEN VIBE
// (lib/mixVibes.js carries one weight table per vibe — the house-party one
// is the original: dance first, acoustic last). Positive = worth analysing
// early; negative = analysed only if nothing else is left. Same
// keyword-matching spirit as spotifyOAuth.js's BUCKET_KEYWORDS.
function mixabilityScore(track, artistGenres, vibe) {
  const genres = (track.artistIds || []).flatMap((id) => artistGenres[id] || []);
  let score = 0;
  for (const g of genres) for (const [re, w] of vibe.genres) if (re.test(g)) score += w;
  if (!genres.length) score += 0.5; // unknown genre: give it a chance
  if (track.durationSec < 120 || track.durationSec > 600) score -= 2; // interludes / DJ tools
  return score + (track.highlight || 0) + track.popularity / 100;
}

async function getValidAccessToken(phone) {
  let tokens = getSpotifyTokens(phone);
  if (!tokens) throw new Error('no stored Spotify tokens for this phone');
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 5000 && tokens.refreshToken) {
    const refreshed = await spotifyOAuth.refreshAccessToken(tokens.refreshToken);
    tokens = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
    setSpotifyTokens(phone, tokens);
  }
  return tokens.accessToken;
}

async function sendText(phone, text) {
  return sendVonageMessage({ from: musicConfig.FROM_WHATSAPP, to: phone, channel: 'whatsapp', message_type: 'text', text });
}

function mixLabel(vibe, durationMin) {
  return `${durationMin}-min ${vibe.label.toLowerCase()} mix`;
}

function buildTracklistText(userName, plan, playlistUrl, vibe, durationMin, source) {
  const lines = plan.tracks.map((t, i) => {
    const keyBit = t.camelot ? ` · ${t.camelot}` : '';
    return `${String(i + 1).padStart(2, ' ')}. ${formatClock(t.startSec)}  ${t.artist} – ${t.title}  (${Math.round(t.bpm)} BPM${keyBit})`;
  });
  const first = plan.tracks[0];
  const last = plan.tracks[plan.tracks.length - 1];
  const arc = first && last ? `${Math.round(first.bpm)} → ${Math.round(Math.max(...plan.tracks.map((t) => t.bpm)))} → ${Math.round(last.bpm)} BPM` : '';
  return (
    `${vibe.emoji} ${userName}, your personal ${mixLabel(vibe, durationMin)} is ready.\n\n` +
    `${plan.tracks.length} tracks from ${source === 'henry' ? "Henry's own record crate" : 'your own library'}, ordered so every transition is harmonically compatible (Camelot wheel), shaped for ${vibe.blurb}: ${arc}.\n\n` +
    `▶️ Play it on Spotify: ${playlistUrl}\n\n` +
    `Set sheet (start · track · BPM · key):\n${lines.join('\n')}\n\n` +
    `🎚️ For gapless play: in Spotify go to Settings → Playback, set Crossfade to 8–12 s and turn Automix on — the tracks are already in tempo and key order, so they blend.`
  );
}

// Entry point. Never throws — logs and messages the listener instead.
// options.vibe (lib/mixVibes.js key) and options.durationMin (30/60/90)
// come from the demo page via the OAuth pending state (source 'own') or
// the henry-mix endpoint (source 'henry'); anything missing or unknown
// falls back to the house-party hour from the visitor's own library.
async function buildAndSendMix(phone, userName, options = {}) {
  const name = userName || 'there';
  const vibe = getVibe(options.vibe);
  const durationMin = normaliseDuration(options.durationMin);
  const source = options.source === 'henry' ? 'henry' : 'own';
  const fromHenry = source === 'henry';
  const targetSec = durationMin * 60;
  try {
    await sendText(
      phone,
      fromHenry
        ? `${vibe.emoji} ${name}, I'm digging through Henry's own playlists to build you a ${mixLabel(vibe, durationMin)} — beat-matched and key-matched, from his record crate. Give me a minute…`
        : `${vibe.emoji} One more thing, ${name}: I'm reading your playlists and building you a personal ${mixLabel(vibe, durationMin)} — beat-matched and key-matched, from your own tracks. Give me a minute or two…`
    );
    logEvent('outbound', `Personal mix (${source}, ${vibeKey(options.vibe)}, ${durationMin} min): started for ${redactPhone(phone)}`, phone);

    const accessToken = fromHenry ? await ownerLibrary.getOwnerToken() : await getValidAccessToken(phone);
    const { tracks, playlistNames } = fromHenry ? await ownerLibrary.getOwnerTracks(accessToken) : await getListenerTracks(accessToken);
    if (tracks.length < 15) {
      await sendText(
        phone,
        fromHenry
          ? `Hmm — Henry's library only shows ${tracks.length} tracks right now, not enough for a ${durationMin}-minute mix. Try again later, or connect your own Spotify on the demo page instead.`
          : `Hmm — I could only see ${tracks.length} tracks in your Spotify library, which isn't enough to build a proper ${durationMin}-minute mix. Add a few playlists and tap "Share your Spotify playlists" again any time.`
      );
      logEvent('outbound', `Personal mix: library too small (${tracks.length} tracks) for ${redactPhone(phone)}`, phone);
      return;
    }
    const artistGenres = await getArtistGenres(accessToken, tracks.flatMap((t) => t.artistIds));
    const pickedGenre = fromHenry ? getMusicLoversState(phone).genre : null;
    const ranked = tracks
      .map((t) => ({ ...t, mixability: mixabilityScore(t, artistGenres, vibe) + genreHintScore(t, artistGenres, pickedGenre) }))
      .sort((a, b) => b.mixability - a.mixability)
      .slice(0, fromHenry ? MAX_ANALYSE_OWNER : MAX_ANALYSE);

    const analysed = await getFeaturesForMany(ranked, {
      budgetMs: ANALYSIS_BUDGET_MS,
      onProgress: (done, total) => {
        if (done % 40 === 0) console.log(`Personal mix ${redactPhone(phone)}: analysed ${done}/${total}`);
      },
    });
    const withBpm = analysed.filter((t) => t.bpm);
    logEvent('outbound', `Personal mix: ${withBpm.length}/${ranked.length} tracks analysed for ${redactPhone(phone)} (from ${playlistNames.length} ${fromHenry ? "of Henry's" : ''} playlists)`, phone);
    if (withBpm.length < 10) {
      await sendText(
        phone,
        fromHenry
          ? `I read ${tracks.length} tracks from Henry's library but could only work out the tempo and key for ${withBpm.length} of them — not enough for a solid mix right now. Please try again in a few minutes.`
          : `I read ${tracks.length} tracks from your library but could only work out the tempo and key for ${withBpm.length} of them — not enough for a solid mix. That usually means very new or very niche releases; try again with a playlist of club-friendly tracks.`
      );
      return;
    }

    const plan = planSet(withBpm, { targetSec, vibe });
    if (plan.tracks.length < 4) {
      await sendText(phone, `I found ${withBpm.length} mixable tracks but couldn't chain enough of them into compatible keys and tempos for a ${durationMin}-minute ${vibe.label.toLowerCase()} mix. Here's the best I could do:\n\n${plan.tracks.map((t) => `• ${t.artist} – ${t.title}`).join('\n')}`);
      return;
    }

    let playlistUrl = null;
    try {
      // Source 'henry': the owner token, so the playlist lands on Henry's
      // account (private — opens for anyone with the link, hidden from
      // his profile), named after the visitor so he can tell them apart.
      const created = await createMixPlaylist(accessToken, {
        name: fromHenry ? `${name}'s ${mixLabel(vibe, durationMin)} · from Henry's library` : `Your ${mixLabel(vibe, durationMin)} · Vonage Music Lovers`,
        description: `Built ${new Date().toISOString().slice(0, 10)} ${fromHenry ? `for ${name} from Henry's playlists` : 'from your own playlists'} by the Vonage Music Lovers demo — ${vibe.label}: ${plan.tracks.length} tracks, harmonically mixed, ${formatClock(plan.totalSec)}.`,
        uris: plan.tracks.map((t) => t.uri).filter(Boolean),
      });
      playlistUrl = created.url;
    } catch (err) {
      // Most likely the listener connected before the mix scopes existed
      // (an older token without playlist-modify-private) — the tracklist
      // still goes out, just without a tappable playlist.
      console.error('Personal mix: playlist creation failed:', err.message);
    }

    const setId = randomUUID();
    setMixPlan(setId, { phone, plan, vibe: vibeKey(options.vibe), durationMin, source, createdAt: Date.now() });
    await sendText(phone, buildTracklistText(name, plan, playlistUrl || `(playlist could not be created on ${fromHenry ? "Henry's" : 'your'} account — see the tracklist below)`, vibe, durationMin, source));
    logEvent('outbound', `Personal mix: ${plan.tracks.length} tracks / ${formatClock(plan.totalSec)} sent to ${redactPhone(phone)}${playlistUrl ? ' with playlist' : ' (no playlist)'}`, phone);

    // "The arc" chart as an image message (tempo per track over the set,
    // coloured by phase) — pre-rendered here so WhatsApp's media fetch on
    // the URL is a cache hit; the route re-renders from the stored plan
    // if it isn't (lib/mixArcImage.js).
    const base = process.env.PUBLIC_BASE_URL || '';
    try {
      renderArcPng(setId, plan, { title: `${name}'s ${mixLabel(vibe, durationMin)} — the arc` });
      await sendVonageMessage({
        from: musicConfig.FROM_WHATSAPP,
        to: phone,
        channel: 'whatsapp',
        message_type: 'image',
        image: {
          url: `${base}/music-lovers/mix-arc/${setId}.png`,
          caption: `The arc of your ${vibe.label.toLowerCase()} mix: tempo per track, coloured by phase (warm-up → build → peak → landing). Dot size is the track's energy.`,
        },
      });
      logEvent('outbound', `Personal mix: arc chart sent to ${redactPhone(phone)}`, phone);
    } catch (err) {
      console.error('Personal mix: arc chart failed:', err.message);
    }

    // Teaser audio retired (Sept 2026): it needed 30-s previews from a
    // non-Spotify source, which Henry doesn't want in the demo. The
    // seamless playback happens in Spotify itself — the set sheet above
    // ends with the Crossfade tip. lib/mixTeaser.js and the
    // /music-lovers/mix-teaser route stay for MIX_TEASER=1 experiments.
    if (process.env.MIX_TEASER === '1') {
      try {
        await buildTeaser(setId, plan.tracks, plan.medianBpm);
        await sendVonageMessage({
          from: musicConfig.FROM_WHATSAPP,
          to: phone,
          channel: 'whatsapp',
          message_type: 'audio',
          audio: { url: `${base}/music-lovers/mix-teaser/${setId}.ogg` },
        });
        logEvent('outbound', `Personal mix: teaser audio sent to ${redactPhone(phone)}`, phone);
      } catch (err) {
        console.error('Personal mix: teaser failed:', err.message);
      }
    }
  } catch (err) {
    console.error('Personal mix failed:', err);
    logEvent('outbound', `Personal mix failed for ${redactPhone(phone)}: ${err.message.slice(0, 120)}`, phone);
    await sendText(
      phone,
      fromHenry
        ? `Sorry ${name} — something went wrong while building your mix from Henry's library. Head back to the demo page and tap "Build my mix" again to retry.`
        : `Sorry ${name} — something went wrong while building your mix. Your matched track above still stands; tap "Share your Spotify playlists" again to retry the mix.`
    ).catch(() => {});
  }
}

// Used by server.js's teaser route when the in-memory render cache is cold
// (Render restart between send and fetch): re-renders from the stored plan.
async function renderTeaserForSet(setId) {
  const entry = getMixPlan(setId);
  if (!entry) return null;
  return buildTeaser(setId, entry.plan.tracks, entry.plan.medianBpm);
}

// Same for the arc chart route.
function renderArcForSet(setId) {
  const entry = getMixPlan(setId);
  if (!entry) return null;
  const vibe = getVibe(entry.vibe);
  return renderArcPng(setId, entry.plan, { title: `Your ${mixLabel(vibe, entry.durationMin || 60)} — the arc` });
}

module.exports = { buildAndSendMix, renderTeaserForSet, renderArcForSet, mixabilityScore };
