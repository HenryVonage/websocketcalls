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
//
// BUT a phone number trying this demo portfolio isn't limited to one demo
// forever — the whole point of demo.html is letting the same tester bounce
// between QR codes (try Real Estate, then scan Ticketing, then maybe back).
// So a fresh QR-triggered greeting always (re)claims the number for
// whichever demo it names, even overriding a previously-remembered one —
// confirmed necessary the hard way: scanning the Ticketing QR on a number
// that had earlier talked to Real Estate kept silently replaying Real
// Estate, because the old per-phone binding was never re-evaluated. Only a
// message that actually *looks like* one of those greetings can trigger
// this — matched on "welcome to" specifically, not a bare keyword — so an
// ordinary mid-conversation reply (e.g. someone asking a Real Estate FAQ
// that happens to mention "ticketing") can't accidentally hijack an
// in-progress conversation into the wrong demo.
const { getActiveDemo, setActiveDemo } = require('./store');

const GREETING_RE = /welcome to/i;
const TICKETING_KEYWORD_RE = /ticketing/i;

const DEMOS = { REAL_ESTATE: 'real-estate', TICKETING: 'ticketing' };

// Only evaluates messages shaped like a QR-triggered greeting (see above)
// — returns null for everything else, meaning "don't change demo routing".
function detectDemoFromText(text) {
  const t = String(text || '');
  if (!GREETING_RE.test(t)) return null;
  return TICKETING_KEYWORD_RE.test(t) ? DEMOS.TICKETING : DEMOS.REAL_ESTATE;
}

// Resolves (and remembers) which demo `phone` belongs to. A greeting-shaped
// message naming a demo always (re)binds to that demo, even switching away
// from whatever was previously active. Anything else keeps routing to the
// existing binding, or — on genuinely first contact with no greeting match
// — falls back to the Real Estate demo, preserving today's behavior for
// every existing tester/QR code that doesn't mention "ticketing".
function resolveDemo(phone, messageText) {
  const existing = getActiveDemo(phone);
  const detected = detectDemoFromText(messageText);

  if (detected && detected !== existing) {
    setActiveDemo(phone, detected);
    return detected;
  }
  if (existing) return existing;

  const fallback = detected || DEMOS.REAL_ESTATE;
  setActiveDemo(phone, fallback);
  return fallback;
}

module.exports = { DEMOS, detectDemoFromText, resolveDemo };
