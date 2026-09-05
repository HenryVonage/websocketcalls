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
const { sendVonageMessage } = require('./vonageApi');
const { getMusicLoversState, setMusicLoversState, resetMusicLoversJourney, getCallerName, setCallerName } = require('./store');
const { logEvent, redactPhone } = require('./activityLog');
const { captureNameFromGreeting, isResetGreeting } = require('./nameCapture');
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

async function sendGenrePrompt(phone) {
  // TODO(Henry): fill in the real approved henry_musicselection component
  // structure once confirmed in WhatsApp Manager (list message vs.
  // quick-reply buttons — see demo-notes.md, this detail wasn't captured
  // when henry_musicsharing2's was). Sending body-only for now so the rest
  // of the journey (genre matching onward) is testable without it — a
  // listener can still reply with a genre by typing it.
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
        components: [],
      },
    },
  };
  await sendVonageMessage(payload);
}

async function sendMatchedTrack(phone, userName, track) {
  // Exact component shape confirmed from demo-notes.md's henry_musicsharing2
  // section — button index (not the template variable number) is what
  // disambiguates the Spotify vs. YouTube URL buttons at send time.
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
  await sendVonageMessage({
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'text',
    text: musicConfig.RINGTONE_GIFT_TEXT,
  });
  await sendVonageMessage({
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'audio',
    audio: { url: ringtoneUrl },
  });
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
    if (isResetGreeting(messageText)) {
      resetMusicLoversJourney(phone);
      logEvent('inbound', `Reset phrase detected — cleared Music Lovers state for ${redactPhone(phone)}`);
    }

    const state = getMusicLoversState(phone);

    if (!state.stage) {
      await sendGenrePrompt(phone);
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

module.exports = { handleMusicLoversInbound, matchGenre };
