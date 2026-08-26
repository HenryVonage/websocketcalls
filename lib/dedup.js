// Guards inbound message webhooks against duplicate delivery. Observed on
// the RCS demo: the same tap (e.g. "L1234") sometimes arrives as two
// separate webhook POSTs a couple of seconds apart, causing the full
// reply (cards, text, etc.) to be sent twice. Root cause not fully
// pinned down (client-side double-send vs. a retried webhook delivery),
// but deduping by Vonage's message_uuid is the standard, safe fix either
// way — same message_uuid means "already handled this one."
//
// In-memory only (bounded ring buffer, not a Set with TTL) — good enough
// for a demo; doesn't need to survive restarts.
const MAX_SEEN = 500;
const seenIds = [];
const seenSet = new Set();

function isDuplicateMessage(id) {
  if (!id) return false; // nothing to key on — let it through rather than block everything
  if (seenSet.has(id)) return true;
  seenSet.add(id);
  seenIds.push(id);
  if (seenIds.length > MAX_SEEN) {
    const oldest = seenIds.shift();
    seenSet.delete(oldest);
  }
  return false;
}

module.exports = { isDuplicateMessage };
