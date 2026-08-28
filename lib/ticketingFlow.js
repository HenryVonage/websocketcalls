// 3rd demo: Ticketing, RCS-only. Reuses the exact same Vonage Application,
// RCS agent/sender and linked PSTN number as the Real Estate RCS demo (see
// businessConfig.js's TICKETING section) — this file only differs in the
// conversation content (ticketingEngine.js's system prompt) and the
// payloads it builds. Entered from rcsFlow.js once lib/demoRouter.js
// resolves an inbound RCS phone number to the 'ticketing' demo.
//
// Content/media ported from the "RCS _ MonteCarlo ticketing" Node-RED flow's
// own inject-node demo script (flows_24.json), played back in the same
// order it was recorded: priority-access invite -> order confirmation ->
// e-ticket -> one-week reminder -> day-of program -> in-seat food/merch
// order -> delivery method -> row/seat capture -> seat confirmation ->
// order placed -> post-event prize contest -> "you won!". The visitor's
// position in that journey is tracked deterministically here (see
// getTicketingState/setTicketingState in store.js) — Claude
// (ticketingEngine.js) only decides which marker fires each turn; this file
// decides what stage that marker moves the visitor to next, so the flow
// stays consistent turn over turn. Ticket-photo reading uses Claude's
// vision (ticketingEngine.js) instead of the original flow's Google
// Document AI call, per MonteCarlo_AI_Workflow_Guide.pdf's redesign
// approach.
const config = require('./businessConfig');
const { sendVonageMessage } = require('./vonageApi');
const {
  getCallerName,
  setCallerName,
  setTicketFields,
  getTicketFields,
  getTicketingState,
  setTicketingState,
} = require('./store');
const { logEvent, redactPhone } = require('./activityLog');
const { decideTicketingMarker, extractTicketFieldsLine } = require('./ticketingEngine');
const { captureNameFromGreeting } = require('./nameCapture');

const T = config.TICKETING;
const FROM = config.RCS_AGENT_ID; // same RCS agent as the Real Estate demo, by design

function findProduct(id) {
  return T.PRODUCTS.find((p) => p.id === id);
}

function extractFields(body) {
  const messageType = body.message_type ?? 'text';
  const replyId = body.reply?.id;
  const textMessage = replyId || body.button?.payload || body.button?.text || body.text || 'Hello';

  // RCS/Messages API inbound media shape — mirrors the outbound shapes
  // already used elsewhere in this codebase (image.url / file.url).
  const mediaUrl = body.image?.url ?? body.file?.url ?? '';
  const mediaCaption = body.image?.caption ?? body.file?.caption ?? '';
  const isPdf = /\.pdf(\?|$)/i.test(mediaUrl) || body.file?.mime_type === 'application/pdf';

  return {
    clientPhone: body.from ?? '',
    messageType,
    messageText: messageType === 'image' || messageType === 'file' ? mediaCaption || 'Uploaded ticket' : textMessage,
    mediaUrl,
    mediaMimeType: isPdf ? 'application/pdf' : 'image/jpeg',
    userName: getCallerName(body.from) || 'Client',
  };
}

async function downloadAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

// The very first outbound a visitor ever sees for this demo — sent
// deterministically (no Claude call) the moment a phone number's ticketing
// conversation starts, so its wording never depends on the model
// classifying a greeting correctly. Mirrors the Node-RED flow's
// "ticketing1" inject node ("Ticketing exclusive priority").
function buildPriorityCard(userName) {
  return {
    from: FROM, channel: 'rcs', message_type: 'card',
    card: {
      title: 'Ticketing exclusive priority',
      text: `Dear ${userName}, you were one of our loyal visitors during last year's ${T.EVENT_NAME} and, thanks to you and so many other spectators, the tournament was an unprecedented success.\n\nTo reserve your tickets for this year's ${T.EVENT_NAME}, we're pleased to offer you exclusive priority access to our website — before anyone else!`,
      media_url: T.WELCOME_IMAGE_URL,
      media_height: 'TALL',
      suggestions: [
        { type: 'open_url', text: 'Online ticketing', postback_data: 'online_ticketing', url: T.TICKETING_SITE_URL, description: 'The official Rolex Monte-Carlo Masters ticketing website' },
        { type: 'dial', text: 'Call', postback_data: 'call_us', phone_number: `+${config.RCS_PSTN_NUMBER}` },
        { type: 'open_url', text: 'Info', postback_data: 'info', url: T.INFO_URL, description: 'Rolex Monte-Carlo Masters tournament information page' },
      ],
    },
    rcs: { card_orientation: 'VERTICAL' },
  };
}

