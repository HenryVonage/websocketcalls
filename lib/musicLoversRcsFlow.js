// Music Lovers, delivered over RCS instead of WhatsApp (Sept 2026, Henry's
// request: "let's build a similar demo 'Music Lovers' now over RCS").
// Reuses the exact same shared RCS agent/number as the Real Estate and
// Ticketing RCS demos (see businessConfig.js) — routed here from
// rcsFlow.js's handleRcsInbound once lib/demoRouter.js resolves an inbound
// RCS phone number to the 'music-lovers' demo (that routing was already
// wired up when Music Lovers first shipped on WhatsApp — see
// demoRouter.js's MUSIC_LOVERS_KEYWORD_RE — this file is what makes RCS
// actually do something with it instead of silently falling through to the
// Real Estate journey).
//
// Same journey/stage machine as lib/musicLoversFlow.js (WhatsApp) — see
// that file's own top-of-file comment for the stage list — with all the
// genre-matching/track-picking/negative-feedback business logic shared via
// lib/musicLoversMatching.js rather than duplicated. What differs here is
// purely how each step is delivered:
//  - WhatsApp's approved templates -> plain RCS cards/text (no
//    template-approval system on RCS, same tradeoff already made for the
//    Real Estate/Ticketing RCS demos).
//  - The WhatsApp "Explore more & give feedback" Flow (a native multi-
//    screen form) -> a tappable RCS suggestion-chip menu (sendExploreMoreMenu
//    below), since RCS has no Flow equivalent — same substitution Real
//    Estate/Ticketing already make for WhatsApp's list/Flow UI.
//  - The negative-feedback phrases ("it's okay but nothing special" / "I
//    hate it") and the ringtone-confirmation phrase are reused as literal
//    chip postback_data values, so the exact same musicConfig.NEGATIVE_FEEDBACK_RE
//    / musicConfig.RINGTONE_CONFIRM_RE regexes match a chip tap exactly the
//    way they already match WhatsApp free-typed text — one source of truth
//    for "what counts as negative feedback" / "what counts as the ringtone
//    ask", not a second hand-rolled copy.
//  - Unlike WhatsApp's Flow (which processes every answer in one
//    submission, then always closes out to 'done'), each RCS chip tap is
//    its own inbound message — so this deliberately does NOT force the
//    journey to 'done' after a single lyrics/bio/concerts/more-songs
//    answer, letting a tester keep tapping through options in sequence.
//    Only actually getting the ringtone closes the journey out, same as
//    WhatsApp's free-typed ringtone path.
//  - Out of scope for this first RCS pass (not part of the core
//    soundtrack-sharing journey Henry asked to mirror): the "My tickets" /
//    "Other question" WhatsApp-Calling follow-ups that hang off an inbound
//    PSTN call to this demo (voiceHandlers.js/musicLoversFlow.js's
//    handleMyTicketsButtonTap/handleOtherQuestionButtonTap) — those are a
//    separate, call-triggered subsystem, not something reachable from a
//    chat-only RCS journey.
//
// IMPORTANT CAVEAT, same one lib/rcsFlow.js's own header comment already
// carries for its payloads: these have NOT been tested against a live RBM
// agent yet, and one shape here is genuinely new territory for this
// codebase — see sendRingtone's own comment below on the ringtone's 'file'
// message type, and sendMatchedTrack/sendConcertsCard's 'open_url'
// suggestion type (RCS's "open a link" chip — every other RCS demo in this
// codebase so far only ever used 'reply'/'dial'/'view_location'/
// 'share_location' suggestions, never 'open_url'). Expect to debug specific
// fields against real DLR/rejection responses the same way every other RCS
// template in this codebase needed, once Henry runs a first live test.
const config = require('./businessConfig');
const musicConfig = require('./musicLoversConfig');
const {
  matchAllGenres,
  pickTrackForGenres,
  buildPretendConcertDetails,
  pickAlternateTrack,
} = require('./musicLoversMatching');
const { getTrackPreviewUrl, getTrackAlbumArtUrl } = require('./spotifyApi');
const { buildRingtoneClip, buildGeneratedRingtoneClip, isCached: isRingtoneCached } = require('./ringtoneBuilder');
const { resolveWikipediaUrl, resolveGeniusUrl, resolveConcertsUrl, resolveConcertDetails } = require('./linkResolvers');
const { searchVideoId } = require('./youtubeApi');
const { sendVonageMessage } = require('./vonageApi');
const {
  getMusicLoversState,
  setMusicLoversState,
  resetMusicLoversJourney,
  getCallerName,
  setCallerName,
} = require('./store');
const { logEvent, redactPhone } = require('./activityLog');
const { captureNameFromGreeting } = require('./nameCapture');
const { DEMOS, isResetGreetingFor } = require('./demoRouter');

