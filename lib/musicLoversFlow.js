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
//                           henry_musicsharing3, move to awaiting_confirmation
//   awaiting_confirmation -> either a free-text "...stuck in my head..." (see
//                            musicConfig.RINGTONE_CONFIRM_RE) or a completion
//                            of henry_musicsharing3's 3rd button, the
//                            "Explore more & give feedback" Flow (see
//                            handleExploreMoreFlowCompletion) -> ringtone
//                            and/or link follow-ups as answered, move to done
//   done                 -> nothing further automated yet
//
// henry_musicsharing3 (Sept 2026): replaces the earlier henry_musicsharing2
// template — same params/buttons/components shape, Henry just made a small
// content edit in WhatsApp Manager and republished it under a new template
// name (Meta templates are versioned by name, not edited in place once
// approved). Nothing else in this file changed to support it.
//
// Negative-feedback loop (Sept 2026, Henry): layered on top of
// awaiting_confirmation rather than being its own stage — a listener who
// says the matched track is "nothing special"/"I hate it" (either as a
// free-typed reply or an explore-more Flow answer — see
// musicConfig.NEGATIVE_FEEDBACK_RE) gets a different song from a different
// artist instead (state.songsSent tracks how many, capped at 2 — see
// handleNegativeFeedback/sendAlternateSong below). Once that 2nd song has
// gone out, a fixed delay later (pushPretendConcertIfNoInterest) pushes a
// concert suggestion for its artist regardless of whether the listener
// actually asked for one — a fabricated ("pretend") one, not a real
// Ticketmaster lookup, since most of this demo's catalog is still
// placeholder data a real lookup would never match (see
// musicConfig.PRETEND_CONCERT_VENUES).
//
// RCS build (Sept 2026): the same journey now also runs over RCS — see
// lib/musicLoversRcsFlow.js. All the genre-matching/track-picking logic
// that used to live in this file (matchAllGenres, pickTrackForGenre,
// pickTrackForGenres, pickAlternateTrack, buildPretendConcertDetails, etc.)
// moved out to lib/musicLoversMatching.js so both channel files share
// exactly one copy of it rather than risking two copies drifting apart —
// this file now only builds and sends the WhatsApp-specific templates.
const { randomUUID } = require('crypto');
const businessConfig = require('./businessConfig');
const musicConfig = require('./musicLoversConfig');
const {
  matchAllGenres,
  matchGenre,
  pickTrackForGenre,
  pickTrackForGenres,
  buildPretendConcertDetails,
  pickAlternateTrack,
} = require('./musicLoversMatching');
const spotifyOAuth = require('./spotifyOAuth');
const { getTrackPreviewUrl, getTrackAlbumArtUrl } = require('./spotifyApi');
const { buildRingtoneClip, buildGeneratedRingtoneClip, isCached: isRingtoneCached } = require('./ringtoneBuilder');
const { resolveWikipediaUrl, resolveGeniusUrl, resolveConcertsUrl, resolveConcertDetails } = require('./linkResolvers');
const { searchVideoId } = require('./youtubeApi');
const { sendVonageMessage, createVonageCall } = require('./vonageApi');
const { buildAnswerNcco } = require('./nccoBuilder');
const {
  getMusicLoversState,
  setMusicLoversState,
  resetMusicLoversJourney,
  getCallerName,
  setCallerName,
  getSpotifyTokens,
  getMusicTicketDetails,
  setCallContext,
} = require('./store');
const { logEvent, redactPhone } = require('./activityLog');
const { captureNameFromGreeting } = require('./nameCapture');
const { DEMOS, isResetGreetingFor } = require('./demoRouter');
const { isDuplicateMessage } = require('./dedup');
// Lazy-required inside the functions that need it (see
// triggerOtherQuestionCall) rather than at module load time — voiceHandlers.js
// doesn't require this file back, so there's no real cycle, but requiring it
// up here would make one trivial to introduce by accident later without
// anything catching it.
function getBuildMusicLoversDynamicVariables() {
  return require('./voiceHandlers').buildMusicLoversDynamicVariables;
}

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

