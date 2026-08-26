const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const rateLimit = require('express-rate-limit');

const { handleWhatsAppInbound } = require('./lib/whatsappFlow');
const { handleRcsInbound } = require('./lib/rcsFlow');
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
  if (req.body?.channel === 'rcs') {
    handleRcsInbound(req, res);
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

// --- RCS deep link for the demo frontend's QR code (see demo.html) ---
// Generates the link via Vonage's Channel Manager API (the officially
// supported route, which Android's native Camera app recognizes) rather
// than having the frontend hand-build an sms: URI. Falls back cleanly if
// VONAGE_API_KEY/SECRET aren't configured yet — the frontend keeps using
// its own client-built link in that case.
app.get('/api/rcs-deeplink', publicApiLimiter, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const result = await generateRcsDeeplink({
      senderId: config.RCS_AGENT_SENDER_ID,
      country: config.RCS_DEEPLINK_COUNTRY,
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
