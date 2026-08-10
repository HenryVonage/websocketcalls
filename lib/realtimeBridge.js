const WebSocket = require('ws');
const { getSignedUrl } = require('./elevenlabsApi');
const { setElevenConversationId } = require('./store');

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

function attachVoiceBridge(vonageWs) {
  let elevenWs = null;
  let started = false;

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

      try {
        const agentId = process.env.ELEVENLABS_AGENT_ID;
        const signedUrl = await getSignedUrl(agentId);
        elevenWs = new WebSocket(signedUrl);
      } catch (err) {
        console.error('Failed to start ElevenLabs conversation:', err);
        vonageWs.close();
        return;
      }

      elevenWs.on('open', () => {
        console.log('Connected to ElevenLabs agent.');
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
            const b64 = event.audio_event?.audio_base_64;
            if (b64 && vonageWs.readyState === WebSocket.OPEN) {
              vonageWs.send(Buffer.from(b64, 'base64'), { binary: true });
            }
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
    if (elevenWs) elevenWs.close();
  });

  vonageWs.on('error', (err) => console.error('Vonage websocket error:', err));
}

module.exports = { attachVoiceBridge };
