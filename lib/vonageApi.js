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
// prefilledMessage / fallbackNumber are both optional per Vonage's own
// docs (developer.vonage.com/en/api/channel-manager#RCS-Deeplinks) —
// prefilledMessage populates the RCS chat's compose box the same way the
// hand-built sms:...?body= fallback does, up to 3072 chars; callers are
// expected to have already truncated to that limit.
async function generateRcsDeeplink({ senderId, country, prefilledMessage, fallbackNumber }) {
  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('VONAGE_API_KEY / VONAGE_API_SECRET not set — required for the Channel Manager RCS deeplink endpoint (separate from the Application JWT credentials).');
  }
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  const body = { sender_id: senderId, country };
  if (prefilledMessage) body.prefilled_message = prefilledMessage;
  if (fallbackNumber) body.fallback_number = fallbackNumber;

  const res = await fetch('https://api.nexmo.com/v1/channel-manager/rcs/deeplink/generate', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Vonage Channel Manager RCS deeplink error', res.status, JSON.stringify(json));
  } else {
    console.log('Vonage Channel Manager RCS deeplink response:', JSON.stringify(json));
  }
  return { ok: res.ok, status: res.status, json };
}

// Registers a phone number as an allow-listed test device on an RCS agent
// that hasn't finished carrier/Google launch review yet — required for
// anyone but Vonage's own test numbers to actually open a chat with it
// (the deep link itself works regardless; Google Messages just refuses the
// conversation for non-test numbers on an unlaunched agent). Same Basic
// auth as generateRcsDeeplink. Request body field names aren't confirmed
// against Vonage's docs (couldn't retrieve that page) — if this 4xxs with
// an invalid_parameters response (same shape the deeplink endpoint used to
// tell us "sender_id" needed to change), the raw response will say exactly
// which field name is wrong.
async function addRcsTestDevice({ agentId, phoneNumber, country }) {
  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('VONAGE_API_KEY / VONAGE_API_SECRET not set.');
  }
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  const res = await fetch(`https://api.nexmo.com/v1/channel-manager/rcs/agents/${encodeURIComponent(agentId)}/test-devices`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    // Confirmed via a live 400 response: the field is "phone", not
    // "phone_number" (unlike other Channel Manager endpoints).
    body: JSON.stringify({ phone: phoneNumber, country }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Vonage add RCS test device error', res.status, JSON.stringify(json));
  } else {
    console.log('Vonage add RCS test device response:', JSON.stringify(json));
  }
  return { ok: res.ok, status: res.status, json };
}

// Debug helper — lists RCS agents on the account, so we can find the real
// internal agent_id the test-devices endpoint wants (it rejected the
// human-readable sender_id "henry_rcs_demo3" with "RCS Wizard Not Found").
async function listRcsAgents() {
  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('VONAGE_API_KEY / VONAGE_API_SECRET not set.');
  }
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const res = await fetch('https://api.nexmo.com/v1/channel-manager/rcs/agents', {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

module.exports = { sendVonageMessage, createVonageCall, generateRcsDeeplink, addRcsTestDevice, listRcsAgents };
