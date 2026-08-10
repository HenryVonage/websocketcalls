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
async function createVonageCall({ to, from, ncco }) {
  const body = {
    to: [{ type: 'whatsapp', number: to }],
    from: { type: 'whatsapp', number: from },
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

module.exports = { sendVonageMessage, createVonageCall };
