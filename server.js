const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const rateLimit = require('express-rate-limit');

const { handleWhatsAppInbound } = require('./lib/whatsappFlow');
const { processTicketingWhatsapp } = require('./lib/ticketingWhatsappFlow');
const { handleRcsInbound } = require('./lib/rcsFlow');
const { DEMOS, detectDemoFromText, resolveDemo } = require('./lib/demoRouter');
const { handleAnswer, handleEvents } = require('./lib/voiceHandlers');
const { handleDlr } = require('./lib/dlrHandler');
const { attachVoiceBridge } = require('./lib/realtimeBridge');
const { getCallSummaryText } = require('./lib/store');
const { renderSummaryPdf } = require('./lib/pdfSummary');
const { getRecentEvents } = require('./lib/activityLog');
const { generateRcsDeeplink, addRcsTestDevice, listRcsAgents } = require('./lib/vonageApi');
const { logEvent, redactPhone } = require('./lib/activityLog');
const config = require('./lib/businessConfig');

// Turns whatever format a visitor typed (spaces, leading 0, etc.) into
// E.164 for the Channel Manager API. Only handles the GB case explicitly
// (this demo's default country) — anything already starting with "+" is
// passed through as-is.
// Strips everything but digits, so "447312277021", "+447312277021" and
// "44 7312 277021" all compare equal — used to match the inbound
// webhook's `to` field (a WhatsApp Business number) against config values
// without worrying about which of those forms Vonage sends.
function normalizeNumber(n) {
  return String(n || '').replace(/\D/g, '');
}

function normalizeToE164(input, defaultCountry) {
  const cleaned = String(input || '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (defaultCountry === 'GB' && cleaned.startsWith('0')) {
    return `+44${cleaned.slice(1)}`;
  }
  return `+${cleaned}`;
}

// Scans a Channel Manager API response for the deep link URL. Field name
// isn't documented publicly as of this writing, so rather than guessing one
// key, walk the response for any string that looks like the sms: URI /
// https link we expect — logged in full server-side either way (see
// vonageApi.js) so the exact shape is visible in Render's logs on first use.
function findDeeplinkUrl(value, seen = new Set()) {
  if (typeof value === 'string') {
    return /^(sms:|https?:\/\/)/i.test(value) ? value : null;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const v of Object.values(value)) {
    const found = findDeeplinkUrl(v, seen);
    if (found) return found;
  }
  return null;
}

const app = express();
app.use(express.json());

// Render sits behind a proxy — required so express-rate-limit (and any
// other req.ip usage) sees the real visitor IP via X-Forwarded-For
// instead of Render's internal proxy IP for every single request.
app.set('trust proxy', 1);

// TEMPORARY DIAGNOSTIC — logs every incoming request (method, path, and a
// couple of headers) so we can see whether Vonage's WhatsApp Calling is
// hitting this server at all, and on what path, while tracking down why
// inbound WhatsApp calls aren't reaching /answer. Safe to remove once the
// call flow is confirmed working — read-only, doesn't touch the response.
app.use((req, res, next) => {
  console.log('>>> INCOMING REQUEST', req.method, req.originalUrl, JSON.stringify({
    'content-type': req.headers['content-type'],
    'user-agent': req.headers['user-agent'],
  }));
  next();
});

// --- Rate limiters ---
// Applied only to the public, unauthenticated demo-frontend endpoints —
// not to Vonage's own inbound webhooks (messaging/voice/DLR), which need
// to reliably accept traffic regardless of volume.
//
// 5 per 15 min: a real visitor only ever needs to register once or twice;
// this just stops the endpoint being scripted to spam arbitrary numbers
// with Google's RCS tester SMS invite.
const testerDeviceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts from this device. Please try again in a few minutes.' },
});

// 50 per minute: generous enough for normal demo-page traffic (both hit
// automatically on page load) while still blocking scripted abuse.
const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});

