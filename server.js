const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const rateLimit = require('express-rate-limit');

const { handleWhatsAppInbound } = require('./lib/whatsappFlow');
const { processTicketingWhatsapp, TICKETING_REPLY_IDS } = require('./lib/ticketingWhatsappFlow');
const { handleMusicLoversInbound, handleSpotifyConnected } = require('./lib/musicLoversFlow');
const { handleRcsInbound } = require('./lib/rcsFlow');
const { DEMOS, detectDemoFromText, resolveDemo } = require('./lib/demoRouter');
const { getTrackPreviewUrl, getPlaylistTracks } = require('./lib/spotifyApi');
const spotifyOAuth = require('./lib/spotifyOAuth');
const { searchVideoId } = require('./lib/youtubeApi');
const { buildRingtoneClip, isCached: isRingtoneCached } = require('./lib/ringtoneBuilder');
const { handleAnswer, handleEvents } = require('./lib/voiceHandlers');
const { handleDlr } = require('./lib/dlrHandler');
const { attachVoiceBridge } = require('./lib/realtimeBridge');
const {
  getCallSummaryText,
  setActiveDemo,
  setCallerName,
  setSpotifyTokens,
  getSpotifyTokens,
  setTopTracksCatalogForGenre,
  getAllTopTracksCatalog,
  initStore,
} = require('./lib/store');
const { renderSummaryPdf } = require('./lib/pdfSummary');
const { getRecentEvents } = require('./lib/activityLog');
const { generateRcsDeeplink, addRcsTestDevice, listRcsAgents } = require('./lib/vonageApi');
const { logEvent, redactPhone } = require('./lib/activityLog');
const config = require('./lib/businessConfig');
const multer = require('multer');
const { sendFeedbackEmail, isValidEmail, sendSpotifyTesterRequestEmail } = require('./lib/feedbackMailer');

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

// Gates diagnostic/admin-only routes (the pre-existing /api/rcs-agents and
// /admin/whatsapp-templates below, and the new Music Lovers playlist/catalog
// routes further down) — previously /api/rcs-agents and
// /admin/whatsapp-templates were public and unauthenticated: one lists
// account-level RCS agents to anyone, the other inspects WhatsApp template
// metadata for any WABA id someone passes in. Set ADMIN_TOKEN in Render's
// env and pass it as ?admin_token=<value> (or an X-Admin-Token header) to
// use any of these routes; unset, they stay closed rather than defaulting
// open.
function requireAdminToken(req, res, next) {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) {
    res.status(503).json({ error: 'This diagnostic route is disabled — set ADMIN_TOKEN in the environment to enable it.' });
    return;
  }
  const supplied = req.query.admin_token || req.headers['x-admin-token'];
  if (supplied !== configured) {
    res.status(401).json({ error: 'Missing or invalid admin token.' });
    return;
  }
  next();
}

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

// 5 per 15 min per IP — this endpoint sends a real email to Henry's inbox
// on every accepted submission, so it needs a tighter cap than ordinary
// page-load traffic (same reasoning/limit as testerDeviceLimiter above).
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this device. Please try again in a few minutes.' },
});

// 5 per 15 min — same reasoning as feedbackLimiter above: this sends a real
// email to Henry's inbox on every accepted submission.
const spotifyTesterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Please try again in a few minutes.' },
});

