const Anthropic = require('@anthropic-ai/sdk');

// Single shared client, used by whatsappFlow.js (conversation marker
// decisions) and callSummary.js (post-call WhatsApp summaries).
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = anthropic;