// --- Inbound messaging (Flow 3, + the RCS demo) ---
// Both demos share the same Vonage Application, and a Vonage Application
// has a single inbound-message webhook URL covering every channel enabled
// on it — so RCS inbound messages land here too, distinguished by
// body.channel, rather than needing a second URL configured in the
// dashboard. Route name kept as-is to avoid a webhook reconfiguration.
app.post('/vonage-estate-whatsapp', (req, res) => {
  const body = req.body || {};

  if (body.channel === 'rcs') {
    handleRcsInbound(req, res);
    return;
  }

  // WhatsApp. The Ticketing demo currently shares the Real Estate demo's
  // WABA number (config.FROM_WHATSAPP) rather than a genuinely dedicated
  // one — 447312277021 was never actually linked to this Vonage
  // Application, so nothing ever reached this route for it (confirmed via
  // Render logs: zero inbound webhooks, not a template-send failure).
  //
  // If a truly dedicated Ticketing WhatsApp number ever IS linked here
  // later (config.TICKETING.WHATSAPP.FROM_WHATSAPP no longer equal to
  // config.FROM_WHATSAPP), routing by `to` is unambiguous and preferred —
  // checked first. Otherwise, fall back to the same greeting-text
  // detection the two RCS demos already use to share one agent
  // (lib/demoRouter.js) — resolveDemo() both decides AND remembers the
  // choice per phone number, which lib/voiceHandlers.js's calling routing
  // also depends on for this same shared-number ambiguity.
  const dedicatedTicketingNumber = config.TICKETING.WHATSAPP.FROM_WHATSAPP;
  const hasDedicatedNumber = normalizeNumber(dedicatedTicketingNumber) !== normalizeNumber(config.FROM_WHATSAPP);

  if (hasDedicatedNumber && normalizeNumber(body.to) === normalizeNumber(dedicatedTicketingNumber)) {
    processTicketingWhatsapp(req, res);
    return;
  }

  const messageText = body.text ?? body.button?.text ?? body.button?.payload ?? '';
  const demo = resolveDemo(body.from, messageText);
  if (demo === DEMOS.TICKETING) {
    processTicketingWhatsapp(req, res);
  } else {
    handleWhatsAppInbound(req, res);
  }
});

// --- Voice: Answer URL + Event URL (Flow 5 / Flow 4) ---
app.get('/answer', handleAnswer);
app.post('/answer', handleAnswer);
app.post('/events', handleEvents);

// --- Delivery receipts (DLR Status Handler) ---
app.post('/vonage-dlr-status', handleDlr);

// --- Public, redacted activity feed for the demo frontend's logs page ---
// (CORS-open since it's fetched cross-origin from GitHub Pages; safe to be
// public since entries are pre-redacted at the point they're logged.)
app.get('/api/logs', publicApiLimiter, (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ events: getRecentEvents() });
});

// --- RCS launch redirect for the demo frontend's QR code / Open button ---
// Same trick as wa.me for the WhatsApp demos: several QR scanner apps
// (confirmed first-hand — reproduced with a widely-used Android barcode
// reader) don't recognize a raw sms:... URI as a launchable chat invite
// when it's scanned directly — they just show it as inert text or a
// generic "Send SMS" card, ignoring the bot-name/body params entirely.
// A plain https:// URL is recognized as a normal web link by literally
// every scanner, so the QR/Open link points here instead; this then
// 302-redirects to the real sms: URI, and the *browser* (not the scanner
// app) hands that off to the OS's own scheme resolution — which does
// correctly route it to Messages/RBM with the message pre-filled, the
// same way it reliably does for wa.me -> whatsapp:// already.
// Minimal HTML-escaping / JS-string-escaping for the tiny landing page
// below — the only untrusted input reflected into it is the query params
// this same route reads (to/bot/body), so this doesn't need to be a full
// sanitizer, just correct for the characters those can contain.
function htmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function jsStringEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\x3c');
}

