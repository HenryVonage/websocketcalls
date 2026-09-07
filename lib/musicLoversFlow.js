// Music Lovers WhatsApp demo — soundtrack-sharing over WhatsApp (see
// demo-notes.md for the full concept/build notes). Deliberately a plain
// code-driven state machine rather than Claude-marker-decided like
// whatsappFlow.js/ticketingEngine.js — the journey here is short and fully
// deterministic (prompt genre -> match track -> send it -> wait for the
// ringtone confirmation phrase), so there's no ambiguous branching that
// actually needs a model in the loop.
//
// Journey stages, persisted per phone number (see store.js):
//   (no state yet)      -> send henry_musicselection, move to awaiting_genre
//   awaiting_genre       -> match a genre from the reply, send
//                           henry_musicsharing2, move to awaiting_confirmation
//   awaiting_confirmation -> on "...stuck in my head..." (see
//                            musicLoversConfig.js's RINGTONE_CONFIRM_RE),
//                            send the ringtone clip, move to done
//   done                 -> nothing further automated yet
const { randomUUID } = require('crypto');
const businessConfig = require('./businessConfig');
const musicConfig = require('./musicLoversConfig');
const spotifyOAuth = require('./spotifyOAuth');
const { getTrackPreviewUrl, getTrackAlbumArtUrl } = require('./spotifyApi');
const { buildRingtoneClip, isCached: isRingtoneCached } = require('./ringtoneBuilder');
const { sendVonageMessage } = require('./vonageApi');
const {
  getMusicLoversState,
  setMusicLoversState,
  resetMusicLoversJourney,
  getCallerName,
  setCallerName,
  getSpotifyTokens,
  getTopTracksCatalogForGenre,
} = require('./store');
const { logEvent, redactPhone } = require('./activityLog');
const { captureNameFromGreeting } = require('./nameCapture');
const { DEMOS, isResetGreetingFor } = require('./demoRouter');
const { isDuplicateMessage } = require('./dedup');

function extractMessageText(body) {
  return (
    body.text ??
    body.button?.text ??
    body.button?.payload ??
    body.interactive?.button_reply?.title ??
    body.interactive?.list_reply?.title ??
    body.reply?.title ??
    ''
  );
}

// Matches free text (or a template reply's title) against the six genres —
// case-insensitive, and tolerant of a reply naming just one half of a
// slash-joined genre ("Hip-Hop" or "Rap" both match "Hip-Hop/Rap"). Doesn't
// know the real henry_musicselection reply-id shape yet (see
// sendGenrePrompt's TODO below), so text is the only signal available.
function matchGenre(text) {
  const t = String(text || '').toLowerCase();
  return (
    musicConfig.GENRES.find(
      (g) => t.includes(g.toLowerCase()) || g.toLowerCase().split('/').some((part) => t.includes(part))
    ) || null
  );
}

// Picks the track to send for a matched genre — prefers the cached
// last-4-weeks Top Tracks catalog (server.js's
// /admin/music-lovers/refresh-top-tracks-catalog, built from Henry's own
// Spotify listening, see spotifyOAuth.js's getTopTracksBucketedByGenre) and
// falls back to musicLoversConfig.js's static TRACK_CATALOG when that
// genre has no cached match yet (never refreshed, or genuinely nothing in
// Henry's recent listening matched this bucket). youtubeVideoId always
// comes from the static entry — Spotify's API has no YouTube video mapping,
// so that field still needs Henry's own manual pick regardless of which
// source picked the song itself.
function pickTrackForGenre(genre) {
  const cached = getTopTracksCatalogForGenre(genre);
  const staticTrack = musicConfig.trackForGenre(genre);
  if (cached && cached.tracks && cached.tracks.length > 0) {
    const top = cached.tracks[0];
    return { ...staticTrack, spotifyTrackId: top.spotifyTrackId, title: top.title, artist: top.artist };
  }
  return staticTrack;
}

