// Small in-memory ring buffer of redacted activity events, exposed publicly
// via GET /api/logs (see server.js). This exists because the Render
// dashboard logs require your own login — a demo visitor has no way to see
// those. This feed is deliberately public and redacted: phone numbers are
// masked in every message string, and nothing sensitive (private keys, API
// keys, full transcripts) is ever pushed here — just short human-readable
// event summaries.
//
// Sept 2026 (Henry): the feed used to return every visitor's activity to
// anyone who opened the Logs page — fine for redacted phone digits, but it
// also meant a stranger could watch every OTHER visitor's genre picks,
// matched tracks, and call events live, not just their own. logEvent() now
// takes an optional raw `phone` alongside the already-redacted message, kept
// ONLY in this in-memory buffer for server-side filtering — it is never
// serialized back out (getEventsForPhone/getAllEventsForAdmin both strip it
// before returning). /api/logs now requires either the visitor's own phone
// (returns only that number's events) or the site's ADMIN_TOKEN (returns
// everything, redacted, same as before) — see server.js.
//
// This is still "know the number, see the log" rather than real per-visitor
// auth (nothing verifies the caller actually owns that phone) — acceptable
// for a pre-sales demo tool, not a substitute for real auth if this pattern
// is ever reused somewhere that matters more.
const MAX_ENTRIES = 200;
const entries = [];

function redactPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.length <= 4) return '•••' + digits;
  return digits.slice(0, 3) + '•••' + digits.slice(-4);
}

// Normalizes to bare digits for comparison only (no country-code smarts
// here — that already happened upstream via normalizeToE164 wherever a
// visitor's number was first captured). Strips everything but digits so
// "+44 7441 443052", "447441443052", and "44 7441 443052" all compare equal.
function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function logEvent(type, message, phone) {
  const entry = { ts: new Date().toISOString(), type, message, phone: phone ? digitsOnly(phone) : '' };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  return entry;
}

function stripPhone({ ts, type, message }) {
  return { ts, type, message };
}

// Public (unauthenticated) view of a single visitor's own activity — exact
// match against the digits-only phone they supplied. Events with no phone
// attached (system-level entries like a catalog refresh or a feedback-form
// submission by email) never match here; they're admin-only.
function getEventsForPhone(phone) {
  const target = digitsOnly(phone);
  if (!target) return [];
  return entries.filter((e) => e.phone && e.phone === target).map(stripPhone);
}

// Admin-only view (gated by ADMIN_TOKEN in server.js) — everything, still
// redacted (message text already has phone digits masked at the point each
// logEvent() call was made; this just never exposes the raw `phone` field
// stored alongside it for filtering).
function getAllEventsForAdmin() {
  return entries.map(stripPhone);
}

// Kept for any other internal caller that genuinely wants the full raw
// entries (none currently outside this module/tests) — not used by the
// public API.
function getRecentEvents() {
  return entries;
}

module.exports = { logEvent, redactPhone, getRecentEvents, getEventsForPhone, getAllEventsForAdmin };
