// Music Lovers "Personal DJ mix" — the orchestration behind the "Also
// build me a 1-hour DJ mix from my playlists" option on the Connect your
// Spotify step (frontend/demo.html, Music Lovers family card).
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
//   6. WhatsApp text with the tracklist + playlist link, then a ~2-minute
//      beat-matched teaser as an audio message (lib/mixTeaser.js, served
//      by server.js's /music-lovers/mix-teaser/:setId.ogg route).
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
const { planSet, formatClock } = require('./mixEngine');
const { buildTeaser } = require('./mixTeaser');
const { renderArcPng } = require('./mixArcImage');
const { sendVonageMessage } = require('./vonageApi');
const { getSpotifyTokens, setSpotifyTokens, setMixPlan, getMixPlan } = require('./store');
const { logEvent, redactPhone } = require('./activityLog');

const TARGET_SEC = 60 * 60;
const MAX_ANALYSE = 120; // tracks sent through BPM/key lookup per mix
const ANALYSIS_BUDGET_MS = 100000;

// Genre keywords → how mixable a track is likely to be. Positive = worth
// analysing early; negative = analysed only if nothing else is left. Same
// keyword-matching spirit as spotifyOAuth.js's BUCKET_KEYWORDS.
const GENRE_WEIGHTS = [
  [/house|techno|electro|edm|dance|disco|trance|garage|drum and bass|dubstep|breakbeat|big beat|nu disco|synth/i, 3],
  [/pop|funk|r&b|afrobeat|reggaeton|latin|hip hop|rap|trap/i, 1],
  [/rock|indie|alternative|punk|metal/i, 0],
  [/acoustic|folk|singer-songwriter|classical|orchestra|jazz|ambient|piano|soundtrack|lullaby/i, -3],
];