// Plain heads-up sent immediately before the matched-track template
// whenever pickTrackForGenres() had to substitute a genre the listener
// didn't pick (see that function's comments) — a listener who picked
// "Classical" and gets a Pop song back deserves to know why, rather than
// it looking like the demo just ignored their answer.
async function sendGenreSubstitutionNotice(phone, pickedGenres) {
  await sendVonageMessage({
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'text',
    text: `🎶 Nothing from Henry's current rotation for ${pickedGenres.join(
      ', '
    )} just yet — here's one of his other favourites instead!`,
  });
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
        name: 'henry_musicsharing3',
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

// "Concerts of this artist" in the explore-more Flow (Sept 2026, Henry's
// request) — sends the henry_ticketingconcert template (venue, date and
// the direct Ticketmaster event link as their own body variables, plus a
// "Call on WhatsApp" button) instead of the plain-text link this used to
// send. Reuses the same album-art lookup as sendMatchedTrack's header —
// "the relevant picture of the artist or the music of that artist
// previously picked", Henry's own words — rather than fetching a separate
// artist photo, so the header matches the song this listener already got.
// Same best-effort fallback as that lookup: any failure (network error, an
// unfilled TRACK_CATALOG placeholder id) falls back to the static Music
// Lovers hero image rather than blocking or breaking the send.
//
// The template's "Call on WhatsApp" button is static — it dials this
// business's own registered WhatsApp Calling number, not anything
// per-recipient — so it carries no variable and, unlike this codebase's
// Flow and URL buttons (see sendGenrePrompt/sendMatchedTrack's comments on
// the "omitted component" rule learned the hard way from those), needs no
// entry in the components array below. Worth confirming on the first live
// send, the same way each of those other button types needed a live DLR to
// actually confirm — if Vonage rejects this the same way it rejected the
// others, the fix will be adding a matching button component here too.
async function sendConcertsTemplate(phone, userName, artist, details, spotifyTrackId) {
  let headerImageUrl = musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL;
  try {
    const albumArtUrl = spotifyTrackId ? await getTrackAlbumArtUrl(spotifyTrackId) : null;
    if (albumArtUrl) headerImageUrl = albumArtUrl;
  } catch (err) {
    console.error('Music Lovers concerts-template album-art lookup failed (using hero image instead):', err.message);
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
        name: 'henry_ticketingconcert',
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: userName },
              { type: 'text', text: artist },
              { type: 'text', text: details.venue },
              { type: 'text', text: details.date },
              { type: 'text', text: details.url },
            ],
          },
        ],
      },
    },
  };
  await sendVonageMessage(payload);
}

// Sends the (fabricated) concert suggestion via the same henry_ticketingconcert
// template the real "concerts" explore-more answer uses (sendConcertsTemplate
// above) — a listener can't tell from the message itself that this one wasn't
// a real Ticketmaster match. Stashes concertArtist/concertDetails the same
// way the real path does, so a later "Call on WhatsApp" tap on this template
// still has dynamic variables to hand the voice agent (see
// sendConcertsTemplate's own comment on that).
async function pushPretendConcert(phone, userName, state) {
  const artist = state.artist || '';
  if (!artist) return;
  const details = buildPretendConcertDetails(artist);
  await sendConcertsTemplate(phone, userName, artist, details, state.spotifyTrackId);
  setMusicLoversState(phone, { concertArtist: artist, concertDetails: details });
  logEvent('outbound', `Pushed a pretend concert for ${artist} to ${redactPhone(phone)} (2-song negative-feedback cap reached, no concert interest shown)`);
}

// Fired from sendAlternateSong below once the 2nd (cap) song has gone out —
// Henry's Sept 2026 request: push a concert suggestion for that 2nd song's
// artist a few seconds later regardless of whether the listener actually
// asked for one via the explore-more Flow's "concerts" option, rather than
// waiting indefinitely for them to ask (which, per this demo's own established
// pattern — see handleOtherQuestionButtonTap's near-identical reasoning for
// its 9s call delay — might just never come). Re-reads state after the pause
// rather than trusting the state this was scheduled with, so a real concert
// request (or a fresh journey restart) that landed in the meantime is
// respected instead of overwritten.
async function pushPretendConcertIfNoInterest(phone, userName, artist) {
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const state = getMusicLoversState(phone);
  if (state.artist !== artist || state.concertDetails) return;
  await pushPretendConcert(phone, userName, state);
}