app.get('/rcs-launch', publicApiLimiter, (req, res) => {
  const to = String(req.query.to || '').trim();
  const bot = String(req.query.bot || '').trim().slice(0, 100);
  const body = String(req.query.body || '').trim().slice(0, 500);
  if (!to) {
    res.status(400).send('Missing "to" (RCS service_id) query parameter.');
    return;
  }
  // service_id must stay literal in the URI (not URI-encoded) — encoding
  // the "@" breaks Android/Messages' recognition of it as an RBM agent
  // address (confirmed by testing: it fell back to treating the whole
  // string as a garbled SMS recipient). Only the query param *values*
  // (bot-name, body) get encoded, mirroring demo.html's own builder.
  const target = `sms:${to}?bot-name=${encodeURIComponent(bot)}&body=${encodeURIComponent(body)}`;

  // A bare 302 (the first version of this route) turned out not to be
  // enough — confirmed on a real device: a third-party QR scanner app's
  // "Open" button opened this URL, followed the redirect, and then did
  // nothing. Most mobile browsers only allow navigating to a custom
  // scheme (sms:, whatsapp:, etc.) off a *direct* user tap — an
  // automatic redirect with no click inside the destination page itself
  // doesn't count as that gesture, so the scheme navigation gets
  // silently dropped. wa.me and virtually every other click-to-chat
  // service solve this the same way: serve a real 200 landing page that
  // both attempts an immediate JS redirect (works wherever that's
  // allowed) and shows a plainly tappable fallback link (works
  // everywhere else, since tapping it *is* the required gesture).
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening Messages…</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #10254d; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
  p { opacity: 0.85; font-size: 14px; max-width: 320px; margin: 8px 0; }
  a.btn { display: inline-block; margin-top: 20px; background: #fff; color: #10254d; font-weight: 600; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-size: 16px; }
</style>
</head>
<body>
  <p>Opening Messages…</p>
  <a class="btn" href="${htmlEscape(target)}">Tap here if it doesn't open automatically</a>
  <p>If nothing happens within a second or two, tap the button above.</p>
  <script>
    window.location.href = "${jsStringEscape(target)}";
  </script>
</body>
</html>`);
});

// --- RCS deep link for the demo frontend's QR code (see demo.html) ---
// Generates the link via Vonage's Channel Manager API (the officially
// supported route, which Android's native Camera app recognizes) rather
// than having the frontend hand-build an sms: URI. Falls back cleanly if
// VONAGE_API_KEY/SECRET aren't configured yet, or if this call itself
// fails — the frontend keeps using its own client-built link in that
// case (see demo.html's fetchOfficialRcsDeeplink()).
//
// ?body= carries the same prefilled greeting text demo.html would
// otherwise embed in its own sms: URI — demoRouter.js still needs that
// text to arrive with the visitor's first inbound message so it can tell
// which demo (Ticketing vs Real Estate) they came from.
app.get('/api/rcs-deeplink', publicApiLimiter, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const prefilledMessage = String(req.query.body || '').trim().slice(0, 3072);
    const result = await generateRcsDeeplink({
      senderId: config.RCS_AGENT_SENDER_ID,
      country: config.RCS_DEEPLINK_COUNTRY,
      prefilledMessage: prefilledMessage || undefined,
    });
    if (!result.ok) {
      res.status(502).json({ error: 'Vonage Channel Manager API error', details: result.json });
      return;
    }
    const url = findDeeplinkUrl(result.json);
    res.json({ url, raw: result.json });
  } catch (err) {
    console.error('GET /api/rcs-deeplink error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Debug-only: list RCS agents to find the real internal agent_id ---
// (the test-devices endpoint rejected the human-readable sender_id
// "henry_rcs_demo3" with "RCS Wizard Not Found" — this route exists to
// look up the correct id once, not meant to stay linked from the frontend.)
app.get('/api/rcs-agents', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const result = await listRcsAgents();
    res.status(result.ok ? 200 : 502).json(result.json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Register a visitor's phone number as an RCS test device (demo.html) ---
// The RCS agent isn't fully launched with carriers/Google yet, so Google
// Messages refuses to open a chat with it for anyone except numbers
// explicitly allow-listed here — even though the deep link itself works
// fine for everyone. This is a demo-only convenience: it lets a visitor
// register themselves as a tester right before scanning, instead of
// needing that done manually in the Vonage dashboard ahead of time.
app.options('/api/rcs-test-device', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});
app.post('/api/rcs-test-device', testerDeviceLimiter, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const raw = String(req.body?.phoneNumber || '').trim();
    if (!raw) {
      res.status(400).json({ error: 'phoneNumber is required' });
      return;
    }
    const phoneNumber = normalizeToE164(raw, config.RCS_DEEPLINK_COUNTRY);
    const result = await addRcsTestDevice({
      agentId: config.RCS_AGENT_ID_CM,
      phoneNumber,
      country: config.RCS_DEEPLINK_COUNTRY,
    });
    logEvent(
      result.ok ? 'call' : 'dlr',
      `RCS test-device registration for ${redactPhone(phoneNumber)}: ${result.ok ? 'accepted' : `failed (${result.status})`}`
      );
    if (!result.ok) {
      res.status(502).json({ error: 'Vonage Channel Manager API error', details: result.json });
      return;
    }
    res.json({ ok: true, raw: result.json });
  } catch (err) {
    console.error('POST /api/rcs-test-device error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Post-call recap PDF, fetched by WhatsApp for the henry_callrecap
// template's document header (see voiceHandlers.js) ---
app.get('/call-summary/:conversationUuid.pdf', async (req, res) => {
  const summary = getCallSummaryText(req.params.conversationUuid);
  if (!summary) {
    res.status(404).send('Call summary not found (expired, not yet generated, or server restarted).');
    return;
  }
  try {
    const pdfBuffer = await renderSummaryPdf(summary);
    res.set('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Failed to render call summary PDF:', err);
    res.status(500).send('Failed to generate PDF');
  }
});

app.get('/', (req, res) => {
  res.send('Vonage Estate server is running.');
});

const server = http.createServer(app);

// The realtime audio connection (Flow 6 replacement) needs raw
// binary/text websocket frames, not Express JSON routing, so it's handled
// as a manual upgrade on a dedicated path instead of an Express route.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/voice') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', attachVoiceBridge);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Vonage Estate server listening on port ${PORT}`);
});
