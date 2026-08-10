// Process-memory only. Render's free tier restarts/sleeps the service on
// inactivity, so this state does not survive a restart. That's an accepted
// tradeoff (per your "simpler alternative, no external DB" choice) — fine
// for per-call/per-conversation context, not meant for durable history.

// WhatsApp text conversation memory, keyed by phone number.
// Mirrors n8n's memoryBufferWindow (contextWindowLength: 10).
const conversations = new Map();

function getConversation(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function pushTurn(phone, role, content) {
  const history = getConversation(phone);
  history.push({ role, content });
  while (history.length > 10) history.shift();
}

// Correlates a Vonage conversation_uuid to voice-call context (why the call
// was placed, and which phone number it's with) so the /events webhook can
// decide what to do when the call completes.
const callContext = new Map();

function setCallContext(conversationUuid, context) {
  if (conversationUuid) callContext.set(conversationUuid, context);
}

function getCallContext(conversationUuid) {
  return callContext.get(conversationUuid);
}

// Attaches the ElevenLabs conversation_id to an existing Vonage call context
// entry once the realtime bridge learns it (from ElevenLabs'
// conversation_initiation_metadata event). Used later by the /events
// webhook to fetch the transcript and build the post-call WhatsApp summary.
function setElevenConversationId(conversationUuid, elevenConversationId) {
  const existing = callContext.get(conversationUuid);
  if (existing) {
    existing.elevenConversationId = elevenConversationId;
  } else {
    callContext.set(conversationUuid, { elevenConversationId });
  }
}

module.exports = {
  getConversation,
  pushTurn,
  setCallContext,
  getCallContext,
  setElevenConversationId,
};