const FROM = config.RCS_AGENT_ID; // same shared RCS agent as Real Estate/Ticketing, by design

function extractFields(body) {
  const messageType = body.message_type ?? 'text';
  const replyId = body.reply?.id;
  const messageText = replyId || body.button?.payload || body.button?.text || body.text || 'Hello';
  return {
    clientPhone: body.from ?? '',
    messageType,
    messageText,
    userName: getCallerName(body.from) || 'there',
  };
}

// Back to a single card (Henry's Sept 2026 call, after seeing the two-message
// version live): Vonage error 1020, "card.suggestions cannot exceed 4 items
// for the given channel", is real (see the fix commit right before this one)
// — so rather than split the prompt across two messages to fit all 8
// genres, the on-card picker is trimmed to these four representative
// genres/labels (matching real henry_musicselection Flow checkbox wording),
// keeping the hero image and the buttons together in one message. The other
// four genres (Indie/Alt, Classical, Soundtrack, and a dedicated R&B-only
// pick) are still reachable by free-typed text — see GENRE_SYNONYMS in
// musicLoversConfig.js for the full match list; "Rap and R&B" below
// deliberately resolves to Hip-Hop/Rap, same as the real Flow checkbox (see
// GENRE_MATCH_PRIORITY's comment in musicLoversConfig.js).
const GENRE_PROMPT_BUTTONS = [
  { type: 'reply', text: 'Electronic Music EDM', postback_data: 'Electronic Music EDM' },
  { type: 'reply', text: 'Rock', postback_data: 'Rock' },
  { type: 'reply', text: 'Pop music', postback_data: 'Pop music' },
  { type: 'reply', text: 'Rap and R&B', postback_data: 'Rap and R&B' },
];

async function sendGenrePrompt(phone, userName) {
  await sendVonageMessage({
    from: FROM,
    to: phone,
    channel: 'rcs',
    message_type: 'card',
    card: {
      title: 'Music Lovers',
      text: `Hi ${userName || 'there'}! Pick a genre and I'll send you a track from Henry's own playlists.`,
      media_url: musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL,
      media_height: 'MEDIUM',
      suggestions: GENRE_PROMPT_BUTTONS,
    },
    rcs: { card_orientation: 'VERTICAL' },
  });
}

// Same wording as musicLoversFlow.js's WhatsApp version — plain heads-up
// sent whenever pickTrackForGenres() had to substitute a genre the listener
// didn't pick (see that shared function's comments in musicLoversMatching.js).
async function sendGenreSubstitutionNotice(phone, pickedGenres) {
  await sendVonageMessage({
    from: FROM,
    to: phone,
    channel: 'rcs',
    message_type: 'text',
    text: `🎶 Nothing from Henry's current rotation for ${pickedGenres.join(
      ', '
    )} just yet — here's one of his other favourites instead!`,
  });
}

// Card for the matched track — title/artist, the track's own album art
// (falling back to the static hero image, same best-effort lookup as
// musicLoversFlow.js's sendMatchedTrack), Spotify/YouTube "open_url" chips
// and an "Explore more" reply chip that opens sendExploreMoreMenu below.
async function sendMatchedTrack(phone, userName, track) {
  let mediaUrl = musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL;
  try {
    const albumArtUrl = await getTrackAlbumArtUrl(track.spotifyTrackId);
    if (albumArtUrl) mediaUrl = albumArtUrl;
  } catch (err) {
    console.error('Music Lovers RCS album-art lookup failed (using hero image instead):', err.message);
  }

  const suggestions = [];
  if (track.spotifyTrackId) {
    suggestions.push({
      type: 'open_url',
      text: 'Play on Spotify',
      postback_data: 'play_spotify',
      url: `https://open.spotify.com/track/${track.spotifyTrackId}`,
    });
  }
  if (track.youtubeVideoId) {
    suggestions.push({
      type: 'open_url',
      text: 'Watch on YouTube',
      postback_data: 'watch_youtube',
      url: `https://www.youtube.com/watch?v=${track.youtubeVideoId}`,
    });
  }
  suggestions.push({ type: 'reply', text: 'Explore more', postback_data: 'explore_more' });

  await sendVonageMessage({
    from: FROM,
    to: phone,
    channel: 'rcs',
    message_type: 'card',
    card: {
      title: track.title || 'Your matched track',
      text: `By ${track.artist || "Henry's picks"} — hope you like it, ${userName}!`,
      media_url: mediaUrl,
      media_height: 'MEDIUM',
      suggestions,
    },
    rcs: { card_orientation: 'VERTICAL' },
  });
}