async function sendGenrePrompt(phone, userName) {
  // Confirmed live in WhatsApp Manager (screenshot, Sept 2026): body is
  // "Hi {{1}}, welcome to {{2}} demo.\n\nChoose the genres of music you
  // love!" — exactly 2 body params. Sending components: [] (the original
  // placeholder) got this rejected outright by Vonage: error 1022 "number
  // of localizable_params (0) does not match the expected number of
  // params (2)" — the send never reached the recipient at all.
  //
  // Fixing just the body params still wasn't enough: a second live DLR
  // rejection (Sept 2026) came back as error 1022 again, this time
  // "header: Format mismatch, expected IMAGE, received UNKNOWN" — the
  // template also has an image header that wasn't visible in the
  // WhatsApp Manager screenshot used above. Henry confirmed reusing the
  // Music Lovers hero image already hosted on the frontend site (see
  // musicLoversConfig.GENRE_PROMPT_HEADER_IMAGE_URL) rather than a
  // separate upload.
  //
  // The template's CTA button ("Select your favorite music genres") is a
  // WhatsApp Flow (Meta's native multi-screen form — "Complete flow",
  // "Question 1 of 3"). Its completion is parsed by
  // handleGenrePickerFlowCompletion below (same Vonage button.payload
  // shape as every other Flow completion in this codebase); typing a
  // genre by hand (matchGenre()) still works too, as an alternative path.
  //
  // The components array below must still include that Flow button even
  // though this code can't parse its reply yet — Vonage/Meta validates
  // the components array against the template's actual approved shape,
  // not just against the params this code happens to use, and rejects a
  // send that omits a component the template has (live DLR, Sept 2026:
  // error 1020 "Components sub_type invalid at index: 0 and type: 0").
  // Same root cause and same fix as henry_form3 in
  // ticketingWhatsappFlow.js and henry_form2 in voiceHandlers.js — a
  // pre-defined Flow screen needs no flow_action_data, just a fresh
  // flow_token per send.
  const payload = {
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'custom',
    custom: {
      type: 'template',
      template: {
        namespace: businessConfig.TEMPLATE_NAMESPACE,
        name: 'henry_musicselection',
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL } }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: userName || 'there' },
              { type: 'text', text: 'Music Lovers' },
            ],
          },
          {
            type: 'button',
            sub_type: 'flow',
            index: 0,
            parameters: [{ type: 'action', action: { flow_token: randomUUID() } }],
          },
        ],
      },
    },
  };
  await sendVonageMessage(payload);
}

