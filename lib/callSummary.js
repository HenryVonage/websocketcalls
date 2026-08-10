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

module.exports = { buildCallSummary };
