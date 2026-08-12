const anthropic = require('./anthropicClient');
const { getConversationDetails } = require('./elevenlabsApi');

const MAX_CHARS = 300;

// Turns an ElevenLabs conversation transcript into a short WhatsApp-friendly
// summary using Claude (kept consistent with the WhatsApp text assistant's
// voice, since both are "Vonage Estate" facing the same customer).
async function summarizeTranscript(transcript) {
  const lines = (transcript || [])
    .map((turn) => `${turn.role === 'agent' ? 'Assistant' : 'Caller'}: ${turn.message}`)
    .join('\n');

  if (!lines.trim()) {
    return "Thanks for calling Vonage Estate! We didn't catch much detail this time, but a member of our team will follow up shortly.";
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: `Summarize this Vonage Estate phone call transcript into a short, friendly WhatsApp message recap for the caller. Maximum ${MAX_CHARS} characters, including spaces. Write it directly to the caller (second person), warm and concise, no headers or bullet points, plain text only.`,
    messages: [{ role: 'user', content: lines }],
  });

  let summary = response.content?.[0]?.text?.trim() || '';
  if (summary.length > MAX_CHARS) {
    summary = summary.slice(0, MAX_CHARS - 1).trimEnd() + '…';
  }
  return summary;
}

// Retries with short delays — right after a call ends, ElevenLabs may not
// have finished processing/persisting the transcript yet. 8 attempts x 3s
// gives ~24s of buffer (up from the original 8s, which wasn't enough in
// testing even for a ~72s call with a full back-and-forth transcript).
async function fetchTranscriptWithRetry(conversationId, attempts = 8, delayMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const details = await getConversationDetails(conversationId);
      console.log(
        `getConversationDetails attempt ${i + 1}/${attempts} — status: ${details.status}, transcript entries: ${details.transcript?.length ?? 'missing field'}`
      );
      if (details.transcript && details.transcript.length > 0) {
        return details.transcript;
      }
    } catch (err) {
      console.error(`getConversationDetails attempt ${i + 1} failed:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function buildCallSummary(elevenConversationId) {
  const transcript = await fetchTranscriptWithRetry(elevenConversationId);
  if (!transcript) {
    console.error('No transcript available for', elevenConversationId, 'after retries — skipping summary.');
    return null;
  }
  return summarizeTranscript(transcript);
}

// Decides whether the caller expressed interest in booking an in-person
// viewing during the call, and if so pulls out the details needed to fill
// the henryappointment template (see voiceHandlers.js). Runs off the same
// transcript already fetched for the recap — no extra ElevenLabs call.
async function analyzeBookingIntent(transcript) {
  const lines = (transcript || [])
    .map((turn) => `${turn.role === 'agent' ? 'Assistant' : 'Caller'}: ${turn.message}`)
    .join('\n');

  if (!lines.trim()) return { wantsViewing: false };

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: `Read this Vonage Estate phone call transcript. Decide whether the caller wants to book an in-person property viewing. Respond with ONLY a JSON object, no other text, exactly matching this shape:
{"wantsViewing": boolean, "name": string, "propertyName": string, "appointmentTime": string}

- wantsViewing: true only if the caller clearly agreed to or asked for an in-person viewing/appointment.
- name: the caller's first name if mentioned in the conversation, otherwise "there".
- propertyName: the property discussed (e.g. "Regent's Park"), otherwise "Regent's Park".
- appointmentTime: the day/time agreed or proposed during the call, phrased naturally (e.g. "10am on Thursday"). If none was clearly agreed, use "a time our team will confirm with you".
Fill all fields with your best guess even if wantsViewing is false.`,
    messages: [{ role: 'user', content: lines }],
  });

  const raw = response.content?.[0]?.text?.trim() || '';
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : raw);
  } catch (err) {
    console.error('Failed to parse booking intent JSON:', raw, err.message);
    return { wantsViewing: false };
  }
}

module.exports = { buildCallSummary, fetchTranscriptWithRetry, summarizeTranscript, analyzeBookingIntent };
