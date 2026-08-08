// Shared builder for the connect->websocket NCCO. Every call (inbound
// property inquiry, outbound feedback call, outbound post-call follow-up)
// goes through this same shape, differing only in the `context` header —
// the realtime bridge (lib/realtimeBridge.js) reads that header to decide
// which system prompt/persona to use for the conversation.
//
// content-type: using 16kHz here, matching ElevenLabs' own documented
// Vonage reference integration exactly (not the 24kHz used in the earlier
// OpenAI-based bridge). Vonage Engineering confirmed 24kHz works at the
// raw NCCO/websocket layer, but that wasn't validated against ElevenLabs'
// specific ASR pipeline, so 16kHz is the safer default for this path.
// Override via AUDIO_SAMPLE_RATE if you've tested 24kHz end-to-end with
// ElevenLabs and confirmed it works.
function buildAnswerNcco({ context, callerPhone, callUuid }) {
  const base = process.env.PUBLIC_BASE_URL || 'https://websocketcalls.onrender.com';
  const wssBase = process.env.PUBLIC_WSS_BASE || 'wss://websocketcalls.onrender.com';
  const sampleRate = process.env.AUDIO_SAMPLE_RATE || '16000';

  return [
    {
      action: 'connect',
      eventType: 'synchronous',
      eventUrl: [`${base}/events`],
      endpoint: [
        {
          type: 'websocket',
          uri: `${wssBase}/voice`,
          'content-type': `audio/l16;rate=${sampleRate}`,
          headers: {
            context: context || 'inbound_inquiry',
            callerPhone: callerPhone || '',
            callUuid: callUuid || '',
          },
        },
      ],
    },
  ];
}

module.exports = { buildAnswerNcco };