// Picks a candidate track for `genre` whose artist differs from
// `excludeArtist` — Henry's Sept 2026 "push another song suggestion from
// another artist" request, fired from sendAlternateSong below on negative
// feedback. Prefers another cached Top Track from the SAME genre (the
// listener already picked this genre, just not this particular song) —
// getTopTracksCatalogForGenre's `tracks` array can hold several candidates
// per genre (see server.js's /admin/music-lovers/refresh-top-tracks-catalog
// and spotifyOAuth.js's getTopTracksBucketedByGenre), of which
// pickTrackForGenre above only ever uses the first (tracks[0]). Falls back to
// any OTHER genre's own cached top pick (same substitution idea as
// pickTrackForGenres above) if this genre has no second artist cached.
// Returns null if nothing anywhere has a different artist (e.g. the Top
// Tracks catalog has never been refreshed and every genre is still its
// static TRACK_CATALOG placeholder, which would make excludeArtist itself
// "TBD" and every fallback the same "TBD"). See lib/musicLoversMatching.js
// for the implementation, shared with the RCS journey.
//
// Sends a different song from a different artist after negative feedback on
// the current one (Henry's Sept 2026 request) — the actual "push another
// song" step, called from handleNegativeFeedback below whenever the 2-song
// cap hasn't been reached yet. Resolves a YouTube video id on demand when the
// picked candidate doesn't already have one (only each genre's own tracks[0]
// gets looked up at catalog-refresh time — see pickAlternateTrack's comment),
// falling back to the static catalog's placeholder id if that lookup also
// comes up empty, same precedence pickTrackForGenre itself uses.
async function sendAlternateSong(phone, userName, state) {
  const alt = pickAlternateTrack(state.genre, state.artist);
  if (!alt) {
    logEvent('outbound', `Music Lovers: no alternate track available for ${redactPhone(phone)} — skipped negative-feedback resend`);
    return;
  }
  if (!alt.track.youtubeVideoId) {
    try {
      alt.track.youtubeVideoId = await searchVideoId(`${alt.track.artist} - ${alt.track.title}`);
    } catch (err) {
      console.error('Music Lovers alternate-track YouTube lookup failed:', err.message);
    }
    if (!alt.track.youtubeVideoId) {
      alt.track.youtubeVideoId = (musicConfig.trackForGenre(alt.genre) || {}).youtubeVideoId || null;
    }
  }

  await sendVonageMessage({
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
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
    // Clears any concert info left over from the PREVIOUS song/artist, so
    // pushPretendConcertIfNoInterest's "did they already ask for a concert"
    // check below correctly reflects this new artist, not the old one.
    concertArtist: undefined,
    concertDetails: undefined,
  });
  logEvent(
    'outbound',
    `Sent alternate track ("${alt.track.title}" by ${alt.track.artist}) to ${redactPhone(phone)} after negative feedback (song ${songsSent}/2)`
  );

  if (songsSent >= 2) {
    // Fire-and-forget — see pushPretendConcertIfNoInterest's own comment for
    // why this doesn't await (or need) a further reply to fire.
    pushPretendConcertIfNoInterest(phone, userName, alt.track.artist).catch((err) =>
      console.error('Music Lovers pretend-concert follow-up failed:', err.message)
    );
  }
}

// Entry point for both places negative feedback can arrive — a free-typed
// reply during awaiting_confirmation, and an explore-more Flow answer (see
// musicConfig.NEGATIVE_FEEDBACK_RE and this file's top-of-file comment on
// the negative-feedback loop). Below the 2-song cap, sends a different song;
// at the cap, does nothing further here — pushPretendConcertIfNoInterest
// (scheduled by sendAlternateSong when the 2nd song went out) already
// handles pushing the pretend concert, so a 3rd "I hate it" has nothing left
// to trigger.
async function handleNegativeFeedback(phone, userName, state) {
  const songsSent = state.songsSent || 1;
  if (songsSent >= 2) {
    logEvent('inbound', `Music Lovers: negative feedback from ${redactPhone(phone)} after the 2-song cap — no further resend`);
    return;
  }
  await sendAlternateSong(phone, userName, state);
}