function mixabilityScore(track, artistGenres) {
  const genres = (track.artistIds || []).flatMap((id) => artistGenres[id] || []);
  let score = 0;
  for (const g of genres) for (const [re, w] of GENRE_WEIGHTS) if (re.test(g)) score += w;
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

function buildTracklistText(userName, plan, playlistUrl) {
  const lines = plan.tracks.map((t, i) => {
    const keyBit = t.camelot ? ` · ${t.camelot}` : '';
    return `${String(i + 1).padStart(2, ' ')}. ${formatClock(t.startSec)}  ${t.artist} – ${t.title}  (${Math.round(t.bpm)} BPM${keyBit})`;
  });
  const first = plan.tracks[0];
  const last = plan.tracks[plan.tracks.length - 1];
  const arc = first && last ? `${Math.round(first.bpm)} → ${Math.round(Math.max(...plan.tracks.map((t) => t.bpm)))} → ${Math.round(last.bpm)} BPM` : '';
  return (
    `🎛️ ${userName}, your personal 1-hour mix is ready.\n\n` +
    `${plan.tracks.length} tracks from your own library, ordered so every transition is harmonically compatible (Camelot wheel) and the tempo climbs and lands like a real club set: ${arc}.\n\n` +
    `▶️ Play it on Spotify: ${playlistUrl}\n\n` +
    `Set sheet (start · track · BPM · key):\n${lines.join('\n')}\n\n` +
    `🎧 Listen to the next message for a 2-minute beat-matched taste of the transitions.`
  );
}

// Entry point. Never throws — logs and messages the listener instead.
async function buildAndSendMix(phone, userName) {
  const name = userName || 'there';
  try {
    await sendText(
      phone,
      `🎛️ One more thing, ${name}: I'm reading your playlists and building you a personal 1-hour DJ mix — beat-matched and key-matched, from your own tracks. Give me a minute or two…`
    );
    logEvent('outbound', `Personal mix: started for ${redactPhone(phone)}`, phone);

    const accessToken = await getValidAccessToken(phone);
    const { tracks, playlistNames } = await getListenerTracks(accessToken);
    if (tracks.length < 15) {
      await sendText(phone, `Hmm — I could only see ${tracks.length} tracks in your Spotify library, which isn't enough to build a proper hour-long mix. Add a few playlists and tap "Share your Spotify playlists" again any time.`);
      logEvent('outbound', `Personal mix: library too small (${tracks.length} tracks) for ${redactPhone(phone)}`, phone);
      return;
    }
    const artistGenres = await getArtistGenres(accessToken, tracks.flatMap((t) => t.artistIds));
    const ranked = tracks
      .map((t) => ({ ...t, mixability: mixabilityScore(t, artistGenres) }))
      .sort((a, b) => b.mixability - a.mixability)
      .slice(0, MAX_ANALYSE);

    const analysed = await getFeaturesForMany(ranked, {
      budgetMs: ANALYSIS_BUDGET_MS,
      onProgress: (done, total) => {
        if (done % 40 === 0) console.log(`Personal mix ${redactPhone(phone)}: analysed ${done}/${total}`);
      },
    });
    const withBpm = analysed.filter((t) => t.bpm);
    logEvent('outbound', `Personal mix: ${withBpm.length}/${ranked.length} tracks analysed for ${redactPhone(phone)} (from ${playlistNames.length} playlists)`, phone);
    if (withBpm.length < 10) {
      await sendText(phone, `I read ${tracks.length} tracks from your library but could only work out the tempo and key for ${withBpm.length} of them — not enough for a solid mix. That usually means very new or very niche releases; try again with a playlist of club-friendly tracks.`);
      return;
    }

    const plan = planSet(withBpm, { targetSec: TARGET_SEC });
    if (plan.tracks.length < 6) {
      await sendText(phone, `I found ${withBpm.length} mixable tracks but couldn't chain enough of them into compatible keys and tempos for a full hour. Here's the best I could do:\n\n${plan.tracks.map((t) => `• ${t.artist} – ${t.title}`).join('\n')}`);
      return;
    }

    let playlistUrl = null;
    try {
      const created = await createMixPlaylist(accessToken, {
        name: `Your 1-hour mix · Vonage Music Lovers`,
        description: `Built ${new Date().toISOString().slice(0, 10)} from your own playlists by the Vonage Music Lovers demo — ${plan.tracks.length} tracks, harmonically mixed, ${formatClock(plan.totalSec)}.`,
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
    setMixPlan(setId, { phone, plan, createdAt: Date.now() });
    await sendText(phone, buildTracklistText(name, plan, playlistUrl || '(playlist could not be created on your account — see the tracklist below)'));
    logEvent('outbound', `Personal mix: ${plan.tracks.length} tracks / ${formatClock(plan.totalSec)} sent to ${redactPhone(phone)}${playlistUrl ? ' with playlist' : ' (no playlist)'}`, phone);

    // "The arc" chart as an image message (tempo per track over the set,
    // coloured by phase) — pre-rendered here so WhatsApp's media fetch on
    // the URL is a cache hit; the route re-renders from the stored plan
    // if it isn't (lib/mixArcImage.js).
    const base = process.env.PUBLIC_BASE_URL || '';
    try {
      renderArcPng(setId, plan, { title: `${name}'s mix — the arc` });
      await sendVonageMessage({
        from: musicConfig.FROM_WHATSAPP,
        to: phone,
        channel: 'whatsapp',
        message_type: 'image',
        image: {
          url: `${base}/music-lovers/mix-arc/${setId}.png`,
          caption: 'The arc of your mix: tempo per track, coloured by phase (warm-up → build → peak → landing). Dot size is the track\'s energy.',
        },
      });
      logEvent('outbound', `Personal mix: arc chart sent to ${redactPhone(phone)}`, phone);
    } catch (err) {
      console.error('Personal mix: arc chart failed:', err.message);
    }

    // Teaser: pre-render so WhatsApp's media fetch on the URL is a cache
    // hit (same reasoning as sendRingtone's prewarm in musicLoversFlow.js).
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
      logEvent('outbound', `Personal mix: teaser could not be rendered for ${redactPhone(phone)} (${err.message.slice(0, 80)})`, phone);
    }
  } catch (err) {
    console.error('Personal mix failed:', err);
    logEvent('outbound', `Personal mix failed for ${redactPhone(phone)}: ${err.message.slice(0, 120)}`, phone);
    await sendText(phone, `Sorry ${name} — something went wrong while building your mix. Your matched track above still stands; tap "Share your Spotify playlists" again to retry the mix.`).catch(() => {});
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
  return renderArcPng(setId, entry.plan, { title: 'Your mix — the arc' });
}

module.exports = { buildAndSendMix, renderTeaserForSet, renderArcForSet, mixabilityScore };
