const { generateVonageJwt } = require('./vonageJwt');

// Sends a Messages API payload (WhatsApp text/template/interactive/etc).
async function sendVonageMessage(payload) {
  const res = await fetch('https://api.nexmo.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${generateVonageJwt()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Vonage Messages API error', res.status, text, 'Payload was:', JSON.stringify(payload));
  }
  return res;
}

// Places an outbound call. `ncco` is optional — if omitted, Vonage will
// call this Application's answer_url to fetch the NCCO instead (useful so
// every call, inbound or outbound, goes through the same connect->websocket
// path and the same /answer + /events logic).
//
// `type` defaults to 'whatsapp' (WhatsApp-channel calling, used by the
// WhatsApp demo's feedback-call flow). The RCS demo has no equivalent
// "calling within RCS" concept, so its feedback calls use type: 'phone'
// (standard PSTN) instead — see rcsFlow.js.
async function createVonageCall({ to, from, ncco, type = 'whatsapp' }) {
  const body = {
    to: [{ type, number: to }],
    from: { type, number: from },
  };
  if (ncco) body.ncco = ncco;

  const res = await fetch('https://api.nexmo.com/v1/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${generateVonageJwt()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Vonage Calls API error', res.status, JSON.stringify(json), 'Payload was:', JSON.stringify(body));
  }
  return json; // includes conversation_uuid, uuid, status on success
}

// Generates an RCS deep link via Vonage's Channel Manager API — the
// officially-supported way to produce a link that Android's native Camera /
// Google Messages will reliably recognize as an RBM agent invite, instead of
// hand-building the sms: URI ourselves (which worked in some scanner apps
// but not Android's native Camera — see rcsFlow.js / demo.html comments).
//
// Uses HTTP Basic auth with the account-level API key/secret (VONAGE_API_KEY
// / VONAGE_API_SECRET from the dashboard) — NOT the Application JWT used by
// every other call in this file. Response shape isn't documented publicly as
// of this writing, so callers should log the raw response the first time
// this runs against a real account and adjust field extraction if needed.
async function generateRcsDeeplink({ senderId, country }) {
  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('VONAGE_API_KEY / VONAGE_API_SECRET not set — required for the Channel Manager RCS deeplink endpoint (separate from the Application JWT credentials).');
  }
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  const res = await fetch('https://api.nexmo.com/v1/channel-manager/rcs/deeplink/generate', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ sender_id: senderId, country }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Vonage Channel Manager RCS deeplink error', res.status, JSON.stringify(json));
  } else {
    console.log('Vonage Channel Manager RCS deeplink response:', JSON.stringify(json));
  }
  return { ok: res.ok, status: res.status, json };
}

module.exports = { sendVonageMessage, createVonageCall, generateRcsDeeplink };