// RCS equivalent of the "Explore more & give feedback" WhatsApp Flow —
// tappable chips instead of a form. Negative-feedback and ringtone chips
// carry the exact literal phrases musicConfig.NEGATIVE_FEEDBACK_RE /
// RINGTONE_CONFIRM_RE already match, so handleAwaitingConfirmation below
// treats a chip tap identically to someone typing the same phrase by hand.
async function sendExploreMoreMenu(phone) {
  await sendVonageMessage({
    from: FROM,
    to: phone,
    channel: 'rcs',
    message_type: 'text',
    text: 'What would you like to explore?',
    suggestions: [
      { type: 'reply', text: '🎤 Lyrics', postback_data: 'lyrics' },
      { type: 'reply', text: '📖 Biography', postback_data: 'biography' },
      { type: 'reply', text: '🎫 Concerts', postback_data: 'concerts' },
      { type: 'reply', text: '🎶 More songs', postback_data: 'more songs' },
      { type: 'reply', text: '😍 Stuck in my head!', postback_data: 'This song is stuck in my head!' },
      { type: 'reply', text: '😐 Nothing special', postback_data: "it's okay but nothing special" },
      { type: 'reply', text: '😡 I hate it', postback_data: 'I hate it' },
    ],
  });
  logEvent('outbound', `Sent RCS explore-more chip menu to ${redactPhone(phone)}`);
}

// Card for a concert suggestion — used both for a genuine Ticketmaster
// match (resolveConcertDetails) and for the fabricated "pretend concert"
// pushed once the negative-feedback loop's 2-song cap is reached (see
// pushPretendConcert below) — a listener can't tell from the card itself
// which one it was, same as musicLoversFlow.js's WhatsApp equivalent.
async function sendConcertsCard(phone, artist, details, spotifyTrackId) {
  let mediaUrl = musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL;
  try {
    const albumArtUrl = spotifyTrackId ? await getTrackAlbumArtUrl(spotifyTrackId) : null;
    if (albumArtUrl) mediaUrl = albumArtUrl;
  } catch (err) {
    console.error('Music Lovers RCS concerts-card album-art lookup failed (using hero image instead):', err.message);
  }

  await sendVonageMessage({
    from: FROM,
    to: phone,
    channel: 'rcs',
    message_type: 'card',
    card: {
      title: `${artist} — upcoming show`,
      text: `${details.venue} • ${details.date}`,
      media_url: mediaUrl,
      media_height: 'MEDIUM',
      suggestions: [{ type: 'open_url', text: 'Get tickets', postback_data: 'get_tickets', url: details.url }],
    },
    rcs: { card_orientation: 'VERTICAL' },
  });
}

// Fabricated concert push, once the negative-feedback loop's 2-song cap is
// reached — same "pretend the user could be interested" behavior as
// musicLoversFlow.js's WhatsApp pushPretendConcert, built on the same
// shared buildPretendConcertDetails (musicLoversMatching.js).
async function pushPretendConcert(phone, state) {
  const artist = state.artist || '';
  if (!artist) return;
  const details = buildPretendConcertDetails(artist);
  await sendConcertsCard(phone, artist, details, state.spotifyTrackId);
  setMusicLoversState(phone, { concertArtist: artist, concertDetails: details });
  logEvent(
    'outbound',
    `Pushed a pretend concert (RCS) for ${artist} to ${redactPhone(phone)} (2-song negative-feedback cap reached, no concert interest shown)`
  );
}

