// In-memory Maps, same shape as the original "no external DB" design — but
// now mirrored to a small Render Key Value (Redis-compatible) instance so
// state survives a server restart instead of being wiped by it. Every push
// during active development redeploys websocketcalls, which used to reset
// every tester's progress (phone->demo binding, ticketing stage,
// conversation history, etc.) — confirmed live as the cause of several
// "the flow didn't continue"/"routed to the wrong demo" reports. Reads
// stay synchronous against the in-memory Maps (no added latency on the hot
// path); writes are mirrored to Redis in the background (fire-and-forget,
// never blocks a webhook response); on boot, initStore() hydrates the Maps
// from Redis before server.js starts listening. If REDIS_URL isn't set
// (e.g. running locally), everything falls back to the original
// in-memory-only behavior with no code path changes.
const REDIS_URL = process.env.REDIS_URL || '';
let redisClient = null;
if (REDIS_URL) {
  const Redis = require('ioredis');
  redisClient = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  redisClient.on('error', (err) => console.error('Store: Redis error:', err.message));
} else {
  console.log('Store: REDIS_URL not set — running in-memory only, state will not survive a restart.');
}

const REDIS_KEY_PREFIX = 'wc:v1:';

// Every mutation to a given Map/array previously triggered its own
// synchronous JSON.stringify + full Redis SET of the *entire* structure —
// cheap individually, but pushTurn() alone does this twice per Claude
// turn, and the cost only grows as more testers accumulate history. Each
// name's write is now debounced: repeated calls within
// PERSIST_DEBOUNCE_MS collapse into one trailing write, same as a
// browser's typical "save after you stop typing" pattern. Still
// fire-and-forget either way — never awaited from a request handler, and
// a Redis hiccup never breaks the actual webhook response.
const PERSIST_DEBOUNCE_MS = 250;
const pendingPersists = new Map(); // name -> { timer, run }

function schedulePersist(name, run) {
  if (!redisClient) return;
  const existing = pendingPersists.get(name);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingPersists.delete(name);
    run();
  }, PERSIST_DEBOUNCE_MS);
  pendingPersists.set(name, { timer, run });
}

// Fires every still-pending debounced write immediately — called on
// SIGTERM/SIGINT (see the bottom of this file) so a Render redeploy
// landing mid-debounce-window doesn't silently drop the last update to a
// given map.
function flushPendingPersists() {
  for (const { timer, run } of pendingPersists.values()) {
    clearTimeout(timer);
    run();
  }
  pendingPersists.clear();
}

function persistMap(name, map) {
  schedulePersist(name, () => {
    redisClient.set(REDIS_KEY_PREFIX + name, JSON.stringify([...map.entries()])).catch((err) => {
      console.error(`Store: Redis persist failed for ${name}:`, err.message);
    });
  });
}

function persistArray(name, arr) {
  schedulePersist(name, () => {
    redisClient.set(REDIS_KEY_PREFIX + name, JSON.stringify(arr)).catch((err) => {
      console.error(`Store: Redis persist failed for ${name}:`, err.message);
    });
  });
}

