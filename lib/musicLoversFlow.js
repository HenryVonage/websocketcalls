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
const businessConfig = require('./businessConfig');
const musicConfig = require('./musicLoversConfig');
const spotifyOAuth = require('./spotifyOAuth');
const { getTrackPreviewUrl } = require('./spotifyApi');
const { buildRingtoneClip, isCached: isRingtoneCached } = require('./ringtoneBuilder');
const { sendVonageMessage } = require('./vonageApi');
const {
  getMusicLoversState,
  setMusicLoversState,
  resetMusicLoversJourney,
  getCallerName,
  setCallerName,
  getSpotifyTokens,
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
  // "Question 1 of 3"), not a quick-reply/list button. This code doesn't
  // parse a Flow's nfm_reply response yet (see handleMusicLoversInbound —
  // extractMessageText only reads body/button/list-reply text), so
  // tapping that button won't be understood by the flow below yet; typing
  // a genre by hand (matchGenre()) still works either way. Flagged to
  // Henry as a separate, larger follow-up rather than guessed at here.
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
  // (Complete flow type) at index 2. Flow buttons don't take a per-message
  // parameter unless using dynamic flow_action_data, which this doesn't
  // need — so no button component for index 2 is required here, and its
  // absence isn't what caused the original send failure. However, in the
  // WhatsApp Manager screenshot Henry shared, that button's Flow is still
  // unselected ("Select one"/empty) — until Henry finishes configuring and
  // publishing a Flow for it there, that button likely won't do anything
  // when tapped. That's a WhatsApp Manager-side follow-up for Henry, not a
  // code fix.
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
          { type: 'body', parameters: [{ type: 'text', text: userName }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: track.spotifyTrackId }] },
          { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: track.youtubeVideoId }] },
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
    const track = musicConfig.trackForGenre(genre);
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

async function handleMusicLoversInbound(req, res) {
  res.status(200).json({ status: 'received' }); // ack immediately, matching whatsappFlow.js

  try {
    const body = req.body || {};
    if (isDuplicateMessage(body.message_uuid)) {
      console.log('Duplicate Music Lovers webhook delivery ignored, message_uuid:', body.message_uuid);
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
      const track = musicConfig.trackForGenre(genre);
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
