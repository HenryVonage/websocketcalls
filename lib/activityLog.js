// Small in-memory ring buffer of redacted activity events, exposed publicly
// via GET /api/logs (see server.js). This exists because the Render
// dashboard logs require your own login — a demo visitor has no way to see
// those. This feed is deliberately public and redacted: phone numbers are
// masked, and nothing sensitive (private keys, API keys, full transcripts)
// is ever pushed here — just short human-readable event summaries.
const MAX_ENTRIES = 200;
const entries = [];

function redactPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.length <= 4) return '•••' + digits;
  return digits.slice(0, 3) + '•••' + digits.slice(-4);
}

function logEvent(type, message) {
  const entry = { ts: new Date().toISOString(), type, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  return entry;
}

function getRecentEvents() {
  return entries;
}

module.exports = { logEvent, redactPhone, getRecentEvents };
