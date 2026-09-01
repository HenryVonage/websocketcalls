// Lets a sender await a specific outbound WhatsApp message's actual
// delivery to the recipient's device, instead of guessing a fixed pause.
//
// Why this exists: ticketingWhatsappFlow.js originally paused 4 seconds
// after *sending* the priority-access template before sending the order-
// confirmation template, intending a 4-second gap between the two
// messages as Henry experiences them on his phone. In practice a template
// with an image/document header isn't delivered the instant Vonage
// accepts the send — WhatsApp has to fetch and process that media first —
// confirmed live via Render's DLR logs: one send was "submitted" ~4.7s
// before its "delivered" DLR arrived. Since the second message (also with
// an image header, but sent later once the first header image was likely
// already cached) delivered much faster, the fixed 4s pause from send-time
// ate into that leftover media-fetch delay and the two messages ended up
// arriving only ~1-2 seconds apart — reported twice as "no delay at all".
//
// Fix: wait for message 1's own "delivered" DLR (see lib/dlrHandler.js),
// THEN pause the desired gap, so the gap is measured between actual
// arrivals, not between our two outbound API calls. A timeout fallback
// guards against a DLR that never arrives (network hiccup, Vonage not
// sending one, etc.) so this can never hang a request forever.
const pending = new Map(); // messageUuid -> [resolve, ...]

function notifyDelivered(messageUuid) {
  if (!messageUuid) return;
  const resolvers = pending.get(messageUuid);
  if (!resolvers) return;
  pending.delete(messageUuid);
  for (const resolve of resolvers) resolve();
}

function waitForDelivery(messageUuid, timeoutMs = 15000) {
  if (!messageUuid) return Promise.resolve();
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const list = pending.get(messageUuid) || [];
    list.push(done);
    pending.set(messageUuid, list);
    setTimeout(done, timeoutMs);
  });
}

module.exports = { notifyDelivered, waitForDelivery };