async function sendMatchedTrack(phone, userName, track) {
  // Re-confirmed live in WhatsApp Manager (screenshot, Sept 2026): body is
  // "Hi {{1}},\nWelcome to the Music Lovers soundtrack-sharing demo.\n\n
  // Based on your selected music genre, here is a song from Henry's
  // favourites.\n\nLet the music play!" — exactly 1 body param, matching
  // below. Footer text ("Tap below to listen, go further, or tell us what
  // you think") is static, no component needed. Button index (not the
  // template variable number) is what disambiguates the Spotify vs.
  // YouTube URL buttons at send time — index 0 = "Play it on Spotify",
  // index 1 = "Watch on Youtube", both confirmed matching this component
  // order.
  //
  // The template has a THIRD button, "Explore more & give feedback"
  // (Complete flow type) at index 2. In the WhatsApp Manager screenshot
  // Henry shared, that button's Flow is still unselected ("Select
  // one"/empty) — until Henry finishes configuring and publishing a Flow
  // for it there, tapping it likely won't do anything useful yet. That
  // part is still a WhatsApp Manager-side follow-up for Henry, not a code
  // fix. However, leaving its component out of the send entirely turned
  // out to be wrong regardless of whether the Flow itself is configured:
  // live DLR (Sept 2026, once the header fix below let this send actually
  // reach Vonage's template-shape validation) — error 1020, "Components
  // sub_type invalid at index: 2 and type: 0" — same "omitted component"
  // rule already learned from henry_musicselection's own Flow button (see
  // that fix's comment above) and from ticketingWhatsappFlow.js's
  // handleSurveyCompletion: Vonage rejects a components array that omits
  // a component the approved template actually has, whether or not that
  // component's own downstream behavior (the Flow it opens) is fully set
  // up. Added the same pre-defined-screen Flow button shape as the other
  // two Flow buttons in this codebase, fresh flow_token per send.
  //
  // Live DLR (Sept 2026, after the genre-picker Flow completion was fixed
  // and this send actually started firing): Vonage error 1022, "header:
  // Format mismatch, expected IMAGE, received UNKNOWN" — same root cause
  // and same fix as henry_musicselection above (see
  // musicLoversConfig.GENRE_PROMPT_HEADER_IMAGE_URL's comment): this
  // template's "Media sample: image header" component (noted at the top of
  // this file) was never actually included in the send. Reusing the same
  // Music Lovers hero image rather than a separate asset, consistent with
  // Henry's own earlier call on henry_musicselection's header. Per Henry's
  // follow-up request once the send finally worked end-to-end: the header
  // should show the matched *song's* own artwork rather than this generic
  // hero shot, once one's available (see the album-art lookup below).
  //
  // Per-track header image: looks up the matched track's own album art via
  // Spotify (getTrackAlbumArtUrl, same Client Credentials app token as the
  // ringtone preview lookup) so the header shows the actual song rather
  // than the generic Music Lovers hero shot. Best-effort — falls back to
  // the static hero image on any failure (network error, or a track id
  // Spotify doesn't recognize, e.g. an unfilled TRACK_CATALOG placeholder)
  // rather than blocking or breaking the send.
  let headerImageUrl = musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL;
  try {
    const albumArtUrl = await getTrackAlbumArtUrl(track.spotifyTrackId);
    if (albumArtUrl) headerImageUrl = albumArtUrl;
  } catch (err) {
    console.error('Music Lovers album-art lookup failed (using hero image instead):', err.message);
  }

  const payload = {
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'custom',
    custom: {
      type: 'template',
      template: {
        namespace: businessConfig.TEMPLATE_NAMESPACE,
        name: 'henry_musicsharing2',
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] },
          { type: 'body', parameters: [{ type: 'text', text: userName }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: track.spotifyTrackId }] },
          { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: track.youtubeVideoId }] },
          {
            type: 'button',
            sub_type: 'flow',
            index: 2,
            parameters: [{ type: 'action', action: { flow_token: randomUUID() } }],
          },
        ],
      },
    },
  };
  await sendVonageMessage(payload);
}

async function sendRingtone(phone, state) {
  const base = process.env.PUBLIC_BASE_URL || '';
  const ringtoneUrl = `${base}/music-lovers/ringtone/${encodeURIComponent(state.spotifyTrackId)}.ogg`;

  // Two separate messages, not one captioned audio message — WhatsApp
  // audio messages don't support a caption field (unlike image/video/
  // document), see demo-notes.md's "Ringtone follow-up feature" caveats.
  //
  // Previously the clip was built cold at the exact moment WhatsApp
  // fetched the audio URL below — Spotify lookup + preview download +
  // ffmpeg, ~2-4s — and media-fetch timeouts on WhatsApp's side are
  // unforgiving, so a slow build could mean the audio bubble never
  // appears at all. Prewarming it here, in parallel with the text
  // message, means it's very likely already cached by the time the
  // /music-lovers/ringtone/... URL actually gets fetched. Best-effort: if
  // this fails, the ringtone route falls back to building it cold as
  // before rather than blocking this function on ffmpeg succeeding.
  const prewarm = (async () => {
    try {
      if (!isRingtoneCached(state.spotifyTrackId)) {
        const previewUrl = await getTrackPreviewUrl(state.spotifyTrackId);
        if (previewUrl) await buildRingtoneClip(state.spotifyTrackId, previewUrl);
      }
    } catch (err) {
      console.error('Music Lovers ringtone prewarm failed (will build on fetch instead):', err.message);
    }
  })();

  await Promise.all([
    sendVonageMessage({
      from: musicConfig.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: musicConfig.RINGTONE_GIFT_TEXT,
    }),
    prewarm,
  ]);
  await sendVonageMessage({
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'audio',
    audio: { url: ringtoneUrl },
  });
}

