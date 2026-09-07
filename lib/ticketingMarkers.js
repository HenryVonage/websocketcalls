// Shared building blocks for the Ticketing demo's Claude-marker parsing —
// both channels (ticketingFlow.js/RCS, ticketingWhatsappFlow.js/WhatsApp)
// need to recognize exactly the same marker syntax Claude was told to
// output (ticketingEngine.js's system prompt), and previously each kept
// its own literal copy of every regex (twice per file — once in
// buildPayloads, once in computeNextState — so four copies total), plus
// an identical findProduct()/downloadAsBase64() pair. A marker syntax
// change needed four coordinated edits; centralized here instead, as a
// single source of truth used identically (same match()-array semantics)
// at every call site, so this changes nothing about existing behavior —
// only where it lives.
const config = require('./businessConfig');
const { fetchWithTimeout } = require('./httpClient');

const T = config.TICKETING;

const MARKERS = {
  T_DELIVERY_METHOD: /\[T_DELIVERY_METHOD:\s*([^\]]+)\]/,
  T_SEAT_REQUEST: /\[T_SEAT_REQUEST:\s*([^\]]+)\]/,
  T_SEAT_CONFIRM: /\[T_SEAT_CONFIRM:\s*([^:\]]+):([^:\]]+):([^\]]+)\]/,
  T_FOOD_ORDER_CONFIRM: /\[T_FOOD_ORDER_CONFIRM:\s*([^:\]]+):(in_seat|collect)\]/,
};

function findProduct(id) {
  return T.PRODUCTS.find((p) => p.id === id);
}

// Downloads a ticket photo/PDF (RCS media_url or WhatsApp mediaUrl) and
// returns it as a base64 string for Claude's vision — identical in both
// channel files before this extraction. Now goes through fetchWithTimeout
// (lib/httpClient.js) like every other outbound fetch in the codebase,
// which the original duplicated copies predated.
async function downloadAsBase64(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

module.exports = { MARKERS, findProduct, downloadAsBase64 };