// Same fixed-delay-instead-of-waiting-indefinitely reasoning as
// musicLoversFlow.js's pushPretendConcertIfNoInterest (and, before that,
// handleOtherQuestionButtonTap's 9s call delay) — re-reads state after the
// pause so a genuine concert request (or a fresh journey restart) landed in
// the meantime is respected instead of overwritten.
async function pushPretendConcertIfNoInterest(phone, artist) {
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const state = getMusicLoversState(phone);
  if (state.artist !== artist || state.concertDetails) return;
  await pushPretendConcert(phone, state);
}

// Sends a different song from a different artist after negative feedback —
// RCS equivalent of musicLoversFlow.js's sendAlternateSong, built on the
// same shared pickAlternateTrack (musicLoversMatching.js).
async function sendAlternateSong(phone, userName, state) {
  const alt = pickAlternateTrack(state.genre, state.artist);
  if (!alt) {
    logEvent('outbound', `Music Lovers RCS: no alternate track available for ${redactPhone(phone)} — skipped negative-feedback resend`);
    return;
  }
  if (!alt.track.youtubeVideoId) {
    try {
      alt.track.youtubeVideoId = await searchVideoId(`${alt.track.artist} - ${alt.track.title}`);
    } catch (err) {
      console.error('Music Lovers RCS alternate-track YouTube lookup failed:', err.message);
    }
    if (!alt.track.youtubeVideoId) {
      alt.track.youtubeVideoId = (musicConfig.trackForGenre(alt.genre) || {}).youtubeVideoId || null;
    }
  }

  await sendVonageMessage({
    from: FROM,
    to: phone,
    channel: 'rcs',
    message_type: 'text',
    text: alt.crossGenre
      ? `Sorry to hear that! Let's try something a little different 🎶`
      : `Sorry to hear that! Here's another one from Henry's ${alt.genre} favourites 🎶`,
  });
  await sendMatchedTrack(phone, userName, alt.track);

  const songsSent = (state.songsSent || 1) + 1;
  setMusicLoversState(phone, {
    stage: 'awaiting_confirmation',
    genre: alt.genre,
    ...alt.track,
    songsSent,
    concertArtist: undefined,
    concertDetails: undefined,
  });
  logEvent(
    'outbound',
    `Sent alternate track (RCS) ("${alt.track.title}" by ${alt.track.artist}) to ${redactPhone(phone)} (song ${songsSent}/2)`
  );

  if (songsSent >= 2) {
    pushPretendConcertIfNoInterest(phone, alt.track.artist).catch((err) =>
      console.error('Music Lovers RCS pretend-concert follow-up failed:', err.message)
    );
  }
}

// Entry point for negative feedback (a chip tap or free-typed reply
// matching musicConfig.NEGATIVE_FEEDBACK_RE) — same 2-song cap as WhatsApp:
// below the cap, sends a different song; at the cap, does nothing further
// here (pushPretendConcertIfNoInterest, scheduled by sendAlternateSong when
// the 2nd song went out, already handles the pretend concert).
async function handleNegativeFeedback(phone, userName, state) {
  const songsSent = state.songsSent || 1;
  if (songsSent >= 2) {
    logEvent('inbound', `Music Lovers RCS: negative feedback from ${redactPhone(phone)} after the 2-song cap — no further resend`);
    return;
  }
  await sendAlternateSong(phone, userName, state);
}