// Fired from server.js's /api/spotify-callback right after a listener
// completes "Connect your Spotify" on music-lovers.html — skips the
// awaiting_genre stage entirely and goes straight to matching a track from
// their own top artists' genres, landing them in awaiting_confirmation the
// same as the manual-genre path. Falls back to the ordinary
// henry_musicselection prompt if anything about reading their Spotify data
// fails, rather than leaving the listener with no message at all.
async function handleSpotifyConnected(phone, userName) {
  try {
    const tokens = getSpotifyTokens(phone);
    if (!tokens) throw new Error('no stored Spotify tokens for this phone');
    const genreTags = await spotifyOAuth.getTopArtistGenres(tokens.accessToken);
    const genre = spotifyOAuth.matchGenreBucket(genreTags) || musicConfig.GENRES[0];
    const track = pickTrackForGenre(genre);
    await sendMatchedTrack(phone, userName, track);
    setMusicLoversState(phone, { stage: 'awaiting_confirmation', genre, ...track, viaSpotify: true });
    logEvent('outbound', `Matched ${redactPhone(phone)} to genre "${genre}" via Spotify connect`);
  } catch (err) {
    console.error('Music Lovers Spotify-connected handling error:', err.message);
    logEvent('outbound', `Spotify connect matching failed for ${redactPhone(phone)}, falling back to genre prompt`);
    await sendGenrePrompt(phone, userName);
    setMusicLoversState(phone, { stage: 'awaiting_genre' });
  }
}

// The "Select your favorite music genres" Flow's completion arrives the
// same way every other WhatsApp Flow completion does in this codebase (see
// ticketingWhatsappFlow.js's handleSurveyCompletion, whatsappFlow.js's
// isFlowCompletion) — confirmed live (Render logs, Sept 2026): Vonage
// normalizes it as { message_type: 'button', button: { sub_type: 'flow',
// payload: '<JSON string of the screen's field answers>' } }, not Meta's
// raw interactive.nfm_reply shape. Unlike the pre-defined Meta "Survey"
// screens elsewhere in this codebase, this is a custom-authored Flow
// screen, so the exact field key(s) Flow Builder assigned to the genre
// question aren't known ahead of time (and a multi-select answer can come
// back as an array) — rather than guess a key name, every string value
// across every answered field is searched for a genre match the same way
// a free-typed reply is (matchGenre), which is robust to both unknowns.
async function handleGenrePickerFlowCompletion(body) {
  const phone = body.from ?? '';
  const userName = getCallerName(phone) || body.profile?.name || 'there';

  const responseJson = body.button?.payload;
  let answers = {};
  try {
    answers = responseJson ? JSON.parse(responseJson) : {};
  } catch (err) {
    console.error('Failed to parse Music Lovers genre-picker Flow response:', err, responseJson);
  }
  logEvent('inbound', `Music Lovers genre-picker Flow response from ${redactPhone(phone)}: ${JSON.stringify(answers)}`);

  // flow_token is Vonage's own per-send correlation id, not an answer —
  // excluded so its random UUID text is never accidentally searched for a
  // genre substring match.
  const { flow_token, ...answerFields } = answers;
  const flatText = Object.values(answerFields)
    .flat(Infinity)
    .filter((v) => typeof v === 'string')
    .join(' ');
  const genre = matchGenre(flatText);

  if (!genre) {
    await sendVonageMessage({
      from: musicConfig.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: `Sorry, I didnt catch a genre there — reply with one of: ${musicConfig.GENRES.join(', ')}.`,
    });
    logEvent('outbound', `Genre-picker Flow response from ${redactPhone(phone)} didn't match a known genre`);
    return;
  }
  const track = pickTrackForGenre(genre);
  await sendMatchedTrack(phone, userName, track);
  setMusicLoversState(phone, { stage: 'awaiting_confirmation', genre, ...track });
  logEvent('outbound', `Matched ${redactPhone(phone)} to genre "${genre}" via genre-picker Flow`);
}