// --- Feedback form uploads (photos/video attached to henryauthier@gmail.com) ---
// Memory storage, not disk: files are only ever held long enough to attach
// them to one outgoing email (see lib/feedbackMailer.js), never written to
// disk or persisted anywhere. multer's own `fileSize` limit is per-file,
// not per-request, so it's set equal to the total cap here (15MB) so it
// never fires before the *actual* per-request cap below does — that one
// is the real gate, enforced explicitly across all files combined, after
// multer has parsed the request. Up to 8 files, 15MB combined: comfortably
// under Gmail's own ~25MB message-size ceiling once base64 encoding
// overhead (~1.33x) and the email body are accounted for.
const FEEDBACK_MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const FEEDBACK_ALLOWED_MIME = /^image\/(png|jpe?g)$|^video\//i;
const feedbackUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (!FEEDBACK_ALLOWED_MIME.test(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Only images (png/jpg/jpeg) and video are accepted.`));
      return;
    }
    cb(null, true);
  },
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
  const replyId = body.interactive?.list_reply?.id ?? body.interactive?.button_reply?.id ?? body.reply?.id ?? null;
  const isKnownTicketingReply = replyId != null && TICKETING_REPLY_IDS.has(replyId);

  if (isKnownTicketingReply) {
    setActiveDemo(body.from, DEMOS.TICKETING); // re-heal the binding for the rest of this conversation too
    processTicketingWhatsapp(req, res);
    return;
  }

  const demo = resolveDemo(body.from, messageText);
  if (demo === DEMOS.TICKETING) {
    processTicketingWhatsapp(req, res);
  } else if (demo === DEMOS.MUSIC_LOVERS) {
    handleMusicLoversInbound(req, res);
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
app.get('/api/rcs-agents', requireAdminToken, async (req, res) => {
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

// --- Music Lovers "Connect your Spotify" step (frontend/music-lovers.html)
// — Authorization Code flow, see lib/spotifyOAuth.js for the full setup
// requirements (redirect URI allow-listed in Spotify's dashboard, tester
// accounts added under User Management while the app is in Development
// Mode). Two-hop redirect: the frontend sends the listener here with their
// phone/name (plain browser navigation, not a fetch — no CORS needed), we
// bounce them to Spotify's own consent screen, Spotify calls back to
// /api/spotify-callback below. ---
app.get('/api/spotify-auth-start', (req, res) => {
  // One-time authorization for Henry's own account, separate from the
  // phone-keyed visitor flow just below — lets the backend build
  // TRACK_CATALOG from Henry's real Top Tracks (see
  // /admin/music-lovers/refresh-top-tracks-catalog further down). Gated by
  // the same ADMIN_TOKEN as the other diagnostic routes rather than a
  // phone number, since there's no visitor session to key it to.
  if (req.query.owner === '1') {
    const configured = process.env.ADMIN_TOKEN;
    const supplied = req.query.admin_token || req.headers['x-admin-token'];
    if (!configured || supplied !== configured) {
      res.status(401).send('Missing or invalid admin token.');
      return;
    }
    try {
      const state = spotifyOAuth.createPendingState(spotifyOAuth.OWNER_KEY, 'Henry (catalog owner)');
      res.redirect(spotifyOAuth.getAuthorizeUrl(state));
    } catch (err) {
      console.error('Spotify owner auth-start failed:', err.message);
      res.status(500).send('Spotify connect is not configured yet (missing SPOTIFY_CLIENT_ID / SPOTIFY_REDIRECT_URI) — see .env.example.');
    }
    return;
  }
  const rawPhone = String(req.query.phone || '').trim();
  const name = String(req.query.name || '').slice(0, 60);
  if (!rawPhone) {
    res.status(400).send('Missing phone number.');
    return;
  }
  const phone = normalizeToE164(rawPhone, config.RCS_DEEPLINK_COUNTRY).replace(/^\+/, '');
  try {
    const state = spotifyOAuth.createPendingState(phone, name);
    res.redirect(spotifyOAuth.getAuthorizeUrl(state));
  } catch (err) {
    console.error('Spotify auth-start failed:', err.message);
    res.status(500).send('Spotify connect is not configured yet (missing SPOTIFY_CLIENT_ID / SPOTIFY_REDIRECT_URI) — see .env.example.');
  }
});

app.get('/api/spotify-callback', async (req, res) => {
  const { code, error, state } = req.query;
  const pageBase = process.env.MUSIC_LOVERS_PAGE_URL || 'https://henryvonage.github.io/frontend/music-lovers.html';
  if (error) {
    logEvent('inbound', `Spotify consent declined: ${error}`);
    res.redirect(`${pageBase}?spotify=denied`);
    return;
  }
  const pending = state && spotifyOAuth.consumePendingState(String(state));
  if (!pending) {
    res.redirect(`${pageBase}?spotify=expired`);
    return;
  }
  const isOwnerAuth = pending.phone === spotifyOAuth.OWNER_KEY;
  try {
    const tokenResp = await spotifyOAuth.exchangeCodeForToken(String(code));
    setSpotifyTokens(pending.phone, {
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token,
      expiresAt: Date.now() + tokenResp.expires_in * 1000,
    });
    if (isOwnerAuth) {
      // Not a visitor session — nothing to redirect back to on
      // music-lovers.html and no WhatsApp match to trigger. Plain
      // confirmation is enough; the next step happens via the admin route.
      logEvent('inbound', 'Spotify connected as Music Lovers catalog owner (Henry)');
      res.send('Spotify connected as the Music Lovers catalog owner. You can close this tab, then call GET /admin/music-lovers/refresh-top-tracks-catalog?admin_token=... to build the genre catalog from your last-4-weeks Top Tracks.');
      return;
    }
    if (pending.name) setCallerName(pending.phone, pending.name);
    logEvent('inbound', `Spotify connected for ${redactPhone(pending.phone)}`);
    // Redirect the visitor's browser back to music-lovers.html immediately
    // — every other webhook/callback in this codebase acks/responds first
    // and does its own follow-up work after, but this one previously
    // awaited a Spotify top-artists fetch + a WhatsApp template send
    // (1-3s) before redirecting at all, leaving the visitor staring at a
    // blank onrender.com page mid-demo. handleSpotifyConnected already has
    // its own try/catch and a fallback to the ordinary genre prompt, so
    // firing it without awaiting is safe.
    res.redirect(`${pageBase}?spotify=connected`);
    handleSpotifyConnected(pending.phone, pending.name || 'there').catch((err) => {
      console.error('handleSpotifyConnected (post-redirect) failed:', err);
    });
  } catch (err) {
    console.error('Spotify OAuth callback failed:', err.message);
    if (isOwnerAuth) {
      res.status(500).send('Spotify owner authorization failed — check the Render logs and try again.');
      return;
    }
    res.redirect(`${pageBase}?spotify=error`);
  }
});

// --- Music Lovers ringtone clip, fetched by WhatsApp for the audio message
// sent after a listener replies confirming the song is "...stuck in my
// head..." (see lib/musicLoversFlow.js and demo-notes.md's "Ringtone
// follow-up feature") ---
app.get('/music-lovers/ringtone/:trackId.ogg', async (req, res) => {
  const { trackId } = req.params;
  try {
    // Skip the Spotify preview-URL lookup entirely on a cache hit — this
    // route previously always did that fetch first even when the clip was
    // already built, so the cache was only ever saving the ffmpeg step,
    // not the network round-trip.
    let clip;
    if (isRingtoneCached(trackId)) {
      clip = await buildRingtoneClip(trackId, null);
    } else {
      const previewUrl = await getTrackPreviewUrl(trackId);
      if (!previewUrl) {
        res.status(404).send('No Spotify preview available for this track (see lib/spotifyApi.js) — needs a royalty-free fallback clip, not yet built.');
        return;
      }
      clip = await buildRingtoneClip(trackId, previewUrl);
    }
    res.set('Content-Type', 'audio/ogg');
    res.send(clip);
  } catch (err) {
    console.error('Failed to build Music Lovers ringtone clip:', err);
    res.status(500).send('Failed to generate ringtone clip');
  }
});

app.get('/', (req, res) => {
  res.send('Vonage Estate server is running.');
});

// Diagnostic-only: lists the message templates Vonage/Meta actually has on
// file for a given WhatsApp Business Account (WABA), with their approval
// status per language — settles "is henry_ticketing3 really approved on
// this number's WABA" from real data instead of guesswork. Pass the WABA
// id from Vonage's dashboard (Messages API -> External Accounts) as
// ?waba=<id>. Returns only template metadata (name/language/status/
// category), nothing sensitive.
app.get('/admin/whatsapp-templates', requireAdminToken, async (req, res) => {
  const wabaId = req.query.waba;
  if (!wabaId) {
    res.status(400).json({ error: 'Pass the WABA id as ?waba=<id> (find it in the Vonage dashboard under Messages API -> External Accounts).' });
    return;
  }
  try {
    const { generateVonageJwt } = require('./lib/vonageJwt');
    // The templates list is paginated (default limit 25, max 500) via a
    // paging.cursors.after / paging.next field — our very first version of
    // this route ignored that entirely and just returned page 1, which
    // silently truncated accounts with more than 25 templates (this WABA
    // has 25+). Ask for the max page size and follow `after` cursors until
    // exhausted, with a hard cap of 20 pages as a runaway-loop guard.
    const templates = [];
    let after = null;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(`https://api.nexmo.com/v2/whatsapp-manager/wabas/${encodeURIComponent(wabaId)}/templates`);
      url.searchParams.set('limit', '500');
      if (after) url.searchParams.set('after', after);
      const vonageRes = await fetch(url, {
        headers: { Authorization: `Bearer ${generateVonageJwt()}` },
      });
      const body = await vonageRes.json().catch(() => ({}));
      if (!vonageRes.ok) {
        res.status(vonageRes.status).json(body);
        return;
      }
      for (const t of (body.templates || [])) {
        templates.push({ name: t.name, language: t.language, status: t.status, category: t.category });
      }
      after = body.paging?.cursors?.after || null;
      if (!after || !body.paging?.next) break;
    }
    res.status(200).json({ waba: wabaId, count: templates.length, templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic-only: dumps every track (id, name, artist(s), Spotify URL) in
// a PUBLIC Spotify playlist, for building/expanding Music Lovers' genre
// catalog (see musicLoversConfig.js's TRACK_CATALOG and demo-notes.md) —
// not wired into any user-facing flow. Pass the playlist id from its
// open.spotify.com/playlist/<id> URL as ?playlistId=<id>. Read-only,
// app-only Client Credentials auth (see spotifyApi.js's getPlaylistTracks),
// so it only works for playlists that are public.
app.get('/admin/music-lovers/playlist-dump', requireAdminToken, async (req, res) => {
  const playlistId = req.query.playlistId;
  if (!playlistId) {
    res.status(400).json({ error: 'Pass the playlist id as ?playlistId=<id> (from its open.spotify.com/playlist/<id> URL).' });
    return;
  }
  try {
    const tracks = await getPlaylistTracks(playlistId);
    res.status(200).json({ playlistId, count: tracks.length, tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Returns a valid access token for the Music Lovers catalog owner (Henry),
// refreshing it first if it's expired (or about to be within 5s) — unlike
// the visitor Spotify-connect flow, which only ever uses a freshly-issued
// token once right after the OAuth callback, this token gets reused across
// however long it's been since Henry last authorized, so it needs to
// actually handle expiry rather than assume the access token is still
// good. Throws if there's no owner authorization on file yet.
async function getValidOwnerAccessToken() {
  let tokens = getSpotifyTokens(spotifyOAuth.OWNER_KEY);
  if (!tokens) {
    throw new Error('No Spotify owner authorization on file yet — visit GET /api/spotify-auth-start?owner=1&admin_token=<ADMIN_TOKEN> first.');
  }
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 5000) {
    if (!tokens.refreshToken) {
      throw new Error('Owner Spotify token expired and no refresh token was stored — re-authorize via /api/spotify-auth-start?owner=1.');
    }
    const refreshed = await spotifyOAuth.refreshAccessToken(tokens.refreshToken);
    tokens = {
      accessToken: refreshed.access_token,
      // Spotify doesn't always rotate the refresh token on a refresh call —
      // keep the existing one when it doesn't.
      refreshToken: refreshed.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
    setSpotifyTokens(spotifyOAuth.OWNER_KEY, tokens);
  }
  return tokens.accessToken;
}

// Rebuilds the cached "genre -> candidate tracks" catalog musicLoversFlow.js
// sends from (see store.js's topTracksCatalog / pickTrackForGenre), sourced
// from Henry's own last-4-weeks Top Tracks (per his own instruction: match
// the selected genre against his *recent* listening, not a one-time static
// pick) — see spotifyOAuth.js's getTopTracksBucketedByGenre for the actual
// per-track genre bucketing. Call this once after the owner authorizes
// (above), and again any time Henry wants the catalog to reflect his
// current listening. Writes every one of musicLoversConfig.GENRES, even
// ones that got zero matches this run, so a genre that drops out of his
// recent listening correctly falls back to the static TRACK_CATALOG entry
// instead of serving a stale pick from a previous refresh.
//
// Also resolves a YouTube video id for each genre's picked (top) track via
// lib/youtubeApi.js — Spotify has no YouTube mapping of its own, so this is
// what keeps the "Watch on Youtube" button correct automatically as Henry's
// Top Tracks change, instead of needing a manual video-ID lookup after every
// refresh (Henry's own request). Only the picked track per genre is looked
// up, not every candidate, to keep this to one YouTube API call per genre
// (6 total) per refresh. A failed/skipped lookup (e.g. YOUTUBE_API_KEY not
// set yet) leaves that track's youtubeVideoId unset here, and
// pickTrackForGenre in musicLoversFlow.js falls back to the static
// TRACK_CATALOG's placeholder for that field in that case.
app.get('/admin/music-lovers/refresh-top-tracks-catalog', requireAdminToken, async (req, res) => {
  try {
    const musicConfig = require('./lib/musicLoversConfig');
    const accessToken = await getValidOwnerAccessToken();
    const byGenre = await spotifyOAuth.getTopTracksBucketedByGenre(accessToken, 'short_term');
    const summary = {};
    for (const genre of musicConfig.GENRES) {
      const tracks = byGenre[genre] || [];
      const top = tracks[0] || null;
      if (top) {
        top.youtubeVideoId = await searchVideoId(`${top.artist} - ${top.title}`);
      }
      setTopTracksCatalogForGenre(genre, { tracks });
      summary[genre] = {
        matchCount: tracks.length,
        picked: top,
        usingFallback: tracks.length === 0,
      };
    }
    logEvent('inbound', `Music Lovers top-tracks catalog refreshed (${Object.values(summary).filter((s) => !s.usingFallback).length}/${musicConfig.GENRES.length} genres matched)`);
    res.status(200).json({ timeRange: 'short_term (~last 4 weeks)', refreshedAt: new Date().toISOString(), genres: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read-only view of whatever /admin/music-lovers/refresh-top-tracks-catalog
// last built, without triggering a new Spotify fetch — useful for checking
// what's currently live without spending another refresh.
app.get('/admin/music-lovers/top-tracks-catalog', requireAdminToken, (req, res) => {
  res.status(200).json({ genres: getAllTopTracksCatalog() });
});

// --- Feedback form (bottom of demo.html — visitor comment/question,
// optional photo/video attachments, notified to henryauthier@gmail.com) ---
app.options('/api/feedback', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});
app.post('/api/feedback', feedbackLimiter, (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  feedbackUpload.array('files', 8)(req, res, async (err) => {
    if (err) {
      // Covers both multer's own per-file-size/count limits and the
      // fileFilter rejection above — either way this is a 400 (the
      // visitor's request was invalid), not a 500.
      res.status(400).json({ error: err.message });
      return;
    }
    try {
      const { name, email, message, demoLabel } = req.body || {};
      if (!isValidEmail(email)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }
      const files = req.files || [];
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > FEEDBACK_MAX_TOTAL_BYTES) {
        res.status(400).json({
          error: `Attachments are too large (${(totalBytes / 1024 / 1024).toFixed(1)}MB) — please keep the total under 15MB.`,
        });
        return;
      }
      await sendFeedbackEmail({ name, email, message, demoLabel, files });
      logEvent('inbound', `Feedback form submission from ${email}${files.length ? ` with ${files.length} attachment(s)` : ''}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/feedback error:', err.message);
      res.status(500).json({ error: 'Sorry, something went wrong sending your message. Please try again shortly.' });
    }
  });
});

// --- Spotify tester access request (music-lovers.html's Spotify Connect
// block) — the app is in Spotify's Development Mode, so only accounts
// Henry has manually added under its dashboard's User Management tab can
// complete that OAuth flow (see lib/spotifyOAuth.js). Fired alongside the
// actual connect attempt (client-side, via fetch with keepalive so it
// survives the redirect to /api/spotify-auth-start right after) — this is
// how an unknown visitor's email actually reaches Henry, since there's no
// public Spotify API to add a tester automatically. ---
app.options('/api/spotify-tester-request', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});
app.post('/api/spotify-tester-request', spotifyTesterLimiter, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const email = String(req.body?.email || '').trim();
    const rawPhone = String(req.body?.phone || '').trim();
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'A valid email address is required.' });
      return;
    }
    const phone = rawPhone ? normalizeToE164(rawPhone, config.RCS_DEEPLINK_COUNTRY).replace(/^\+/, '') : '';
    await sendSpotifyTesterRequestEmail({ name, email, phone });
    logEvent('inbound', `Spotify tester access requested by ${email}${phone ? ` (${redactPhone(phone)})` : ''}`);
    res.status(200).json({ status: 'received' });
  } catch (err) {
    console.error('POST /api/spotify-tester-request error:', err.message);
    // Deliberately still 500s the visitor (rather than pretending success)
    // if GMAIL_USER/GMAIL_APP_PASSWORD aren't set yet — same reasoning as
    // /api/feedback above. The frontend swallows this either way (it's a
    // fire-and-forget alongside the real connect attempt), but Render's
    // logs need the real failure reason.
    res.status(500).json({ error: 'Sorry, something went wrong requesting access. Please try again shortly.' });
  }
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
// Hydrate store.js's Maps from Redis (if REDIS_URL is set) before accepting
// any webhook, so a restart never serves a request against half-restored
// state. Starts listening either way — a Redis hiccup falls back to
// in-memory-only rather than blocking the server from coming up at all.
initStore()
  .catch((err) => {
    console.error('Store: initStore() failed, starting with in-memory state only:', err.message);
  })
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Vonage Estate server listening on port ${PORT}`);
    });
  });
