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

// Holds the generated post-call recap text, keyed by Vonage conversation_uuid,
// so the /call-summary/:conversationUuid.pdf route (server.js) can render it
// into a PDF on demand when WhatsApp fetches the henry_callrecap template's
// document header. Same in-memory tradeoff as everything else here — a
// Render restart between call-end and WhatsApp's fetch would 404.
const callSummaries = new Map();

function setCallSummaryText(conversationUuid, text) {
  if (conversationUuid) callSummaries.set(conversationUuid, text);
}

function getCallSummaryText(conversationUuid) {
  return callSummaries.get(conversationUuid);
}

// First name captured from the demo landing page's pre-filled WhatsApp
// greeting (see frontend demo.html + whatsappFlow.js's DEMO_GREETING_RE),
// keyed by phone number. Used to personalize templates (henryappointment,
// henry_videorealestate, henry_callrecap, etc.) instead of falling back to
// WhatsApp's own profile display name or a generic "Client"/"there".
const callerNames = new Map();

function setCallerName(phone, name) {
  if (phone && name) callerNames.set(phone, name);
}

function getCallerName(phone) {
  return callerNames.get(phone);
}

// Answers to WhatsApp Flow messages (currently just henry_form2's "Survey"
// button — see voiceHandlers.js/whatsappFlow.js), captured from the inbound
// nfm_reply webhook. Kept as a flat log rather than one-per-phone, since the
// same number can complete a flow more than once over the demo's lifetime.
const flowResponses = [];

function saveFlowResponse(entry) {
  flowResponses.push(entry);
  return entry;
}

function getFlowResponses(phone) {
  return phone ? flowResponses.filter((r) => r.phone === phone) : flowResponses;
}

module.exports = {
  getConversation,
  pushTurn,
  setCallContext,
  getCallContext,
  setElevenConversationId,
  setCallSummaryText,
  getCallSummaryText,
  setCallerName,
  getCallerName,
  saveFlowResponse,
  getFlowResponses,
};