async function sendRingtone(phone, state) {
  const base = process.env.PUBLIC_BASE_URL || '';
  const genreParam = state.genre ? `?genre=${encodeURIComponent(state.genre)}` : '';
  const ringtoneUrl = `${base}/music-lovers/ringtone/${encodeURIComponent(state.spotifyTrackId)}.ogg${genreParam}`;

  // Same prewarm-in-parallel approach as musicLoversFlow.js's sendRingtone
  // — see that function's own comment for why (avoids a cold ffmpeg
  // build racing the receiving channel's own media-fetch timeout).
  const prewarm = (async () => {
    try {
      if (!isRingtoneCached(state.spotifyTrackId)) {
        const previewUrl = await getTrackPreviewUrl(state.spotifyTrackId);
        if (previewUrl) {
          await buildRingtoneClip(state.spotifyTrackId, previewUrl);
        } else if (state.genre) {
          await buildGeneratedRingtoneClip(state.spotifyTrackId, state.genre);
        }
      }
    } catch (err) {
      console.error('Music Lovers RCS ringtone prewarm failed (will build on fetch instead):', err.message);
    }
  })();

  await Promise.all([
    sendVonageMessage({ from: FROM, to: phone, channel: 'rcs', message_type: 'text', text: musicConfig.RINGTONE_GIFT_TEXT }),
    prewarm,
  ]);

  // ASSUMPTION, unverified against a live RCS send: RCS has no dedicated
  // 'audio' message type in this codebase (or in Vonage's public RCS docs)
  // the way WhatsApp does — the clip is sent as a generic 'file' attachment
  // instead, the same message_type ticketingFlow.js/musicLoversFlow.js
  // already use for a ticket PDF. Worth confirming on the first live test,
  // same as this file's own top-of-file caveat about untested RCS shapes —
  // if Vonage rejects this, the fix is likely a different message_type or
  // an explicit mime-type hint here.
  await sendVonageMessage({ from: FROM, to: phone, channel: 'rcs', message_type: 'file', file: { url: ringtoneUrl } });
}

// Handles everything that can arrive while awaiting_confirmation — a chip
// tap (postback_data) or free-typed text, both flattened to the same
// `text` value by extractFields. Unlike WhatsApp's Flow (one submission,
// always closes out to 'done'), each of these is its own inbound message —
// see this file's top-of-file comment on why only the ringtone confirms and
// closes the journey out; everything else leaves the tester free to keep
// exploring.
async function handleAwaitingConfirmation(phone, userName, state, text) {
  if (musicConfig.NEGATIVE_FEEDBACK_RE.test(text)) {
    await handleNegativeFeedback(phone, userName, state);
    return;
  }

  if (musicConfig.RINGTONE_CONFIRM_RE.test(text)) {
    await sendRingtone(phone, state);
    setMusicLoversState(phone, { stage: 'done' });
    logEvent('outbound', `Sent RCS ringtone clip to ${redactPhone(phone)}`);
    return;
  }

  if (text === 'explore_more' || /explore more/i.test(text)) {
    await sendExploreMoreMenu(phone);
    return;
  }

  const artist = state.artist || '';
  const title = state.title || '';
  // Same reasoning as musicLoversFlow.js's handleExploreMoreFlowCompletion:
  // Ticketmaster/Genius match against the primary/headliner artist name, so
  // a "Primary Artist, Featured Artist" string reliably finds nothing.
  const primaryArtist = artist.split(',')[0].trim();

  if (/lyrics/i.test(text) && artist && title) {
    const url = await resolveGeniusUrl(primaryArtist, title);
    await sendVonageMessage({
      from: FROM, to: phone, channel: 'rcs', message_type: 'text',
      text: `🎤 Lyrics for "${title}" by ${artist}: ${url}`,
    });
    logEvent('outbound', `Sent lyrics link to ${redactPhone(phone)} (RCS)`);
    return;
  }

  if (/biography/i.test(text) && artist) {
    const url = await resolveWikipediaUrl(artist);
    await sendVonageMessage({
      from: FROM, to: phone, channel: 'rcs', message_type: 'text',
      text: `📖 More about ${artist}: ${url}`,
    });
    logEvent('outbound', `Sent artist bio link to ${redactPhone(phone)} (RCS)`);
    return;
  }

  if (/concert/i.test(text) && artist) {
    const details = await resolveConcertDetails(primaryArtist);
    if (details) {
      await sendConcertsCard(phone, artist, details, state.spotifyTrackId);
      setMusicLoversState(phone, { concertArtist: artist, concertDetails: details });
      logEvent('outbound', `Sent RCS concert card to ${redactPhone(phone)}`);
    } else {
      const url = await resolveConcertsUrl(primaryArtist);
      await sendVonageMessage({
        from: FROM, to: phone, channel: 'rcs', message_type: 'text',
        text: `🎫 Upcoming concerts for ${artist}: ${url}`,
      });
      logEvent('outbound', `Sent concerts link to ${redactPhone(phone)} (RCS, no full event details available)`);
    }
    return;
  }

  if (/more songs/i.test(text) && artist) {
    const url = `https://open.spotify.com/search/${encodeURIComponent(artist)}`;
    await sendVonageMessage({
      from: FROM, to: phone, channel: 'rcs', message_type: 'text',
      text: `🎶 More songs from ${artist}: ${url}`,
    });
    logEvent('outbound', `Sent more-songs link to ${redactPhone(phone)} (RCS)`);
    return;
  }

  // Unmatched free text — stay in this stage, nothing to send (mirrors
  // musicLoversFlow.js's WhatsApp free-typed-reply branch).
}