// Turns Claude's marker output into the actual RCS payload(s) to send.
// `state` (this visitor's current getTicketingState()) is only consulted as
// a fallback for the product id — every stage-advancing marker is expected
// to carry it directly (see ticketingEngine.js's SYSTEM_PROMPT), but a
// fallback keeps a single dropped/malformed marker from derailing the order.
function buildPayloads(output, fields, state = {}) {
  const { clientPhone, userName } = fields;
  const base = { from: FROM, to: clientPhone, channel: 'rcs' };

  if (output.includes('[T_TICKET_ORDER_CONFIRM]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'Order confirmation',
        text: `Dear ${userName}, thank you for your order! We can't wait to welcome you at ${T.EVENT_NAME}. Want your tickets sent straight to this chat?`,
        media_url: T.WELCOME_IMAGE_URL,
        media_height: 'TALL',
        suggestions: [
          { type: 'open_url', text: 'Download the App', postback_data: 'download_app', url: T.APP_URL, description: 'The Rolex Monte-Carlo Masters mobile app' },
          { type: 'reply', text: 'Get my tickets by message', postback_data: 'Get my tickets by message' },
          { type: 'reply', text: 'Other question', postback_data: 'Other question' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[T_SEND_TICKET]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'Your e-ticket',
        text: `Find your ticket attached, ${userName}. You can also download our app. Don't hesitate to reach out if you have any questions!`,
        media_url: T.SAMPLE_ETICKET_IMAGE_URL,
        media_height: 'TALL',
        suggestions: [
          { type: 'open_url', text: 'Download the App', postback_data: 'download_app', url: T.APP_URL, description: 'The Rolex Monte-Carlo Masters mobile app' },
          { type: 'reply', text: 'Continue ▶', postback_data: 'Continue' },
          { type: 'reply', text: 'Other question', postback_data: 'Other question' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[T_ONE_WEEK]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'One week to go!',
        text: `Hi ${userName}, only one week to go before ${T.EVENT_NAME} begins! We hope you're as excited as we are 🤩\n\nFind the site map attached, plus the shuttle service running during the event.\n\nRemember: in-seat delivery lets you order snacks and merch straight to your seat, or collect with no queue.`,
        media_url: T.MAP_IMAGE_URL,
        media_height: 'TALL',
        suggestions: [
          { type: 'open_url', text: 'Shuttle service', postback_data: 'shuttle', url: T.SHUTTLE_INFO_URL, description: 'Shuttle service information for the venue' },
          { type: 'reply', text: 'Continue ▶', postback_data: 'Continue' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[T_DDAY]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'Program of the day',
        text: `This is the big day, ${userName}! Find today's program attached, along with the new interactive services to make the most of your visit.`,
        media_url: T.DAY_PROGRAM_IMAGE_URL,
        media_height: 'TALL',
        suggestions: [
          { type: 'reply', text: 'In-seat delivery!', postback_data: 'In-seat delivery!' },
          { type: 'reply', text: 'Live score', postback_data: 'Live score' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[T_PRODUCT_LIST]')) {
    // One standalone card per item, sent in sequence — the same "card"
    // message_type already confirmed working for the Real Estate demo's
    // [PRODUCT_LIST] (see rcsFlow.js), rather than the original flow's
    // carouselCard envelope, which this codebase has not yet confirmed
    // against a live RCS send.
    return T.PRODUCTS.map((p) => ({
      ...base, message_type: 'card',
      card: {
        title: `${p.name} — ${p.price}`,
        text: 'Tap to order this for in-seat delivery or stand collection.',
        media_url: p.imageUrl,
        media_height: 'MEDIUM',
        suggestions: [{ type: 'reply', text: p.name, postback_data: p.name }],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }));
  }

  const deliveryMatch = output.match(/\[T_DELIVERY_METHOD:\s*([^\]]+)\]/);
  if (deliveryMatch) {
    const id = deliveryMatch[1].trim() || state.productId;
    const product = findProduct(id);
    const name = product?.name || 'your order';
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'Delivering your order',
        text: `Could you confirm how you'd like ${name} delivered?`,
        media_url: T.DELIVERY_METHOD_IMAGE_URL,
        media_height: 'MEDIUM',
        suggestions: [
          { type: 'reply', text: 'In-seat delivery', postback_data: 'In-seat delivery' },
          { type: 'reply', text: 'Collect at the stand', postback_data: 'Collect at the stand' },
          { type: 'reply', text: 'Cancel my order', postback_data: 'Cancel my order' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  const seatRequestMatch = output.match(/\[T_SEAT_REQUEST:\s*([^\]]+)\]/);
  if (seatRequestMatch) {
    const id = seatRequestMatch[1].trim() || state.productId;
    const product = findProduct(id);
    const name = product?.name || 'your order';
    return [{
      ...base, message_type: 'text',
      text: `Great choice, ${userName}! To deliver ${name} to your seat, tell me your row and seat number — or upload a photo of your ticket and I'll read it for you.`,
    }];
  }

  const seatConfirmMatch = output.match(/\[T_SEAT_CONFIRM:\s*([^:\]]+):([^:\]]+):([^\]]+)\]/);
  if (seatConfirmMatch) {
    const row = seatConfirmMatch[2].trim();
    const seat = seatConfirmMatch[3].trim();
    return [{
      ...base, message_type: 'text',
      text: `Just to confirm — row ${row}, seat ${seat}. Is that correct?`,
      suggestions: [
        { type: 'reply', text: "Yes, that's correct", postback_data: 'Yes, that is correct' },
        { type: 'reply', text: 'No, let me fix it', postback_data: 'No, let me fix it' },
      ],
    }];
  }

  if (output.includes('[T_ORDER_CANCELLED]')) {
    return [{
      ...base, message_type: 'text',
      text: "No worries — your order has been cancelled. Let me know if you'd like to order something else!",
    }];
  }

  const orderMatch = output.match(/\[T_FOOD_ORDER_CONFIRM:\s*([^:\]]+):(in_seat|collect)\]/);
  if (orderMatch) {
    const id = orderMatch[1].trim() || state.productId;
    const product = findProduct(id);
    const name = product?.name || 'your order';
    const method = orderMatch[2];
    if (method === 'collect') {
      return [{
        ...base, message_type: 'text',
        text: `✅ Order confirmed — head to the nearest stand shown below to collect ${name}, no queue needed.`,
        suggestions: [
          { type: 'reply', text: 'Continue ▶', postback_data: 'Continue' },
          { type: 'reply', text: 'Other question', postback_data: 'Other question' },
        ],
      }, {
        ...base, message_type: 'image',
        image: { url: T.COLLECT_AT_STAND_IMAGE_URL },
      }];
    }
    return [{
      ...base, message_type: 'text',
      text: `✅ Done! ${name} will be delivered to your seat at the next players' changeover. Enjoy the match, ${userName}!`,
      suggestions: [
        { type: 'reply', text: 'Continue ▶', postback_data: 'Continue' },
        { type: 'reply', text: 'Other question', postback_data: 'Other question' },
      ],
    }];
  }

  if (output.includes('[T_VOICE_CALL]')) {
    return [{
      ...base, message_type: 'text',
      text: 'You can call us directly for faster service!',
      suggestions: [{ type: 'dial', text: 'Call us', postback_data: 'call_us', phone_number: `+${config.RCS_PSTN_NUMBER}` }],
    }];
  }

  if (output.includes('[T_REVIEW]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'Get a special prize',
        text: `Thanks for visiting ${T.EVENT_NAME}! Tag your favorite pictures on Instagram with ${T.INSTAGRAM_HASHTAG} for a chance to win tickets for next year 🎾`,
        media_url: T.WELCOME_IMAGE_URL,
        media_height: 'MEDIUM',
        suggestions: [{ type: 'reply', text: 'Posted it!', postback_data: 'Posted it!' }],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[T_WON]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'You won!',
        text: `🎉 Great news, ${userName}! Your photo was selected — you've won 2 tickets for next year's quarter-final! 🎾`,
        media_url: T.WINNER_IMAGE_URL,
        media_height: 'TALL',
        suggestions: [
          { type: 'open_url', text: 'How to receive my tickets', postback_data: 'how_to_receive', url: 'https://montecarlotennismasters.com/en/tickets/', description: 'Ticket delivery instructions for Rolex Monte-Carlo Masters' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  // Plain-text fallback — general Q&A answers (FAQ rule), the "live score"
  // one-liner, re-asks for row/seat, and the ticket upload confirmation
  // (already stripped of its TICKET_FIELDS line by processTicketingRcs
  // before reaching here).
  return [{ ...base, message_type: 'text', text: output }];
}

// Deterministic marker -> next-stage table. Claude only decides *which*
// marker fires (see ticketingEngine.js); this is what actually advances the
// visitor's position in the journey, so a single ambiguous model output
// can't skip or repeat a stage. Returns { stage, ...patch } — stage is null
// when the output wasn't a stage-advancing marker (FAQ text, a re-ask, the
// live-score one-liner, [T_VOICE_CALL], etc.), meaning the visitor stays on
// their current stage.
function computeNextState(output) {
  if (output.includes('[T_TICKET_ORDER_CONFIRM]')) return { stage: 'ORDER_CONFIRMED' };
  if (output.includes('[T_SEND_TICKET]')) return { stage: 'ETICKET_SENT' };
  if (output.includes('[T_ONE_WEEK]')) return { stage: 'ONE_WEEK_SENT' };
  if (output.includes('[T_DDAY]')) return { stage: 'DDAY_SENT' };
  if (output.includes('[T_PRODUCT_LIST]')) return { stage: 'BROWSING_PRODUCTS' };
  if (output.includes('[T_ORDER_CANCELLED]')) return { stage: 'DDAY_SENT' };
  if (output.includes('[T_REVIEW]')) return { stage: 'REVIEW_SENT' };
  if (output.includes('[T_WON]')) return { stage: 'CONTEST_WON' };

  const deliveryMatch = output.match(/\[T_DELIVERY_METHOD:\s*([^\]]+)\]/);
  if (deliveryMatch) return { stage: 'CHOOSING_DELIVERY', productId: deliveryMatch[1].trim() };

  const seatRequestMatch = output.match(/\[T_SEAT_REQUEST:\s*([^\]]+)\]/);
  if (seatRequestMatch) return { stage: 'AWAITING_SEAT', productId: seatRequestMatch[1].trim() };

  const seatConfirmMatch = output.match(/\[T_SEAT_CONFIRM:\s*([^:\]]+):([^:\]]+):([^\]]+)\]/);
  if (seatConfirmMatch) {
    return {
      stage: 'CONFIRMING_SEAT',
      productId: seatConfirmMatch[1].trim(),
      row: seatConfirmMatch[2].trim(),
      seat: seatConfirmMatch[3].trim(),
    };
  }

  const orderMatch = output.match(/\[T_FOOD_ORDER_CONFIRM:\s*([^:\]]+):(in_seat|collect)\]/);
  if (orderMatch) return { stage: 'ORDER_PLACED', productId: orderMatch[1].trim() };

  return { stage: null };
}

async function processTicketingRcs(fields) {
  const capturedName = captureNameFromGreeting(fields.messageText);
  if (capturedName) {
    setCallerName(fields.clientPhone, capturedName);
    fields.userName = capturedName;
  }

  const state = getTicketingState(fields.clientPhone);

  // First-ever contact for this phone number in this demo: always send the
  // "priority access" card, deterministically, with no Claude call. This is
  // the exact first outbound the recorded demo showed, so it must never
  // depend on the model classifying a greeting correctly.
  if (!state.stage) {
    const payload = buildPriorityCard(fields.userName);
    await sendVonageMessage({ ...payload, to: fields.clientPhone });
    logEvent('outbound', `Sent Ticketing RCS card "${payload.card.title}" to ${redactPhone(fields.clientPhone)}`);
    setTicketingState(fields.clientPhone, { stage: 'AWAITING_PURCHASE' });
    return;
  }

  if ((fields.messageType === 'image' || fields.messageType === 'file') && fields.mediaUrl) {
    try {
      fields.imageBase64 = await downloadAsBase64(fields.mediaUrl);
      fields.imageMediaType = fields.mediaMimeType;
    } catch (err) {
      console.error('Ticketing: failed to download uploaded ticket media:', err.message);
      logEvent('inbound', `Ticketing: could not download uploaded ticket from ${redactPhone(fields.clientPhone)}`);
    }
  }

  console.log('Ticketing inbound fields:', JSON.stringify({
    ...fields,
    imageBase64: fields.imageBase64 ? `<${fields.imageBase64.length} chars b64>` : undefined,
  }));
  logEvent('inbound', `Ticketing RCS message from ${redactPhone(fields.clientPhone)}: "${fields.messageText}"`);

  let output = await decideTicketingMarker(fields);
  console.log('Claude marker decision (Ticketing):', output);

  let ticketFieldsJustExtracted = null;
  if (output.includes('TICKET_FIELDS:')) {
    const parsed = extractTicketFieldsLine(output);
    output = parsed.text;
    if (parsed.fields) {
      ticketFieldsJustExtracted = setTicketFields(fields.clientPhone, parsed.fields);
    }
  }

  logEvent('decision', `Marker decision (Ticketing): ${output.length > 80 ? output.slice(0, 80) + '…' : output}`);

  const payloads = buildPayloads(output, fields, state);
  for (const payload of payloads) {
    await sendVonageMessage(payload);
    const kind = payload.message_type === 'card' ? `card "${payload.card.title}"` : payload.message_type;
    logEvent('outbound', `Sent Ticketing RCS ${kind} to ${redactPhone(fields.clientPhone)}`);
  }

  const next = computeNextState(output);
  if (next.stage) {
    const { stage, ...patch } = next;
    setTicketingState(fields.clientPhone, { stage, ...patch });
  }

  // Uploading a ticket photo while we're waiting on row/seat auto-completes
  // that step using whatever Claude could read off it, instead of making
  // the visitor retype what's already printed on their ticket — mirrors
  // step 8 of the recorded journey ("the user can also upload back his
  // ticket that allows retrieving that information").
  if (state.stage === 'AWAITING_SEAT' && ticketFieldsJustExtracted) {
    const row = ticketFieldsJustExtracted.Row || ticketFieldsJustExtracted.Grandstand || 'unknown';
    const seat = ticketFieldsJustExtracted.Seat || 'unknown';
    const productId = state.productId || 'your order';
    const confirmMarker = `[T_SEAT_CONFIRM: ${productId}:${row}:${seat}]`;
    const confirmPayloads = buildPayloads(confirmMarker, fields, state);
    for (const payload of confirmPayloads) {
      await sendVonageMessage(payload);
      logEvent('outbound', `Sent Ticketing RCS ${payload.message_type} to ${redactPhone(fields.clientPhone)}`);
    }
    setTicketingState(fields.clientPhone, { stage: 'CONFIRMING_SEAT', productId, row, seat });
  }
}

module.exports = { extractFields, buildPayloads, processTicketingRcs };
