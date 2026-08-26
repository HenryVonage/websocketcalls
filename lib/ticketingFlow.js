// 3rd demo: Ticketing, RCS-only. Reuses the exact same Vonage Application,
// RCS agent/sender and linked PSTN number as the Real Estate RCS demo (see
// businessConfig.js's TICKETING section) — this file only differs in the
// conversation content (ticketingEngine.js's system prompt) and the
// payloads it builds. Entered from rcsFlow.js once lib/demoRouter.js
// resolves an inbound RCS phone number to the 'ticketing' demo.
//
// Content/media ported from the "RCS _ MonteCarlo ticketing" Node-RED flow;
// ticket-photo reading uses Claude's vision (ticketingEngine.js) instead of
// that flow's Google Document AI call, per MonteCarlo_AI_Workflow_Guide.pdf's
// redesign approach.
const config = require('./businessConfig');
const { sendVonageMessage } = require('./vonageApi');
const { getCallerName, setCallerName, setTicketFields } = require('./store');
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

function buildPayloads(output, fields) {
  const { clientPhone, userName } = fields;
  const base = { from: FROM, to: clientPhone, channel: 'rcs' };

  if (output.includes('[T_WELCOME]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: `Welcome to ${T.EVENT_NAME}`,
        text: `Hi ${userName}! I can help with your ticket, in-seat food & merch orders, and everything else about your visit. What would you like to do?`,
        media_url: T.WELCOME_IMAGE_URL,
        media_height: 'MEDIUM',
        suggestions: [
          { type: 'reply', text: 'Order food/merch', postback_data: 'Order food/merch' },
          { type: 'reply', text: 'My ticket', postback_data: 'My ticket' },
          { type: 'reply', text: "Today's schedule", postback_data: "Today's schedule" },
          { type: 'dial', text: 'Contact us', postback_data: 'call_us', phone_number: `+${config.RCS_PSTN_NUMBER}` },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[T_PRODUCT_LIST]')) {
    // One standalone card per item, sent in sequence — the same
    // "card" message_type already confirmed working for the Real Estate
    // demo's [PRODUCT_LIST] (see rcsFlow.js), rather than the original
    // flow's carouselCard envelope, which this codebase has not yet
    // confirmed against a live RCS send. Swap for a true carousel once
    // that's verified, if the 4 separate cards feel too heavy.
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
    const product = findProduct(deliveryMatch[1].trim());
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

  const orderMatch = output.match(/\[T_ORDER_CONFIRM:\s*([^:\]]+):(in_seat|collect)\]/);
  if (orderMatch) {
    const product = findProduct(orderMatch[1].trim());
    const name = product?.name || 'your order';
    const method = orderMatch[2];
    if (method === 'collect') {
      return [{
        ...base, message_type: 'text',
        text: `✅ Order confirmed — head to the nearest stand shown below to collect ${name}, no queue needed.`,
        suggestions: [{ type: 'reply', text: 'Other question', postback_data: 'Other question' }],
      }, {
        ...base, message_type: 'image',
        image: { url: T.COLLECT_AT_STAND_IMAGE_URL },
      }];
    }
    return [{
      ...base, message_type: 'text',
      text: `✅ Done! ${name} will be delivered to your seat at the next players' changeover. Enjoy the match, ${userName}!`,
      suggestions: [{ type: 'reply', text: 'Other question', postback_data: 'Other question' }],
    }];
  }

  if (output.includes('[T_SEND_TICKET]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'Your e-ticket',
        text: `Find your ticket attached, ${userName}. You can also download our app. Let us know if you have any questions!`,
        media_url: T.SAMPLE_ETICKET_IMAGE_URL,
        media_height: 'TALL',
        suggestions: [
          { type: 'open_url', text: 'Download the App', postback_data: 'download_app', url: T.APP_URL },
          { type: 'reply', text: 'Other question', postback_data: 'Other question' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[T_VOICE_CALL]')) {
    return [{
      ...base, message_type: 'text',
      text: 'You can call us directly for faster service!',
      suggestions: [{ type: 'dial', text: 'Call us', postback_data: 'call_us', phone_number: `+${config.RCS_PSTN_NUMBER}` }],
    }];
  }

  if (output.includes('[T_REMINDER]')) {
    return [{
      ...base, message_type: 'card',
      card: {
        title: 'Program of the day',
        text: "Find the site map attached, plus the shuttle service running during the event. Don't forget in-seat delivery is available!",
        media_url: T.MAP_IMAGE_URL,
        media_height: 'TALL',
        suggestions: [
          { type: 'open_url', text: 'Shuttle service', postback_data: 'shuttle', url: T.SHUTTLE_INFO_URL },
          { type: 'reply', text: 'Order food/merch', postback_data: 'Order food/merch' },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
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

  // Plain-text fallback — general Q&A answers (STEP 11) and the ticket
  // upload confirmation (STEP 2, already stripped of its TICKET_FIELDS
  // line by processTicketingRcs before reaching here).
  return [{ ...base, message_type: 'text', text: output }];
}

async function processTicketingRcs(fields) {
  const capturedName = captureNameFromGreeting(fields.messageText);
  if (capturedName) {
    setCallerName(fields.clientPhone, capturedName);
    fields.userName = capturedName;
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

  if (output.includes('TICKET_FIELDS:')) {
    const parsed = extractTicketFieldsLine(output);
    output = parsed.text;
    if (parsed.fields) setTicketFields(fields.clientPhone, parsed.fields);
  }

  logEvent('decision', `Marker decision (Ticketing): ${output.length > 80 ? output.slice(0, 80) + '…' : output}`);

  const payloads = buildPayloads(output, fields);
  for (const payload of payloads) {
    await sendVonageMessage(payload);
    const kind = payload.message_type === 'card' ? `card "${payload.card.title}"` : payload.message_type;
    logEvent('outbound', `Sent Ticketing RCS ${kind} to ${redactPhone(fields.clientPhone)}`);
  }
}

module.exports = { extractFields, buildPayloads, processTicketingRcs };
