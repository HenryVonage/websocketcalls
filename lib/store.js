// Process-memory only. Render's free tier restarts/sleeps the service on
// inactivity, so this state does not survive a restart. That's an accepted
// tradeoff (per your "simpler alternative, no external DB" choice) — fine
// for per-call/per-conversation context, not meant for durable history.

// Text conversation memory, keyed by "demo:phone" (demo defaults to
// 'real-estate' so every pre-existing call site — whatsappFlow.js,
// rcsFlow.js's real-estate branch, conversationEngine.js — keeps working
// unchanged). Namespacing by demo means a tester phone number that's been
// through both the Real Estate and Ticketing demos gets two independent
// histories instead of one conversation bleeding into the other.
// Mirrors n8n's memoryBufferWindow (contextWindowLength: 10).
const conversations = new Map();

function conversationKey(phone, demo) {
  return `${demo || 'real-estate'}:${phone}`;
}

function getConversation(phone, demo) {
  const key = conversationKey(phone, demo);
  if (!conversations.has(key)) conversations.set(key, []);
  return conversations.get(key);
}

function pushTurn(phone, role, content, demo) {
  const history = getConversation(phone, demo);
  history.push({ role, content });
  while (history.length > 10) history.shift();
}

// Which demo a given phone number is currently in (see lib/demoRouter.js).
// Set once per phone on first contact (RCS text or PSTN call) and reused
// for every subsequent message/call from that number, so a visitor doesn't
// need to repeat the QR code's keyword on every turn. Not meant to survive
// a Render restart, same tradeoff as everything else in this file.
const activeDemos = new Map();

function getActiveDemo(phone) {
  return activeDemos.get(phone);
}

function setActiveDemo(phone, demo) {
  if (phone && demo) activeDemos.set(phone, demo);
}

// Ticket details extracted from an uploaded ticket photo (see
// lib/ticketingFlow.js / lib/ticketingEngine.js), keyed by phone number.
// Mirrors the original Node-RED flow's "VARIABLE SEAT" function node
// (flow.set('Seat', ...) etc.) — merges in whichever fields Claude Vision
// actually extracted, keeping any previously-known fields it didn't repeat.
const ticketFields = new Map();

function getTicketFields(phone) {
  return ticketFields.get(phone) || {};
}

function setTicketFields(phone, fields) {
  if (!phone) return;
  const existing = getTicketFields(phone);
  const merged = { ...existing };
  for (const [key, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  ticketFields.set(phone, merged);
  return merged;
}

// Where a given phone number currently is in the Ticketing demo's
// purchase-and-matchday journey (see lib/ticketingFlow.js's
// computeNextState), plus whatever the journey has learned so far
// (productId/row/seat). Deterministic and code-owned — Claude
// (ticketingEngine.js) only decides which marker fires each turn; this is
// what actually remembers the visitor's stage, so a single ambiguous model
// output can't skip/repeat a stage. Same in-memory tradeoff as everything
// else in this file (lost on a Render restart). An unset phone number has
// no stage yet, which ticketingFlow.js treats as "first-ever contact".
const ticketingState = new Map();

function getTicketingState(phone) {
  return ticketingState.get(phone) || {};
}

function setTicketingState(phone, patch) {
  if (!phone) return;
  const merged = { ...getTicketingState(phone), ...patch };
  ticketingState.set(phone, merged);
  return merged;
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
  getActiveDemo,
  setActiveDemo,
  getTicketFields,
  setTicketFields,
  getTicketingState,
  setTicketingState,
};