// Entry point from rcsFlow.js — called with already-extracted fields, same
// convention as ticketingFlow.js's processTicketingRcs, once
// lib/demoRouter.js has resolved the inbound phone number to
// DEMOS.MUSIC_LOVERS. Dedup (message_uuid) is already handled once, for
// every RCS demo, by rcsFlow.js's own handleRcsInbound before this is ever
// called.
async function processMusicLoversRcs(fields) {
  const { clientPhone: phone } = fields;
  try {
    const capturedName = captureNameFromGreeting(fields.messageText);
    if (capturedName) {
      setCallerName(phone, capturedName);
      fields.userName = capturedName;
    }
    const userName = fields.userName;

    console.log('Music Lovers RCS inbound fields:', JSON.stringify({ ...fields, clientPhone: redactPhone(phone) }));
    logEvent('inbound', `Music Lovers RCS message from ${redactPhone(phone)}: "${fields.messageText}"`);

    // A fresh QR-triggered greeting always restarts the journey, same
    // reasoning as musicLoversFlow.js's WhatsApp reset handling and
    // rcsFlow.js's own Real Estate reset handling.
    if (isResetGreetingFor(DEMOS.MUSIC_LOVERS, fields.messageText)) {
      resetMusicLoversJourney(phone);
      logEvent('inbound', `Reset phrase detected — cleared Music Lovers state for ${redactPhone(phone)} (RCS)`);
    }

    const state = getMusicLoversState(phone);

    if (!state.stage) {
      await sendGenrePrompt(phone, userName);
      setMusicLoversState(phone, { stage: 'awaiting_genre' });
      logEvent('outbound', `Sent RCS genre prompt to ${redactPhone(phone)}`);
      return;
    }

    if (state.stage === 'awaiting_genre') {
      // Free-typed replies (or several genre chips tapped in a row) can
      // name more than one genre — same multi-select handling as WhatsApp's
      // Flow/free-text paths, via the shared pickTrackForGenres.
      const genres = matchAllGenres(fields.messageText);
      if (genres.length === 0) {
        await sendVonageMessage({
          from: FROM, to: phone, channel: 'rcs', message_type: 'text',
          text: `Sorry, I didnt catch a genre there — reply with one of: ${musicConfig.GENRES.join(', ')}.`,
        });
        return;
      }
      const { genre, track, substituted } = pickTrackForGenres(genres);
      if (substituted) {
        await sendGenreSubstitutionNotice(phone, genres);
      }
      await sendMatchedTrack(phone, userName, track);
      setMusicLoversState(phone, { stage: 'awaiting_confirmation', genre, ...track });
      logEvent(
        'outbound',
        `Matched ${redactPhone(phone)} to genre "${genre}" (RCS)${
          substituted ? ` (substituted — none of [${genres.join(', ')}] had a cached Top Track)` : ''
        }`
      );
      return;
    }

    if (state.stage === 'awaiting_confirmation') {
      await handleAwaitingConfirmation(phone, userName, state, fields.messageText);
      return;
    }

    // stage === 'done' — nothing further automated yet, mirrors WhatsApp.
  } catch (err) {
    console.error('processMusicLoversRcs error:', err);
    logEvent('outbound', `Music Lovers RCS handling failed for ${redactPhone(phone)}: ${err.message}`);
    try {
      await sendVonageMessage({
        from: FROM,
        to: phone,
        channel: 'rcs',
        message_type: 'text',
        text: "Sorry, that took a bit too long on our end — please give it a moment and try again, or say 'Hi' to restart.",
      });
    } catch (fallbackErr) {
      console.error('processMusicLoversRcs fallback send also failed:', fallbackErr);
    }
  }
}

module.exports = { extractFields, processMusicLoversRcs };
