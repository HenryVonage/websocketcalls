const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const { handleWhatsAppInbound } = require('./lib/whatsappFlow');
const { handleRcsInbound } = require('./lib/rcsFlow');
const { handleAnswer, handleEvents } = require('./lib/voiceHandlers');
const { handleDlr } = require('./lib/dlrHandler');
const { attachVoiceBridge } = require('./lib/realtimeBridge');
const { getCallSummaryText } = require('./lib/store');
const { renderSummaryPdf } = require('./lib/pdfSummary');
const { getRecentEvents } = require('./lib/activityLog');
const { generateRcsDeeplink } = require('./lib/vonageApi');
const config = require('./lib/businessConfig');

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
app.get('/api/logs', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ events: getRecentEvents() });
});

// --- RCS deep link for the demo frontend's QR code (see demo.html) ---
// Generates the link via Vonage's Channel Manager API (the officially
// supported route, which Android's native Camera app recognizes) rather
// than having the frontend hand-build an sms: URI. Falls back cleanly if
// VONAGE_API_KEY/SECRET aren't configured yet — the frontend keeps using
// its own client-built link in that case.
app.get('/api/rcs-deeplink', async (req, res) => {
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