async function handleMusicLoversInbound(req, res) {
  res.status(200).json({ status: 'received' }); // ack immediately, matching whatsappFlow.js

  try {
    const body = req.body || {};
    if (isDuplicateMessage(body.message_uuid)) {
      console.log('Duplicate Music Lovers webhook delivery ignored, message_uuid:', body.message_uuid);
      return;
    }

    // Same Vonage wrapped shape as the other WhatsApp Flow completions in
    // this codebase — intercepted before Claude/matchGenre ever sees it,
    // same as ticketingWhatsappFlow.js's handleSurveyCompletion check.
    if (body.message_type === 'button' && body.button?.sub_type === 'flow') {
      await handleGenrePickerFlowCompletion(body);
      return;
    }

    const phone = body.from ?? '';
    const messageText = extractMessageText(body);

    const capturedName = captureNameFromGreeting(messageText);
    if (capturedName) setCallerName(phone, capturedName);
    const userName = getCallerName(phone) || body.profile?.name || 'there';

    console.log('Music Lovers inbound fields:', JSON.stringify({ phone: redactPhone(phone), messageText }));
    logEvent('inbound', `Music Lovers message from ${redactPhone(phone)}: "${messageText}"`);

    // A fresh QR/link-triggered greeting always restarts the journey, same
    // reasoning as whatsappFlow.js's isResetGreeting handling — a returning
    // tester scanning the link again should get a clean run, not whatever
    // stage they left off at last time.
    if (isResetGreetingFor(DEMOS.MUSIC_LOVERS, messageText)) {
      resetMusicLoversJourney(phone);
      logEvent('inbound', `Reset phrase detected — cleared Music Lovers state for ${redactPhone(phone)}`);
    }

    const state = getMusicLoversState(phone);

    if (!state.stage) {
      await sendGenrePrompt(phone, userName);
      setMusicLoversState(phone, { stage: 'awaiting_genre' });
      logEvent('outbound', `Sent genre prompt to ${redactPhone(phone)}`);
      return;
    }

    if (state.stage === 'awaiting_genre') {
      const genre = matchGenre(messageText);
      if (!genre) {
        await sendVonageMessage({
          from: musicConfig.FROM_WHATSAPP,
          to: phone,
          channel: 'whatsapp',
          message_type: 'text',
          text: `Sorry, I didnt catch a genre there — reply with one of: ${musicConfig.GENRES.join(', ')}.`,
        });
        return;
      }
      const track = pickTrackForGenre(genre);
      await sendMatchedTrack(phone, userName, track);
      setMusicLoversState(phone, { stage: 'awaiting_confirmation', genre, ...track });
      logEvent('outbound', `Matched ${redactPhone(phone)} to genre "${genre}"`);
      return;
    }

    if (state.stage === 'awaiting_confirmation') {
      if (!musicConfig.RINGTONE_CONFIRM_RE.test(messageText)) {
        return; // not the confirmation phrase — stay in this stage, nothing to send
      }
      await sendRingtone(phone, state);
      setMusicLoversState(phone, { stage: 'done' });
      logEvent('outbound', `Sent ringtone clip to ${redactPhone(phone)}`);
      return;
    }

    // stage === 'done' — nothing further automated yet. A real build might
    // loop back to offer another genre, or hand off to the feedback Flow.
  } catch (err) {
    console.error('Music Lovers inbound handling error:', err);
  }
}

module.exports = { handleMusicLoversInbound, matchGenre, handleSpotifyConnected };
