const { generateVonageJwt } = require('./vonageJwt');
const { fetchWithTimeout } = require('./httpClient');

// Sends a Messages API payload (WhatsApp text/template/interactive/etc).
// Returns the parsed response body (on success, Vonage's { message_uuid }
// — needed by callers that want to correlate a later DLR webhook back to
// this specific send, e.g. ticketingWhatsappFlow.js's delivery-aware wait
// before its next message). No existing caller used the old raw Response
// return value (every call site just `await`s this for its side effect),
// so this is a safe, backward-compatible change.
async function sendVonageMessage(payload) {
  const res = await fetchWithTimeout('https://api.nexmo.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${generateVonageJwt()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Vonage Messages API error', res.status, JSON.stringify(json), 'Payload was:', JSON.stringify(payload));
  }
  return json;
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

  const res = await fetchWithTimeout('https://api.nexmo.com/v1/calls', {
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

  const res = await fetchWithTimeout('https://api.nexmo.com/v1/channel-manager/rcs/deeplink/generate', {
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

  const res = await fetchWithTimeout(`https://api.nexmo.com/v1/channel-manager/rcs/agents/${encodeURIComponent(agentId)}/test-devices`, {
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
  const res = await fetchWithTimeout('https://api.nexmo.com/v1/channel-manager/rcs/agents', {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// NOTE (Sept 2026, corrected): despite the comment this originally shipped
// with, Henry confirmed this is NOT a signal of RCS-test-agent tester
// status — it's Vonage's device/carrier RCS-capability probe (effectively
// "can this OS+network support RCS at all", the same thing Google's own
// device-capability check reports), independent of whether a number is on
// THIS agent's tester list or has accepted its invite. Using it to gate
// the demo's QR code would have shown the code as soon as a device merely
// supported RCS, before the tester invite was ever accepted — the exact
// dead-scan bug this was meant to prevent. getRcsTestDevices below (the
// real v2 tester-list endpoint, confirmed with a live per-tester `status`
// field) is what actually answers "has this number accepted becoming a
// tester" — see server.js's /api/rcs-test-device/status. Left in place
// only in case a genuine device-capability question comes up later.
//
// Checks whether a specific number can actually be reached over RCS by a
// given agent, per Vonage's device capability check (developer.vonage.com/
// en/messages/guides/rcs/rcs-device-capability-check). Unlike
// addRcsTestDevice/listRcsAgents (account-level Basic auth), this is an
// Application-scoped endpoint per Vonage's docs, so it uses the same JWT
// bearer auth as sendVonageMessage/createVonageCall. `senderId` is the
// human-readable sender_id (RCS_AGENT_SENDER_ID, e.g. "henry_rcs_demo3")
// per Vonage's own example — NOT the internal RCS_AGENT_ID_CM uuid the
// test-devices endpoints need.
async function checkRcsDeviceCapability({ senderId, phoneNumber, country }) {
  const msisdn = String(phoneNumber || '').replace(/[^\d]/g, ''); // docs want no "+" prefix
  const res = await fetchWithTimeout(
    `https://api.nexmo.com/v1/channel-manager/rcs/agents/${encodeURIComponent(senderId)}/devices/capabilities`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${generateVonageJwt()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ country, msisdn }),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Vonage RCS device capability check error', res.status, JSON.stringify(json));
  } else {
    console.log('Vonage RCS device capability check response:', JSON.stringify(json));
  }
  return { ok: res.ok, status: res.status, json };
}

// Lists every test device currently registered on an RCS agent, each with
// its real per-tester onboarding status — the actual answer to "has this
// number accepted becoming a tester", found by testing the endpoint live
// (Sept 2026) after checkRcsDeviceCapability above turned out to be the
// wrong signal entirely, and after the only other lead (a guide page's
// AI-summarized description of a GET .../test-devices call) couldn't be
// confirmed against Vonage's actual API reference either. Henry hit this
// directly with curl against our real agent and got back:
//   { "testers": [ { "id": "447463223250", "phone": "+447463223250",
//                     "status": "ACCEPTED" }, ... ] }
// `status` has only been observed as "ACCEPTED" so far (every tester on
// the account had already completed onboarding) — a freshly-registered,
// not-yet-accepted number's status value hasn't been confirmed yet, so
// server.js treats anything other than an "ACCEPTED" match (including no
// match at all) as not ready, rather than assuming a specific "PENDING"
// string. Same v2 path + Basic auth as addRcsTestDevice, just GET instead
// of POST.
async function getRcsTestDevices({ agentId }) {
  const apiKey = process.env.VONAGE_API_KEY;
  const apiSecret = process.env.VONAGE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('VONAGE_API_KEY / VONAGE_API_SECRET not set.');
  }
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const res = await fetchWithTimeout(`https://api.nexmo.com/v2/channel-manager/rcs/agents/${encodeURIComponent(agentId)}/test-devices`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Vonage list RCS test devices error', res.status, JSON.stringify(json));
  }
  return { ok: res.ok, status: res.status, json };
}

module.exports = {
  sendVonageMessage,
  createVonageCall,
  generateRcsDeeplink,
  addRcsTestDevice,
  listRcsAgents,
  checkRcsDeviceCapability,
  getRcsTestDevices,
};
