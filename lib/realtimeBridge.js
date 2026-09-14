const WebSocket = require('ws');
const { getSignedUrl } = require('./elevenlabsApi');
const { setElevenConversationId, getCallContext, getMusicLoversState } = require('./store');
const { getTrackPreviewUrl } = require('./spotifyApi');
const { buildCallIntroClip } = require('./ringtoneBuilder');
const { logEvent, redactPhone } = require('./activityLog');

// Replaces the OpenAI-based bridge with ElevenLabs' Conversational AI agent
// (Vonage Estate Voice Assistant, running Claude Sonnet 4.6 as its LLM —
// see lib/whatsappFlow.js for the same brain used on the WhatsApp text
// side). This follows the same connector pattern Vonage's own Solutions
// Engineering team documents for ElevenLabs + Vonage:
// https://elevenlabs.io/docs/eleven-agents/phone-numbers/telephony/vonage
//
// Protocol notes:
//   - Vonage -> us: first message is a TEXT/JSON frame (audio format + the
//     `headers` set in the NCCO connect->websocket endpoint), then BINARY
//     frames of raw PCM16 audio, 20ms each.
//   - us -> ElevenLabs: audio in is sent as JSON: { user_audio_chunk: "<base64 PCM16>" }
//     (no "type" wrapper — this is ElevenLabs' own websocket event shape,
//     distinct from the NCCO/Vonage side).
//   - ElevenLabs -> us: JSON events. The ones this bridge cares about:
//       "conversation_initiation_metadata" — confirms the audio formats
//         the agent expects/produces (see note on sample rate below)
//       "audio" — { audio_event: { audio_base_64, event_id } } — speech
//         to play back to the caller
//       "ping" — must reply { type: "pong", event_id } promptly or the
//         connection is dropped
//       "user_transcript" / "agent_response" — useful for logging only
//
// Sample rate: ElevenLabs' own reference Vonage connector uses
// `audio/l16;rate=16000` end to end (see nccoBuilder.js) rather than the
// 24kHz used in the earlier OpenAI-based version. Going with 16kHz here
// since it's what ElevenLabs' documented Vonage integration is actually
// built and tested against — if you've separately confirmed the agent's
// ASR handles 24kHz cleanly, this can be changed via the AUDIO_SAMPLE_RATE
// env var (must match nccoBuilder.js).

// Hard cap on call length. A real conversation is expected to wrap up
// within ~4 minutes; this closes both legs of the bridge 1 minute past
// that as a safety net against a call (accidentally or deliberately)
// being kept open indefinitely. Closing the Vonage websocket ends the
// call since `connect` is the only NCCO action (see nccoBuilder.js) —
// there's nothing left for Vonage to fall through to once this leg
// disconnects.
const MAX_CALL_DURATION_MS = 5 * 60 * 1000;

