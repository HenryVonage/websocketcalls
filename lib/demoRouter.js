// Decides which demo a given RCS phone number is talking to — the Real
// Estate demo (existing, default) or the Ticketing demo (new) — since both
// now share the same Vonage Application, the same RCS agent, and the same
// linked PSTN number (see businessConfig.js). There's no channel-level or
// number-level signal to tell them apart, so the split has to happen on the
// first message's *content* instead.
//
// Mechanism: the demo portfolio landing page (frontend/demo.html) pre-fills
// the QR code's RCS message with a greeting that names the demo, e.g.
// "Hi, Im Henry — Welcome to the Ticketing demo!" (see that file's DEMOS[]
// entry for 'henry-ticketing-rcs'). Matching on the word "ticketing"
// anywhere in that greeting covers both that sentence and a bare keyword
// like "TICKETING" someone might type by hand — deliberately loose rather
// than requiring an exact string, so small edits to the greeting text don't
// silently break routing.
//
// Once resolved, the choice is remembered per phone number (store.js) so
// every later message/reply/postback in that conversation — and a later
// PSTN call from the same number, see voiceHandlers.js — keeps routing to
// the same demo without needing the keyword repeated.
const { getActiveDemo, setActiveDemo } = require('./store');

const TICKETING_KEYWORD_RE = /ticketing/i;

const DEMOS = { REAL_ESTATE: 'real-estate', TICKETING: 'ticketing' };

function detectDemoFromText(text) {
  if (TICKETING_KEYWORD_RE.test(String(text || ''))) return DEMOS.TICKETING;
  return null;
}

// Resolves (and remembers) which demo `phone` belongs to. Falls back to the
// Real Estate demo when nothing matches — preserves today's behavior for
// every existing tester/QR code that doesn't mention "ticketing".
function resolveDemo(phone, messageText) {
  const existing = getActiveDemo(phone);
  if (existing) return existing;

  const detected = detectDemoFromText(messageText) || DEMOS.REAL_ESTATE;
  setActiveDemo(phone, detected);
  return detected;
}

module.exports = { DEMOS, detectDemoFromText, resolveDemo };