// Bounds a Map's size by evicting its oldest-inserted entries once it
// grows past `max` — plain FIFO, not true LRU (no "touch" on read), but
// cheap and enough to stop growth that was previously fully unbounded
// (every tester this demo has ever had, forever). Applied to the Maps
// most likely to actually accumulate over a long-running demo: per-phone
// conversation history, and per-call context/summaries that only ever
// need to live long enough for the relevant follow-up webhook to fire.
function capMapSize(map, max) {
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

async function hydrateMap(name, map) {
  if (!redisClient) return;
  try {
    const raw = await redisClient.get(REDIS_KEY_PREFIX + name);
    if (raw) for (const [k, v] of JSON.parse(raw)) map.set(k, v);
  } catch (err) {
    console.error(`Store: Redis hydrate failed for ${name}:`, err.message);
  }
}

async function hydrateArray(name, arr) {
  if (!redisClient) return;
  try {
    const raw = await redisClient.get(REDIS_KEY_PREFIX + name);
    if (raw) arr.push(...JSON.parse(raw));
  } catch (err) {
    console.error(`Store: Redis hydrate failed for ${name}:`, err.message);
  }
}

// Called once from server.js before app.listen() — awaited, so the server
// never starts accepting webhooks with only half-restored state.
async function initStore() {
  if (!redisClient) return;
  await Promise.all([
    hydrateMap('conversations', conversations),
    hydrateMap('activeDemos', activeDemos),
    hydrateMap('ticketFields', ticketFields),
    hydrateMap('ticketingState', ticketingState),
    hydrateMap('musicLoversState', musicLoversState),
    hydrateMap('spotifyTokens', spotifyTokens),
    hydrateMap('topTracksCatalog', topTracksCatalog),
    hydrateMap('callContext', callContext),
    hydrateMap('callSummaries', callSummaries),
    hydrateMap('callerNames', callerNames),
    hydrateArray('flowResponses', flowResponses),
  ]);
  console.log(
    `Store: hydrated from Redis — ${activeDemos.size} active demo binding(s), ${ticketingState.size} ticketing state(s), ${conversations.size} conversation(s) restored.`
  );
}

// Text conversation memory, keyed by "demo:phone" (demo defaults to
// 'real-estate' so every pre-existing call site — whatsappFlow.js,
// rcsFlow.js's real-estate branch, conversationEngine.js — keeps working
// unchanged). Namespacing by demo means a tester phone number that's been
// through both the Real Estate and Ticketing demos gets two independent
// histories instead of one conversation bleeding into the other.
// Mirrors n8n's memoryBufferWindow (contextWindowLength: 10).
const conversations = new Map();

// How many distinct demo:phone conversations to keep at once — each one
// is already capped at 10 turns internally (see pushTurn below), but
// nothing previously capped the *number* of phone numbers remembered, so
// this grew by one entry for every tester this demo has ever had, forever.
const MAX_TRACKED_CONVERSATIONS = 200;

function conversationKey(phone, demo) {
  return `${demo || 'real-estate'}:${phone}`;
}

function getConversation(phone, demo) {
  const key = conversationKey(phone, demo);
  if (!conversations.has(key)) {
    conversations.set(key, []);
    capMapSize(conversations, MAX_TRACKED_CONVERSATIONS);
  }
  return conversations.get(key);
}

function pushTurn(phone, role, content, demo) {
  const history = getConversation(phone, demo);
  history.push({ role, content });
  while (history.length > 10) history.shift();
  persistMap('conversations', conversations);
}

// Wipes a phone number's conversation history for one demo, same idea as
// resetTicketingJourney below but for the Claude-driven marker flows
// (Real Estate WhatsApp/RCS). Without this, a tester re-scanning the QR
// code just resumes wherever their last test happened to leave off — a
// fresh "Welcome to Henrys Real Estate demo!" greeting gets appended onto
// old, already-advanced history instead of starting clean, and Claude
// (seeing that stale context) can jump straight to a mid-conversation
// marker instead of [WELCOME] (confirmed live: a fresh greeting produced
// [TIMESLOT_LIST] because the number's prior test had already reached
// "Book a viewing"). See whatsappFlow.js/rcsFlow.js's use of it.
function resetConversation(phone, demo) {
  const key = conversationKey(phone, demo);
  conversations.delete(key);
  persistMap('conversations', conversations);
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
  if (phone && demo) {
    activeDemos.set(phone, demo);
    persistMap('activeDemos', activeDemos);
  }
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
  persistMap('ticketFields', ticketFields);
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
  persistMap('ticketingState', ticketingState);
  return merged;
}

// Wipes a phone number's Ticketing progress (stage + any learned ticket
// fields) so the next inbound is treated as first-ever contact again, even
// though Redis persistence otherwise keeps state alive across restarts on
// purpose. Used for the "Welcome to the Ticketing demo" reset phrase (see
// lib/ticketingWhatsappFlow.js) — testers repeatedly reusing the same
// phone number need an explicit way back to a clean slate, without
// weakening persistence for real, non-reset journeys.
function resetTicketingJourney(phone) {
  if (!phone) return;
  ticketingState.delete(phone);
  ticketFields.delete(phone);
  persistMap('ticketingState', ticketingState);
  persistMap('ticketFields', ticketFields);
  // Ticketing's stage is tracked deterministically above (not by Claude),
  // but decideTicketingMarker still reads/writes a 'ticketing' Claude
  // conversation history via getConversation/pushTurn — without also
  // clearing that here, a reset journey's very first turn could still be
  // decided with stale prior-conversation context in the prompt, same
  // class of bug resetConversation() exists to prevent for Real Estate.
  resetConversation(phone, 'ticketing');
}

// Where a given phone number currently is in the Music Lovers journey
// (awaiting_genre / awaiting_confirmation / done), plus whichever genre and
// track it got matched to — same pattern as ticketingState above. See
// lib/musicLoversFlow.js.
const musicLoversState = new Map();

function getMusicLoversState(phone) {
  return musicLoversState.get(phone) || {};
}

function setMusicLoversState(phone, patch) {
  if (!phone) return;
  const merged = { ...getMusicLoversState(phone), ...patch };
  musicLoversState.set(phone, merged);
  persistMap('musicLoversState', musicLoversState);
  return merged;
}

// Wipes a phone number's Music Lovers progress so the next inbound (a
// re-scanned QR/link) is treated as first-ever contact again — same
// reasoning as resetTicketingJourney above.
function resetMusicLoversJourney(phone) {
  if (!phone) return;
  musicLoversState.delete(phone);
  persistMap('musicLoversState', musicLoversState);
}

// OAuth tokens for a listener's own Spotify account (Authorization Code
// flow — see lib/spotifyOAuth.js), keyed by phone number. Set once when
// they complete "Connect your Spotify" (server.js's /api/spotify-callback)
// and reused for any later re-sync — same pattern as musicLoversState
// above, kept in its own map since a phone number can have Spotify tokens
// without having gone through (or restarted) the WhatsApp journey.
const spotifyTokens = new Map();

function setSpotifyTokens(phone, tokens) {
  if (!phone) return;
  spotifyTokens.set(phone, { ...tokens, connectedAt: Date.now() });
  persistMap('spotifyTokens', spotifyTokens);
}

function getSpotifyTokens(phone) {
  return spotifyTokens.get(phone);
}

// Cached "genre -> candidate tracks from Henry's own Top Tracks" catalog,
// built by /admin/music-lovers/refresh-top-tracks-catalog (server.js) from
// the owner's Spotify account (see spotifyOAuth.js's OWNER_KEY) rather than
// looked up live on every send — a live lookup would mean a Top Tracks
// fetch + a batch artist-genres fetch on every single WhatsApp reply, which
// is both slower and more fragile for a live demo than refreshing this
// on demand and reading from it instantly. Keyed by genre (one of
// musicLoversConfig.GENRES); value is { tracks: [{spotifyTrackId, title,
// artist, popularity}], refreshedAt }. musicLoversFlow.js's
// pickTrackForGenre() reads this first and falls back to
// musicLoversConfig.js's static TRACK_CATALOG when a genre has no cached
// entry (or an empty one) yet.
const topTracksCatalog = new Map();

function setTopTracksCatalogForGenre(genre, data) {
  if (!genre) return;
  topTracksCatalog.set(genre, { ...data, refreshedAt: Date.now() });
  persistMap('topTracksCatalog', topTracksCatalog);
}

function getTopTracksCatalogForGenre(genre) {
  return topTracksCatalog.get(genre);
}

function getAllTopTracksCatalog() {
  return Object.fromEntries(topTracksCatalog);
}

// Correlates a Vonage conversation_uuid to voice-call context (why the call
// was placed, and which phone number it's with) so the /events webhook can
// decide what to do when the call completes.
const callContext = new Map();
const MAX_TRACKED_CALL_CONTEXTS = 300;

function setCallContext(conversationUuid, context) {
  if (conversationUuid) {
    callContext.set(conversationUuid, context);
    capMapSize(callContext, MAX_TRACKED_CALL_CONTEXTS);
    persistMap('callContext', callContext);
  }
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
  persistMap('callContext', callContext);
}

// Holds the generated post-call recap text, keyed by Vonage conversation_uuid,
// so the /call-summary/:conversationUuid.pdf route (server.js) can render it
// into a PDF on demand when WhatsApp fetches the henry_callrecap template's
// document header. Same in-memory tradeoff as everything else here — a
// Render restart between call-end and WhatsApp's fetch would 404.
const callSummaries = new Map();
const MAX_TRACKED_CALL_SUMMARIES = 300;

function setCallSummaryText(conversationUuid, text) {
  if (conversationUuid) {
    callSummaries.set(conversationUuid, text);
    capMapSize(callSummaries, MAX_TRACKED_CALL_SUMMARIES);
    persistMap('callSummaries', callSummaries);
  }
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
  if (phone && name) {
    callerNames.set(phone, name);
    persistMap('callerNames', callerNames);
  }
}

function getCallerName(phone) {
  return callerNames.get(phone);
}

// Answers to WhatsApp Flow messages (currently just henry_form2's "Survey"
// button — see voiceHandlers.js/whatsappFlow.js), captured from the inbound
// nfm_reply webhook. Kept as a flat log rather than one-per-phone, since the
// same number can complete a flow more than once over the demo's lifetime.
const flowResponses = [];

const MAX_TRACKED_FLOW_RESPONSES = 100;

function saveFlowResponse(entry) {
  flowResponses.push(entry);
  while (flowResponses.length > MAX_TRACKED_FLOW_RESPONSES) flowResponses.shift();
  persistArray('flowResponses', flowResponses);
  return entry;
}

function getFlowResponses(phone) {
  return phone ? flowResponses.filter((r) => r.phone === phone) : flowResponses;
}

// Render sends SIGTERM before stopping the old instance on a deploy —
// flush any still-debounced Redis writes immediately so a redeploy
// landing mid-window (see PERSIST_DEBOUNCE_MS above) doesn't drop the
// last update to a given map. SIGINT covers a local `Ctrl+C` the same
// way. Both re-raise the default behavior after flushing so shutdown
// still proceeds normally — this only front-runs it by a moment.
if (redisClient) {
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      flushPendingPersists();
      process.kill(process.pid, sig);
    });
  }
}

module.exports = {
  initStore,
  getConversation,
  pushTurn,
  resetConversation,
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
  resetTicketingJourney,
  getMusicLoversState,
  setMusicLoversState,
  resetMusicLoversJourney,
  getSpotifyTokens,
  setSpotifyTokens,
  setTopTracksCatalogForGenre,
  getTopTracksCatalogForGenre,
  getAllTopTracksCatalog,
};