// Sept 2026, Henry: "the first 4 seconds of the WhatsApp calling are
// breaking a bit while the rest of the call is with a much better call
// quality." Root cause: ElevenLabs -> Vonage audio used to be relayed the
// instant each 'audio' event arrived, with no pacing. The NCCO
// (nccoBuilder.js) declares raw `audio/l16;rate=...` PCM over the
// websocket — Vonage plays that out live, the same way it streams the
// inbound (caller -> us) leg to us in steady 20ms frames — so it expects
// roughly real-time delivery, not a burst. ElevenLabs' TTS generates
// faster than real-time, and that's most pronounced right at call start:
// the agent's whole configured opening line gets synthesized and streamed
// back within a very short window, before any natural conversational gap
// exists to absorb it. Forwarding that burst straight through produced
// exactly the "choppy for the first few seconds, fine after" symptom —
// once the opening line drained and turns became shorter/more naturally
// spaced, delivery was already close enough to real-time to sound clean.
//
// Fix: queue incoming audio bytes and drip-feed them to Vonage one 20ms
// frame at a time via a self-correcting timer (recursive setTimeout
// tracking a target `nextTickAt` rather than plain setInterval, so small
// per-tick scheduling delays don't accumulate into drift over a multi-
// minute call). AUDIO_SAMPLE_RATE must match nccoBuilder.js's own env var
// of the same name — both must agree on the PCM format actually being
// sent, same contract nccoBuilder.js's own comment already calls out.
const AUDIO_SAMPLE_RATE = parseInt(process.env.AUDIO_SAMPLE_RATE || '16000', 10);
const BYTES_PER_SAMPLE = 2; // 16-bit PCM (audio/l16), mono
const FRAME_INTERVAL_MS = 20;
const FRAME_BYTES = Math.round(AUDIO_SAMPLE_RATE * BYTES_PER_SAMPLE * (FRAME_INTERVAL_MS / 1000));
const BYTES_PER_MS = (AUDIO_SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

// Sept 2026, Henry: play ~2s of the matched song solo right as a Music
// Lovers call connects, then duck it under the agent's opening for ~3s
// more, before the agent carries on solo. The 2s solo window doubles as
// cover for the ElevenLabs connect/first-response latency that's there
// anyway (see the pacing comment above), rather than adding a new delay.
//
// MUSIC_LOVERS_CALL_INTRO_ENABLED: the easy "unroll" Henry asked for — set
// this env var to 'false' in Render (no code change/redeploy-via-git
// needed) to turn the whole feature off and go back to today's behavior.
const MUSIC_INTRO_ENABLED = process.env.MUSIC_LOVERS_CALL_INTRO_ENABLED !== 'false';
const INTRO_SOLO_MS = 2000;
const INTRO_BACKGROUND_MS = 3000;
// How long to hold the agent's own audio back waiting for the clip to
// resolve (Spotify/ElevenLabs lookup + ffmpeg — see ringtoneBuilder.js's
// buildCallIntroClip) before giving up on the intro for this call rather
// than visibly delaying the agent's greeting. Generous relative to the
// solo window since the common case (a track already prewarmed by the
// ringtone feature earlier in the same journey) resolves near-instantly —
// this only matters for a cold cache.
const MAX_INTRO_WAIT_MS = 2500;
// Linear gain applied to the clip while it's mixed under the agent's own
// (full-volume) audio — roughly -15dB, low enough to read as "background"
// rather than competing with the voice.
const INTRO_BACKGROUND_GAIN = 0.18;

// Sums two equal-length PCM16LE mono buffers sample-by-sample, `clip`
// scaled by `clipGain` first, clamped to avoid wraparound clipping. Used
// only for the intro's ~3s background-mix window — full-volume agent
// audio plus a quiet clip underneath, same idea as a radio host talking
// over a song bed.
function mixPcm16(agent, clip, clipGain) {
  const out = Buffer.alloc(agent.length);
  for (let i = 0; i + 1 < agent.length; i += 2) {
    const a = agent.readInt16LE(i);
    const c = clip.readInt16LE(i);
    let mixed = Math.round(a + c * clipGain);
    if (mixed > 32767) mixed = 32767;
    else if (mixed < -32768) mixed = -32768;
    out.writeInt16LE(mixed, i);
  }
  return out;
}

function attachVoiceBridge(vonageWs) {
  let elevenWs = null;
  let started = false;
  let maxDurationTimer = null;
  let pacingTimer = null;
  // Bytes received from ElevenLabs but not yet paced out to Vonage — see
  // the pacing comment above MAX_CALL_DURATION_MS. Cleared on an
  // 'interruption' event (the caller barging in on the agent) so queued-
  // but-unsent audio doesn't keep the agent "talking" after the caller's
  // already started speaking; naturally bounded in the ordinary case by
  // MAX_CALL_DURATION_MS (at most a few minutes of audio for one call).
  let audioQueue = Buffer.alloc(0);

  // Music Lovers call-intro state (see MUSIC_INTRO_ENABLED above).
  // introPhase: 'none' (not applicable to this call) -> 'pending' (waiting
  // on the clip to resolve, holding any agent audio that arrives meanwhile
  // in pendingAgentAudio) -> 'mixing' (clip resolved: solo portion already
  // queued, background portion being mixed under agent audio as it arrives)
  // -> 'done' (background exhausted, or bailed out — plain passthrough
  // from here). Modeled as an explicit phase rather than a couple of
  // booleans since 'audio'/'interruption' events need to branch on it from
  // more than one place below.
  let introPhase = 'none';
  let pendingAgentAudio = Buffer.alloc(0);
  let introBackgroundRemaining = null;
  let introHoldTimer = null;

  // Looks up the caller's matched track (musicLoversFlow.js's state, set
  // once a genre match sends henry_musicsharing3) and builds the same kind
  // of clip the ringtone feature does — real Spotify preview when
  // available, else the ElevenLabs genre-matched fallback (mirrors
  // musicLoversFlow.js's sendRingtone decision exactly). Returns null
  // (never throws) whenever there's nothing to play: no matched track yet,
  // no preview URL and no genre to fall back on, or a generation failure —
  // the caller (beginIntroPlayback) treats that as "no intro this call".
  async function resolveIntroClip(phone) {
    const state = getMusicLoversState(phone) || {};
    if (!state.spotifyTrackId) return null;
    let previewUrl = null;
    try {
      previewUrl = await getTrackPreviewUrl(state.spotifyTrackId);
    } catch (err) {
      console.error('Music call-intro: preview URL lookup failed (falling back to generated clip):', err.message);
    }
    return buildCallIntroClip(state.spotifyTrackId, previewUrl, state.genre, AUDIO_SAMPLE_RATE);
  }

  // Whatever agent audio piled up in pendingAgentAudio while introPhase was
  // 'pending' gets sent through untouched — used when there's no clip to
  // mix it against (resolution failed, timed out, or an interruption fired
  // first), so the agent's own greeting is never lost or delayed beyond
  // MAX_INTRO_WAIT_MS.
  function flushPendingAgentAudioUnmixed() {
    introPhase = 'done';
    if (introHoldTimer) { clearTimeout(introHoldTimer); introHoldTimer = null; }
    if (pendingAgentAudio.length) {
      audioQueue = Buffer.concat([audioQueue, pendingAgentAudio]);
      pendingAgentAudio = Buffer.alloc(0);
    }
  }

  // Mixes one chunk of agent audio against whatever's left of the
  // background portion (introBackgroundRemaining), or passes it straight
  // through once that's exhausted. Called both for the backlog that piled
  // up in pendingAgentAudio while we waited on the clip, and for every live
  // 'audio' event afterwards until the background window runs out.
  function appendMixedOrPassthrough(agentBytes) {
    if (introPhase !== 'mixing' || !introBackgroundRemaining || introBackgroundRemaining.length === 0) {
      audioQueue = Buffer.concat([audioQueue, agentBytes]);
      if (introPhase === 'mixing') { introPhase = 'done'; introBackgroundRemaining = null; }
      return;
    }
    // & ~1 keeps the mix boundary on a 16-bit sample edge — mixPcm16 reads
    // 2 bytes at a time and an odd-length slice would silently drop its
    // last dangling byte otherwise.
    const mixLen = Math.min(agentBytes.length, introBackgroundRemaining.length) & ~1;
    const mixed = mixPcm16(agentBytes.subarray(0, mixLen), introBackgroundRemaining.subarray(0, mixLen), INTRO_BACKGROUND_GAIN);
    audioQueue = Buffer.concat([audioQueue, mixed]);
    introBackgroundRemaining = introBackgroundRemaining.subarray(mixLen);
    if (mixLen < agentBytes.length) {
      // Background ran out mid-chunk — the rest of this chunk plays solo.
      audioQueue = Buffer.concat([audioQueue, agentBytes.subarray(mixLen)]);
    }
    if (introBackgroundRemaining.length === 0) {
      introPhase = 'done';
      introBackgroundRemaining = null;
    }
  }

  // Fires once resolveIntroClip settles. Slices the clip into its solo and
  // background portions, queues the solo portion immediately (audioQueue
  // should still be empty at this point in the ordinary case — the call
  // just connected), then mixes in whatever agent audio already arrived
  // while we were waiting, and switches to live per-chunk mixing for
  // whatever's still to come.
  function beginIntroPlayback(clip) {
    if (introPhase !== 'pending') return; // already bailed (timeout / interruption / vonageWs closed)
    if (introHoldTimer) { clearTimeout(introHoldTimer); introHoldTimer = null; }
    if (!clip) {
      flushPendingAgentAudioUnmixed();
      return;
    }
    const soloBytes = Math.min(INTRO_SOLO_MS * BYTES_PER_MS, clip.length) & ~1;
    audioQueue = Buffer.concat([audioQueue, clip.subarray(0, soloBytes)]);
    introBackgroundRemaining = clip.subarray(soloBytes);
    introPhase = 'mixing';
    if (pendingAgentAudio.length) {
      const backlog = pendingAgentAudio;
      pendingAgentAudio = Buffer.alloc(0);
      appendMixedOrPassthrough(backlog);
    }
  }

  // Drip-feeds audioQueue to Vonage one FRAME_BYTES chunk every
  // FRAME_INTERVAL_MS, so a burst of ElevenLabs audio (typical right at
  // call start — see comment above) gets smoothed into real-time playback
  // instead of hitting Vonage's socket all at once. A tick with less than
  // a full frame queued is a no-op (waits for more data) rather than
  // sending a short frame, which would shift the pacing grid.
  function startAudioPacing() {
    let nextTickAt = Date.now();
    const tick = () => {
      nextTickAt += FRAME_INTERVAL_MS;
      if (audioQueue.length >= FRAME_BYTES && vonageWs.readyState === WebSocket.OPEN) {
        vonageWs.send(audioQueue.subarray(0, FRAME_BYTES), { binary: true });
        audioQueue = audioQueue.subarray(FRAME_BYTES);
      }
      pacingTimer = setTimeout(tick, Math.max(0, nextTickAt - Date.now()));
    };
    tick();
  }

  vonageWs.on('message', async (data, isBinary) => {
    if (!isBinary) {
      // First message: Vonage's JSON metadata (audio format + our NCCO
      // headers: context, callerPhone, callUuid).
      let meta = {};
      try { meta = JSON.parse(data.toString()); } catch (e) {
        console.error('Failed to parse Vonage websocket metadata:', e);
      }

      if (started) return;
      started = true;

      const conversationUuid = meta.conversationUuid;
      console.log('Voice call connected. Context:', meta.context, 'caller:', meta.callerPhone, 'conversation_uuid:', conversationUuid);

  maxDurationTimer = setTimeout(() => {
    console.log('Voice call reached max duration cap — ending call. conversation_uuid:', conversationUuid);
    logEvent('call', `Call with ${redactPhone(meta.callerPhone)} ended: reached ${MAX_CALL_DURATION_MS / 60000}-minute max duration`);
    if (elevenWs) elevenWs.close();
    if (vonageWs.readyState === WebSocket.OPEN) vonageWs.close();
  }, MAX_CALL_DURATION_MS);

  startAudioPacing();

      // Looked up once here (not re-derived from meta) since only
      // conversationUuid travels over the NCCO/Vonage websocket headers —
      // the richer per-call payload (Music Lovers' dynamic_variables) lives
      // in store.js's callContext, set by voiceHandlers.js's handleAnswer
      // at the same conversationUuid key handleEvents() later reads by.
      const callCtx = getCallContext(conversationUuid);

      // meta.context (set in nccoBuilder.js's NCCO headers, from
      // voiceHandlers.js's per-caller demo lookup) tells us which
      // ElevenLabs persona to use below, and also gates the call-intro
      // feature — computed here, before the try block, so both can use it.
      const isTicketing = String(meta.context || '').startsWith('ticketing');
      const isMusicLovers = String(meta.context || '').startsWith('music_lovers');

      // Kicked off in parallel with the ElevenLabs connect below (not
      // awaited here) so resolving the clip never adds latency of its own
      // to call setup — see resolveIntroClip/beginIntroPlayback's own
      // comments for exactly how the result gets used once it's ready.
      if (MUSIC_INTRO_ENABLED && isMusicLovers) {
        introPhase = 'pending';
        resolveIntroClip(meta.callerPhone)
          .catch((err) => {
            console.error('Music call-intro clip failed (continuing without it):', err.message);
            return null;
          })
          .then(beginIntroPlayback);
        introHoldTimer = setTimeout(() => {
          if (introPhase === 'pending') {
            console.log('Music call-intro clip not ready within', MAX_INTRO_WAIT_MS, 'ms — skipping it for this call.');
            flushPendingAgentAudioUnmixed();
          }
        }, MAX_INTRO_WAIT_MS);
      }

      try {
        // The "Contact us" voice escalation from the Ticketing demo, and
        // now Music Lovers' henry_ticketingconcert "Call on WhatsApp"
        // button, both land here too (same Vonage Application, same /voice
        // websocket) — see the isTicketing/isMusicLovers computed above.
        // Falls back to the shared Real Estate agent if a dedicated agent
        // hasn't been created yet in ElevenLabs / configured via
        // ELEVENLABS_TICKETING_AGENT_ID / ELEVENLABS_MUSIC_AGENT_ID.
        if (isTicketing && !process.env.ELEVENLABS_TICKETING_AGENT_ID) {
          console.warn('ELEVENLABS_TICKETING_AGENT_ID not set — using the Real Estate ElevenLabs agent for this ticketing call.');
        }
        if (isMusicLovers && !process.env.ELEVENLABS_MUSIC_AGENT_ID) {
          console.warn('ELEVENLABS_MUSIC_AGENT_ID not set — using the Real Estate ElevenLabs agent for this Music Lovers call.');
        }
        const agentId =
          (isTicketing && process.env.ELEVENLABS_TICKETING_AGENT_ID) ||
          (isMusicLovers && process.env.ELEVENLABS_MUSIC_AGENT_ID) ||
          process.env.ELEVENLABS_AGENT_ID;
        const signedUrl = await getSignedUrl(agentId);
        elevenWs = new WebSocket(signedUrl);
      } catch (err) {
        console.error('Failed to start ElevenLabs conversation:', err);
        vonageWs.close();
        return;
      }

      elevenWs.on('open', () => {
        console.log('Connected to ElevenLabs agent.');
        // Must be the very first client->server message on this
        // connection, before any audio — ElevenLabs' own
        // conversation_initiation_client_data event, which is how a caller-
        // specific system-prompt {{variable}} (the concert's artist, venue,
        // date, ticket link — see voiceHandlers.js's
        // buildMusicLoversDynamicVariables) reaches the agent. Only sent
        // when there's actually something to pass in (Music Lovers, today)
        // — every other demo's agent keeps using whatever static
        // prompt/first-message it's configured with in the ElevenLabs
        // dashboard, completely unaffected by this.
        if (callCtx?.dynamicVariables) {
          elevenWs.send(
            JSON.stringify({
              type: 'conversation_initiation_client_data',
              dynamic_variables: callCtx.dynamicVariables,
            })
          );
        }
      });

      elevenWs.on('message', (raw) => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { return; }

        switch (event.type) {
          case 'conversation_initiation_metadata': {
            const initMeta = event.conversation_initiation_metadata_event;
            console.log('ElevenLabs audio formats — agent output:', initMeta?.agent_output_audio_format, 'user input:', initMeta?.user_input_audio_format, 'conversation_id:', initMeta?.conversation_id);
            // Store this against the Vonage call so /events can fetch the
            // transcript and build the post-call WhatsApp summary once the
            // call ends. Only works when conversationUuid was passed in the
            // NCCO headers — see nccoBuilder.js. Outbound calls (feedback
            // calls) don't have this available at NCCO-build time, so the
            // summary feature currently only covers inbound calls.
            if (initMeta?.conversation_id && conversationUuid) {
              setElevenConversationId(conversationUuid, initMeta.conversation_id);
            }
            break;
          }
          case 'audio': {
            // Queued rather than sent immediately — startAudioPacing()
            // drains this at real-time (one 20ms frame per tick). See the
            // pacing comment above MAX_CALL_DURATION_MS for why. While a
            // Music Lovers call-intro is in play, this also routes through
            // the hold/mix logic above instead of queuing straight through.
            const b64 = event.audio_event?.audio_base_64;
            if (b64) {
              const agentBytes = Buffer.from(b64, 'base64');
              if (introPhase === 'pending') {
                pendingAgentAudio = Buffer.concat([pendingAgentAudio, agentBytes]);
              } else if (introPhase === 'mixing') {
                appendMixedOrPassthrough(agentBytes);
              } else {
                audioQueue = Buffer.concat([audioQueue, agentBytes]);
              }
            }
            break;
          }
          case 'interruption': {
            // Caller started talking over the agent — drop whatever's
            // still queued but not yet sent, so the agent actually goes
            // quiet promptly on our side instead of finishing out a few
            // more seconds of already-buffered speech. Also abandons any
            // in-progress call-intro (held audio and remaining background
            // clip both dropped) rather than trying to resume a duck-under
            // mix after a barge-in — nothing meaningful left to duck it
            // under at that point.
            audioQueue = Buffer.alloc(0);
            pendingAgentAudio = Buffer.alloc(0);
            introBackgroundRemaining = null;
            if (introHoldTimer) { clearTimeout(introHoldTimer); introHoldTimer = null; }
            if (introPhase !== 'none') introPhase = 'done';
            break;
          }
          case 'ping': {
            const eventId = event.ping_event?.event_id;
            elevenWs.send(JSON.stringify({ type: 'pong', event_id: eventId }));
            break;
          }
          case 'user_transcript':
            console.log('Caller said:', event.user_transcription_event?.user_transcript);
            break;
          case 'agent_response':
            console.log('Agent said:', event.agent_response_event?.agent_response);
            break;
          default:
            break;
        }
      });

      elevenWs.on('error', (err) => console.error('ElevenLabs websocket error:', err));
      elevenWs.on('close', () => {
        if (vonageWs.readyState === WebSocket.OPEN) vonageWs.close();
      });

      return;
    }

    // Binary frame: 20ms of raw PCM16 audio from the caller.
    if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(JSON.stringify({ user_audio_chunk: data.toString('base64') }));
    }
  });

  vonageWs.on('close', () => {
    console.log('Voice call ended, closing ElevenLabs session.');
  if (maxDurationTimer) clearTimeout(maxDurationTimer);
    if (pacingTimer) clearTimeout(pacingTimer);
    if (introHoldTimer) clearTimeout(introHoldTimer);
    if (elevenWs) elevenWs.close();
  });

  vonageWs.on('error', (err) => console.error('Vonage websocket error:', err));
}

module.exports = { attachVoiceBridge };