async function sendRingtone(phone, state) {
  const base = process.env.PUBLIC_BASE_URL || '';
  // genre is passed through as a query param — the ringtone route only
  // gets the trackId from its URL path, and needs the genre to prompt the
  // ElevenLabs Music API fallback below when Spotify has no preview.
  const genreParam = state.genre ? `?genre=${encodeURIComponent(state.genre)}` : '';
  const ringtoneUrl = `${base}/music-lovers/ringtone/${encodeURIComponent(state.spotifyTrackId)}.ogg${genreParam}`;

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
  // before rather than blocking this function on ffmpeg succeeding. As of
  // Sept 2026, Spotify has no preview for most tracks (see demo-notes.md's
  // bug 13 — this route used to just 404 in that case, the gap this
  // fallback closes), so this now also prewarms the ElevenLabs-generated
  // fallback. That call can take up to ~30s, considerably slower than the
  // real-preview path — this is `await`ed before the audio message is
  // sent below specifically so a cold generation never has to race
  // WhatsApp's own (tighter) media-fetch timeout on the ringtone URL.
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
// completes "Connect your Spotify" on demo.html (Music Lovers family card) — skips the
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
  // "Choose all that apply" — a tester can (and does) tick more than one
  // box, so this collects every matched genre rather than just the first;
  // pickTrackForGenres() below still only ever sends the one track.
  const genres = matchAllGenres(flatText);

  if (genres.length === 0) {
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
  const { genre, track, substituted } = pickTrackForGenres(genres);
  if (substituted) {
    await sendGenreSubstitutionNotice(phone, genres);
  }
  await sendMatchedTrack(phone, userName, track);
  setMusicLoversState(phone, { stage: 'awaiting_confirmation', genre, ...track });
  logEvent(
    'outbound',
    `Matched ${redactPhone(phone)} to genre "${genre}" via genre-picker Flow${
      substituted ? ` (substituted — none of [${genres.join(', ')}] had a cached Top Track)` : ''
    }`
  );
}

// The "Explore more & give feedback" Flow, attached to henry_musicsharing3's
// 3rd button (Complete flow type) — completes from awaiting_confirmation,
// with the same wrapped shape as every other Flow completion in this
// codebase (see the routing comment in handleMusicLoversInbound above).
// Flow Builder's auto-generated field keys aren't predictable ahead of time
// and can shift if Henry edits the Flow's screens (same caveat as
// handleGenrePickerFlowCompletion above), so — same approach as that
// handler — every answer is matched by its own VALUE text rather than a
// guessed field key. The one thing this handler does differently, learned
// directly from the Sept 2026 bug that motivated it: each pattern is
// checked per-value and is specific/anchored to that one question, never a
// loose substring test against every field's text mashed into one blob —
// that looseness is exactly what made "Biography_of_this_artist" (which
// contains "rap") false-match the genre "Hip-Hop/Rap" when this Flow's
// completion was still being misrouted to the genre-picker handler. A
// tester can select several of these at once (e.g. "stuck in my head" +
// lyrics + bio + concerts), so every match sends its own follow-up rather
// than stopping at the first.
async function handleExploreMoreFlowCompletion(body, state) {
  const phone = body.from ?? '';
  // Needed for the henry_ticketingconcert template's {{1}} (recipient name)
  // — same fallback chain used everywhere else in this file (getCallerName
  // from the earlier part of the conversation, then WhatsApp's own profile
  // name, then a generic greeting).
  const userName = getCallerName(phone) || body.profile?.name || 'there';

  const responseJson = body.button?.payload;
  let answers = {};
  try {
    answers = responseJson ? JSON.parse(responseJson) : {};
  } catch (err) {
    console.error('Failed to parse Music Lovers explore-more Flow response:', err, responseJson);
  }
  logEvent('inbound', `Music Lovers explore-more Flow response from ${redactPhone(phone)}: ${JSON.stringify(answers)}`);

  const { flow_token, ...answerFields } = answers;
  const values = Object.values(answerFields)
    .flat(Infinity)
    .filter((v) => typeof v === 'string');
  // Flow Builder joins an option's label into its value with underscores
  // ("0_This_song_is_stuck_in_my_head!"), not spaces — normalized once here
  // so the same phrase/word patterns used for free-typed text (like
  // RINGTONE_CONFIRM_RE, which expects spaces) still match a Flow answer.
  const normalizedValues = values.map((v) => v.replace(/_/g, ' '));

  const likesStuckInHead = normalizedValues.some((v) => musicConfig.RINGTONE_CONFIRM_RE.test(v));
  // Anchored to the whole (trimmed) value, not a substring test — the
  // Flow's only yes/no question today is "Want to get the lyrics of it?",
  // whose Flow Builder-generated value looks like "0_YES".
  const wantsLyrics = values.some((v) => /(^|_)yes$/i.test(v.trim()));
  const wantsBio = normalizedValues.some((v) => /biography/i.test(v));
  const wantsConcerts = normalizedValues.some((v) => /concert/i.test(v));
  const wantsMoreSongs = normalizedValues.some((v) => /more songs from this artist|more songs/i.test(v));
  // Sept 2026, Henry's "push another song" request — see
  // musicConfig.NEGATIVE_FEEDBACK_RE and handleNegativeFeedback below.
  // Checked and acted on AFTER every other answer in this submission (see
  // the end of this function) — a tester can tick "I hate it" alongside
  // "concerts"/"biography" etc. in the same submission, and those should
  // still resolve for THIS song's artist before a new song replaces it.
  const dislikesSong = normalizedValues.some((v) => musicConfig.NEGATIVE_FEEDBACK_RE.test(v));

  if (likesStuckInHead && state.spotifyTrackId) {
    await sendRingtone(phone, state);
    logEvent('outbound', `Sent ringtone clip to ${redactPhone(phone)} (via explore-more Flow)`);
    // Sept 2026, Henry: "the ringtone generation takes a couple of seconds,
    // therefore I'm getting the other potential messages about the artist
    // concerts, or artist biography BEFORE the ringtone itself." sendRingtone
    // awaiting above only confirms Vonage *accepted* the audio send — Vonage
    // still has to fetch the clip from our own /music-lovers/ringtone/...
    // route and hand it off to WhatsApp before it actually reaches the
    // phone, and that fetch+handoff isn't covered by anything this code
    // awaits (there's no delivery-webhook wait here, just the initial
    // send-accepted response). The lyrics/bio/concerts messages below are
    // plain text/template sends with no media fetch of their own, so
    // without a pause they can — and did, live — win the race and land on
    // the phone before the audio bubble does. A fixed pause here can't
    // *guarantee* ordering (only a real delivery-receipt wait could do
    // that), but gives the audio message's fetch+handoff a real head start,
    // same tradeoff as the other post-media-send pauses already used
    // elsewhere in this codebase (e.g. voiceHandlers.js, whatsappFlow.js).
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const artist = state.artist || '';
  const title = state.title || '';
  // Ticketmaster's Discovery API is a keyword match against tour listings,
  // which are billed by headliner name — searching it with the full
  // "Primary Artist, Featured Artist" string reliably finds nothing,
  // silently falling back to the search link. Use just the first/primary
  // artist. Also used for Genius below (fine for Wikipedia's own search,
  // which isn't given the artist at all) — resolveGeniusUrl's relevance
  // check compares its hit's primary_artist name against whatever artist
  // string it's given, so a "Featured Artist" name Genius doesn't credit
  // the track to would otherwise risk failing that check for no reason.
  const primaryArtist = artist.split(',')[0].trim();

  // Plain (non-templated) free-session text messages — each just a link,
  // not the actual content. For lyrics specifically this is also required
  // by Claude's own standing policy against reproducing song lyrics in any
  // form, in addition to being what Henry asked for. Wikipedia and Genius
  // both resolve to the actual page via each service's own search API
  // (see linkResolvers.js) rather than sending a search-results URL for
  // the listener to click through themselves — falls back to a
  // search-results link if the lookup fails, so this never sends nothing.
  if (wantsLyrics && artist && title) {
    const url = await resolveGeniusUrl(primaryArtist, title);
    await sendVonageMessage({
      from: musicConfig.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: `🎤 Lyrics for "${title}" by ${artist}: ${url}`,
    });
    logEvent('outbound', `Sent lyrics link to ${redactPhone(phone)}`);
  }

  if (wantsBio && artist) {
    const url = await resolveWikipediaUrl(artist);
    await sendVonageMessage({
      from: musicConfig.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: `📖 More about ${artist}: ${url}`,
    });
    logEvent('outbound', `Sent artist bio link to ${redactPhone(phone)}`);
  }

  // Was Songkick, but their API stopped accepting new key applications
  // entirely (Sept 2026) — see linkResolvers.js header comment. Now
  // resolves via Ticketmaster's Discovery API instead.
  //
  // Sept 2026, Henry's request: send the approved henry_ticketingconcert
  // template (venue, date, and the direct event link as their own body
  // variables, plus a "Call on WhatsApp" button) instead of a plain-text
  // link — but only when resolveConcertDetails actually has a full event to
  // put in every one of the template's variables. Falls back to the old
  // plain-text link when it doesn't (no API key, no upcoming event, or a
  // lookup failure) — same as before this template existed, rather than
  // sending nothing.
  if (wantsConcerts && artist) {
    const details = await resolveConcertDetails(primaryArtist);
    if (details) {
      await sendConcertsTemplate(phone, userName, artist, details, state.spotifyTrackId);
      // Sept 2026, Henry's request: henry_ticketingconcert's "Call on
      // WhatsApp" button dials into an ElevenLabs voice persona that talks
      // about this specific show (see voiceHandlers.js's
      // buildMusicLoversDynamicVariables and realtimeBridge.js). WhatsApp
      // Calling carries no per-call custom data of its own, so there's
      // nothing to hand the call except whatever's already on file for
      // this phone number — stashed here so it's there whenever the
      // listener actually places the call, seconds or minutes later.
      setMusicLoversState(phone, { concertArtist: artist, concertDetails: details });
      logEvent('outbound', `Sent henry_ticketingconcert template to ${redactPhone(phone)}`);
    } else {
      const url = await resolveConcertsUrl(primaryArtist);
      await sendVonageMessage({
        from: musicConfig.FROM_WHATSAPP,
        to: phone,
        channel: 'whatsapp',
        message_type: 'text',
        text: `🎫 Upcoming concerts for ${artist}: ${url}`,
      });
      logEvent('outbound', `Sent concerts link to ${redactPhone(phone)} (no full event details available)`);
    }
  }

  if (wantsMoreSongs && artist) {
    const url = `https://open.spotify.com/search/${encodeURIComponent(artist)}`;
    await sendVonageMessage({
      from: musicConfig.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: `🎶 More songs from ${artist}: ${url}`,
    });
    logEvent('outbound', `Sent more-songs link to ${redactPhone(phone)}`);
  }

  setMusicLoversState(phone, { stage: 'done' });

  // Runs last, deliberately after the 'done' setState above — when this
  // sends a new song, it moves the stage back to awaiting_confirmation
  // itself (see sendAlternateSong), which needs to be the LAST write this
  // turn makes, not the 'done' one just above overwriting it back.
  if (dislikesSong) {
    await handleNegativeFeedback(phone, userName, state);
  }
}

// Sends the caller their (fake) ticket PDF when they tap "My tickets over
// WhatsApp" on henry_ticketing2 (see voiceHandlers.js's
// sendMusicLoversCallFollowUp, which generates and stashes the ticket).
// Free-form send is safe here — tapping a button is a user-initiated
// message, same as typing one, which opens/extends the 24h customer service
// window. Same file-message shape as ticketingWhatsappFlow.js's
// [T_SEND_TICKET] handling (message_type: 'file'), just pointed at this
// caller's own dynamically-generated ticket instead of one static PDF.
async function handleMyTicketsButtonTap(body) {
  const phone = body.from ?? '';
  const userName = getCallerName(phone) || body.profile?.name || 'there';
  const ticket = getMusicTicketDetails(phone);
  logEvent('inbound', `"My tickets" tapped by ${redactPhone(phone)}`);

  if (!ticket) {
    // Shouldn't normally happen — this button only ever goes out on
    // henry_ticketing2, which is only sent once a ticket has already been
    // generated (see sendMusicLoversCallFollowUp) — but a Render restart
    // between the two (in-memory store, no REDIS_URL configured) or a
    // stale/forwarded message could still hit this with nothing on file.
    await sendVonageMessage({
      from: musicConfig.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: `Hi ${userName}, I couldn't find a ticket on file for you right now — give us a call back and we'll get one sorted.`,
    });
    logEvent('outbound', `No ticket on file for ${redactPhone(phone)} — sent fallback text instead`);
    return;
  }

  const base = process.env.PUBLIC_BASE_URL || 'https://websocketcalls.onrender.com';
  await sendVonageMessage({
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'file',
    file: {
      url: `${base}/music-lovers/ticket/${ticket.ticketKey}.pdf`,
      caption: `Here's your ticket for ${ticket.artist}!`,
    },
  });
  logEvent('outbound', `Sent ticket PDF (order ${ticket.orderNumber}) to ${redactPhone(phone)}`);
}

// Places the actual outbound WhatsApp call, triggered a fixed 9s after the
// "OTHER QUESTION" tap by handleOtherQuestionButtonTap below. Same
// connect->websocket path every other call in this codebase uses
// (buildAnswerNcco/realtimeBridge.js) — context 'music_lovers_other_question'
// starts with 'music_lovers', so realtimeBridge.js's existing isMusicLovers
// check already routes it to ELEVENLABS_MUSIC_AGENT_ID with no further
// changes needed there.
//
// dynamic_variables carries the same artist/venue/date fields the inbound
// concert call gets (buildMusicLoversDynamicVariables, voiceHandlers.js)
// plus a new call_reason flag. That flag is only useful once Henry adds a
// small check for it to the Music agent's own system prompt/first message
// in the ElevenLabs dashboard (this agent is a native ElevenLabs
// Conversational AI persona, not Claude-driven) — without that dashboard
// change, the agent opens with whatever first line it's configured with
// today, which may read oddly for a caller who never asked about a concert.
async function triggerOtherQuestionCall(phone) {
  const context = 'music_lovers_other_question';
  const ncco = buildAnswerNcco({ context, callerPhone: phone });
  const dynamicVariables = {
    ...getBuildMusicLoversDynamicVariables()(phone),
    call_reason: 'other_question',
  };
  const result = await createVonageCall({ to: phone, from: musicConfig.FROM_WHATSAPP, ncco, type: 'whatsapp' });
  setCallContext(result.conversation_uuid, {
    context,
    phone,
    demo: DEMOS.MUSIC_LOVERS,
    callerName: getCallerName(phone),
    dynamicVariables,
  });
  logEvent('call', `Placed "other question" outbound call to ${redactPhone(phone)}`);
}

// "OTHER QUESTION" quick-reply on henry_ticketing2 (payload
// ML_OTHER_QUESTION — see voiceHandlers.js's sendMusicLoversCallFollowUp).
// Henry's Sept 2026 request: rather than leaving this tap unhandled, request
// WhatsApp-calling permission (henry_callpermission2, submitted to WhatsApp
// Manager) and place an outbound call a fixed 9s later, so the caller can
// ask their question live instead of typing it.
//
// There's deliberately no "wait for acceptance" step here — Vonage's own
// WhatsApp Calling ALPHA guide (Henry supplied it this session) confirms
// outright that no webhook fires when a user accepts or declines a
// call-permission request: "No notifications sent when users change their
// call permission settings." So this can't actually confirm the caller
// granted permission before calling — it just gives them a few seconds to
// see and act on the native WhatsApp prompt, then calls regardless.
//
// Updated Sept 2026, Henry: this previously waited for the caller's next
// message/tap in this chat instead of a fixed delay — but accepting the
// native "Can ... call you?" permission sheet is a client-side WhatsApp
// setting, not a chat message, so it never sent anything back here. Henry's
// own screen recording confirmed the call never fired because he never
// followed the accept with a separate message. A flat 9s pause avoids
// depending on that extra, non-obvious step.
async function handleOtherQuestionButtonTap(body) {
  const phone = body.from ?? '';
  const userName = getCallerName(phone) || body.profile?.name || 'there';
  logEvent('inbound', `"Other question" tapped by ${redactPhone(phone)}`);

  const perm = getMusicLoversState(phone).callPermission;
  const now = Date.now();

  // A request is already outstanding, or was already followed up on,
  // within the last 24h. Meta caps call-permission requests at 1/24h and
  // 2/7 days per user, so firing another template at it would likely just
  // get silently dropped — nudge the caller instead of re-sending, and
  // don't start a second 9s timer stacked on top of whichever one (if any)
  // is already in flight from the first tap.
  if (perm?.requestedAt && now - perm.requestedAt < 24 * 60 * 60 * 1000) {
    await sendVonageMessage({
      from: musicConfig.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: `Hi ${userName}, I already sent you a request to enable WhatsApp calling — go ahead and accept it, I'll give you a call shortly after.`,
    });
    logEvent('outbound', `Call-permission request already pending for ${redactPhone(phone)} — sent reminder instead of re-sending`);
    return;
  }

  await sendVonageMessage({
    from: musicConfig.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'custom',
    custom: {
      type: 'template',
      template: {
        namespace: businessConfig.TEMPLATE_NAMESPACE,
        name: musicConfig.CALL_PERMISSION_TEMPLATE_NAME,
        language: { policy: 'deterministic', code: 'en' },
        // ASSUMPTION, unverified against the actually-approved template:
        // one {{1}} body variable for the caller's name, matching every
        // other personalized template in this codebase. Meta's
        // call_permission_request component itself is body-text-only and
        // takes no parameters of its own (no header/footer/buttons — see
        // the template design discussion this session). If the approved
        // body has NO variable, drop the `parameters` array below —
        // Vonage will reject a param-count mismatch with a clear error in
        // the Render logs, so this is safe to try and correct from that
        // error on the first real send.
        components: [
          { type: 'body', parameters: [{ type: 'text', text: userName }] },
          { type: 'call_permission_request' },
        ],
      },
    },
  });
  setMusicLoversState(phone, { callPermission: { requestedAt: now, attempted: false } });
  logEvent('outbound', `Sent henry_callpermission2 call-permission request to ${redactPhone(phone)} — placing the call in 9s`);

  // Fire-and-forget from the route's point of view — handleMusicLoversInbound
  // already ack'd the webhook with res.status(200) before calling this
  // handler, so nothing is awaiting this function's return. Awaiting the
  // pause right here (rather than a bare setTimeout) keeps it on the same
  // try/catch-protected async path as the rest of the inbound handler, same
  // pattern as the other fixed pause in this file (see the ringtone-ordering
  // delay above).
  await new Promise((resolve) => setTimeout(resolve, 9000));

  // Guards against a double call if, e.g., a retried webhook delivery for
  // this same tap somehow got past isDuplicateMessage and re-entered this
  // function during the 9s wait.
  const stillPending = getMusicLoversState(phone).callPermission;
  if (stillPending?.attempted) return;
  setMusicLoversState(phone, { callPermission: { ...stillPending, attempted: true, attemptedAt: Date.now() } });
  await triggerOtherQuestionCall(phone);
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
    // same as ticketingWhatsappFlow.js's handleSurveyCompletion check. Two
    // different Flows share this exact shape (Vonage doesn't say which Flow
    // completed): henry_musicselection's genre picker, and
    // henry_musicsharing3's "Explore more & give feedback" Flow (its 3rd
    // button). They're told apart by the journey's own state.stage — the
    // same signal the free-text awaiting_confirmation branch below already
    // relies on — because the explore-more Flow is only ever sent (from
    // sendMatchedTrack) once a track has already been matched and the
    // journey is sitting in awaiting_confirmation. Fixed Sept 2026 after a
    // live bug: routing every Flow completion to the genre-picker handler
    // made its loose substring genre-matcher (matchGenre — "hip-hop/rap"
    // matches ANY text containing "rap") false-match on the explore-more
    // Flow's own answer text ("Biography_of_this_artist" contains "rap"),
    // sending a second, unwanted henry_musicsharing3 — see
    // handleExploreMoreFlowCompletion's comment for the full story.
    if (body.message_type === 'button' && body.button?.sub_type === 'flow') {
      const flowState = getMusicLoversState(body.from ?? '');
      if (flowState.stage === 'awaiting_confirmation') {
        await handleExploreMoreFlowCompletion(body, flowState);
      } else {
        await handleGenrePickerFlowCompletion(body);
      }
      return;
    }

    // "My tickets over WhatsApp" quick-reply on henry_ticketing2 (Sept
    // 2026, inbound-call ticketing feature — see voiceHandlers.js's
    // sendMusicLoversCallFollowUp, which sets this button's payload when
    // sending the template). Matched on body.button?.payload directly
    // rather than extractMessageText()/body.button?.text — same reasoning
    // as the Flow-completion routing bug fixed above: a button's own
    // approved display text can be edited later in WhatsApp Manager
    // (henry_musicsharing2 -> henry_musicsharing3 already happened once
    // this engagement) without this code changing, so matching the payload
    // string we chose ourselves is the only value guaranteed to stay
    // stable. henry_ticketing2's other quick-reply button ("OTHER
    // QUESTION", payload ML_OTHER_QUESTION) now requests calling permission
    // and places an outbound call a fixed 9s later — see
    // handleOtherQuestionButtonTap.
    if (body.message_type === 'button' && body.button?.payload === 'ML_MY_TICKETS') {
      await handleMyTicketsButtonTap(body);
      return;
    }
    if (body.message_type === 'button' && body.button?.payload === 'ML_OTHER_QUESTION') {
      await handleOtherQuestionButtonTap(body);
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
      // Free-typed replies can name more than one genre too ("pop and
      // rock please") — same multi-select handling as the Flow path above.
      const genres = matchAllGenres(messageText);
      if (genres.length === 0) {
        await sendVonageMessage({
          from: musicConfig.FROM_WHATSAPP,
          to: phone,
          channel: 'whatsapp',
          message_type: 'text',
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
        `Matched ${redactPhone(phone)} to genre "${genre}"${
          substituted ? ` (substituted — none of [${genres.join(', ')}] had a cached Top Track)` : ''
        }`
      );
      return;
    }

    if (state.stage === 'awaiting_confirmation') {
      // Sept 2026, Henry's "push another song" request — same free-text path
      // as the RINGTONE_CONFIRM_RE check just below (see
      // musicConfig.NEGATIVE_FEEDBACK_RE / handleNegativeFeedback).
      if (musicConfig.NEGATIVE_FEEDBACK_RE.test(messageText)) {
        await handleNegativeFeedback(phone, userName, state);
        return;
      }
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
