const Anthropic = require('@anthropic-ai/sdk');

// Single shared client, used by whatsappFlow.js (conversation marker
// decisions) and callSummary.js (post-call WhatsApp summaries).
//
// timeout/maxRetries are explicit rather than left at the SDK's defaults
// (10 minutes, 2 retries) — during a live demo, a stalled Claude response
// should fail fast enough for the caller's own catch block to send a
// visible fallback message (see whatsappFlow.js/rcsFlow.js/
// ticketingFlow.js/ticketingWhatsappFlow.js) instead of leaving the
// prospect's phone silent for minutes.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 20000,
  maxRetries: 1,
});

module.exports = anthropic;
