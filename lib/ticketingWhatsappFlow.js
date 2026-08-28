// 4th demo: Ticketing, WhatsApp. Same Claude "brain" as the RCS ticketing
// demo (lib/ticketingEngine.js, entirely unchanged — it already doesn't
// reference RCS anywhere except in its own comments) and the same
// deterministic stage machine shape as lib/ticketingFlow.js, but this file
// builds WhatsApp payloads instead of RCS cards, and gets its own dedicated
// WABA number (businessConfig.js's TICKETING.WHATSAPP.FROM_WHATSAPP) rather
// than sharing a channel/number with another demo — so inbound routing
// between this and the Real Estate WhatsApp demo is done purely on which
// number the visitor messaged (body.to), see lib/whatsappFlow.js's
// dispatch. No greeting-text sniffing needed for WhatsApp, unlike the two
// RCS demos.
//
// Content/media ported from the "WhatsApp _ MonteCarlo ticketing" Node-RED
// flow (flows_25.json) and Henry's own WhatsApp Manager screenshot of the
// henry_form3 template — see businessConfig.js's TICKETING.WHATSAPP block
// for exactly which fields came from where. Three deliberate content
// differences from the RCS version, all per instruction:
//   1. FAQ is a WhatsApp interactive *list* menu (categorized topics) that
//      the visitor picks from, rather than RCS's free-text Q&A — see
//      maybeSendFaqMenu() below.
//   2. The prize mechanism is the henry_form3 WhatsApp Flow survey (view
//      via the template's "Complete flow" button), not the RCS demo's
//      Instagram-photo-tag contest — even though flows_25.json contains
//      both paths, only this one was asked for. The visitor can only win
//      by actually completing and submitting the survey (the nfm_reply
//      webhook) — there's no "posted it!" text shortcut like the RCS demo.
//   3. "Contact us" escalates through WhatsApp Calling (an in-chat "Call on
//      WhatsApp" button, same pattern as the Real Estate WhatsApp demo's
//      [VOICE_CALL] marker) rather than an RCS dial suggestion chip. The
//      call is answered by the dedicated ElevenLabs Ticketing agent (see
//      voiceHandlers.js/realtimeBridge.js — ELEVENLABS_TICKETING_AGENT_ID)
//      and followed up with a WhatsApp text summary of the call.
//
// Product cards ([T_PRODUCT_LIST]) use WhatsApp's native product_list
// interactive message backed by the same Meta Commerce Catalog as the Real
// Estate demo — tapping a product opens WhatsApp's own product-detail view
// with its native "Add to cart" button, so the carousel-with-cart behavior
// requested comes for free from the catalog integration itself, no custom
// cart logic needed here.
const config = require('./businessConfig');
const { sendVonageMessage } = require('./vonageApi');
const {
  getCallerName,
  setCallerName,
  setTicketFields,
  getTicketFields,
  getTicketingState,
  setTicketingState,
  saveFlowResponse,
} = require('./store');
const { logEvent, redactPhone } = require('./activityLog');
const { decideTicketingMarker, extractTicketFieldsLine } = require('./ticketingEngine');
const { captureNameFromGreeting } = require('./nameCapture');
const { isDuplicateMessage } = require('./dedup');

const T = config.TICKETING;
const W = T.WHATSAPP;
const FROM = W.FROM_WHATSAPP;

// Exact wording ported from flows_25.json's per-item "free form answer"
// nodes (in-seat delivery confirmation) — these four don't follow a
// generatable pattern (each phrased slightly differently), so kept as a
// literal lookup rather than templated.
const PRODUCT_INSEAT_TEXT = {
  mint_ice_cream: 'The mint ice cream will be delivered to your seat at the next players switching side.',
  lemon_ice_cream: 'The lemon ice cream will be delivered to your seat at the next players switching side.',
  cap: 'The cap will be delivered to your seat at the next players switching side.',
  umbrella: 'The umbrella will be delivered to your seat at the next players switching side.',
};

function findProduct(id) {
  return T.PRODUCTS.find((p) => p.id === id);
}

// A short, stable-looking order number, generated once per conversation and
// remembered in ticketingState (state.orderNumber) so it doesn't change
// between the template send and any later reference to it. The original
// flow's henry_ticketing2 sample value was a fixed "1-234567" — this
// demo generates a fresh one per visitor instead of reusing that literal
// sample, for a slightly more convincing live demo.
function buildOrderNumber() {
  return `MC-${Math.floor(100000 + Math.random() * 900000)}`;
}

function extractFields(body) {
  const messageType = body.message_type ?? 'text';
  const messageText =
    body.text ??
    body.button?.text ??
    body.button?.payload ??
    body.interactive?.button_reply?.title ??
    body.interactive?.list_reply?.title ??
    body.reply?.title ??
    'Hello';

  // Same inbound media shape used by ticketingFlow.js's RCS version —
  // Vonage's Messages API represents inbound image/file attachments the
  // same way across channels.
  const mediaUrl = body.image?.url ?? body.file?.url ?? '';
  const mediaCaption = body.image?.caption ?? body.file?.caption ?? '';
  const isPdf = /\.pdf(\?|$)/i.test(mediaUrl) || body.file?.mime_type === 'application/pdf';

  return {
    clientPhone: body.from ?? '',
    messageType,
    messageText: messageType === 'image' || messageType === 'file' ? mediaCaption || 'Uploaded ticket' : messageText,
    mediaUrl,
    mediaMimeType: isPdf ? 'application/pdf' : 'image/jpeg',
    userName: getCallerName(body.from) || body.profile?.name || 'Client',
  };
}

async function downloadAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

// The very first outbound a visitor ever sees for this demo — sent
// deterministically (no Claude call), same reasoning as ticketingFlow.js's
// buildPriorityCard: this exact wording must never depend on the model
// classifying a greeting correctly. henry_ticketing1's approved body has 5
// variables; the last three (event description + two date/time strings)
// aren't tracked as dynamic state anywhere in this codebase, so they're
// kept as the same literal values Henry's own WhatsApp Manager sample used
// when the template was approved — swap these if the real dates change.
function buildPriorityTemplate(userName) {
  return {
    from: FROM, channel: 'whatsapp', message_type: 'custom',
    custom: { type: 'template', template: {
      namespace: config.TEMPLATE_NAMESPACE,
      name: W.TEMPLATE_PRIORITY,
      language: { policy: 'deterministic', code: 'en' },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { link: W.TEMPLATE_HEADER_IMAGE_URL } }] },
        { type: 'body', parameters: [
          { type: 'text', text: userName },
          { type: 'text', text: T.EVENT_NAME },
          { type: 'text', text: `${T.EVENT_NAME} 2026` },
          { type: 'text', text: 'Priority booking opens Tuesday, 9am' },
          { type: 'text', text: 'Priority booking closes the following Monday' },
        ] },
      ],
    } },
  };
}

// FAQ as a WhatsApp interactive list menu — the one deliberate format
// difference from the RCS demo (which answers FAQ questions as free text).
// Content/ids ported verbatim from flows_25.json's "FAQ" node. Selecting a
// row sends its title back as an ordinary text-like reply (list_reply.title
// — see extractFields above), which ticketingEngine.js's shared FAQ rule
// already knows how to answer regardless of channel.
function buildFaqMenu(clientPhone) {
  return {
    from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
    custom: { type: 'interactive', interactive: {
      type: 'list',
      header: { type: 'text', text: 'How can we help you?' },
      body: { text: 'Select the question of your choice' },
      footer: { text: T.EVENT_NAME },
      action: {
        button: 'FAQ',
        sections: [
          { title: 'Access', rows: [
            { id: 'reduced_mobility', title: 'reduced mobility' },
            { id: 'parking', title: 'Parking' },
            { id: 'official_transport', title: 'Official transport' },
          ] },
          { title: 'ticketing', rows: [
            { id: 'resale_tickets', title: 'resale tickets' },
            { id: 'buy_edit_tickets', title: 'buy edit tickets' },
            { id: 'collect_tickets', title: 'collect tikets' },
            { id: 'refund', title: 'refund' },
          ] },
          { title: 'Security', rows: [
            { id: 'items_prohibited', title: 'items prohibited' },
            { id: 'call_over_phone', title: 'be called on phone' },
          ] },
        ],
      },
    } },
  };
}

// Short-circuits Claude entirely when the visitor is asking to see FAQ
// options rather than asking a specific question — matched loosely on
// purpose (same reasoning as demoRouter.js's greeting match: small wording
// changes on either side shouldn't silently break it). Returns true if it
// sent the menu (caller should stop processing this turn).
const FAQ_MENU_TRIGGER_RE = /\b(other question|faq|help|questions?)\b/i;

async function maybeSendFaqMenu(fields) {
  if (!FAQ_MENU_TRIGGER_RE.test(fields.messageText)) return false;
  await sendVonageMessage(buildFaqMenu(fields.clientPhone));
  logEvent('outbound', `Sent Ticketing WhatsApp FAQ menu to ${redactPhone(fields.clientPhone)}`);
  return true;
}

// Turns Claude's marker output into the actual WhatsApp payload(s) to send.
// Mirrors ticketingFlow.js's buildPayloads stage-for-stage; `state` is this
// visitor's current getTicketingState().
function buildPayloads(output, fields, state = {}) {
  const { clientPhone, userName } = fields;
  const base = { from: FROM, to: clientPhone, channel: 'whatsapp' };

  if (output.includes('[T_TICKET_ORDER_CONFIRM]')) {
    const orderNumber = state.orderNumber || buildOrderNumber();
    return [{
      ...base, message_type: 'custom',
      custom: { type: 'template', template: {
        namespace: config.TEMPLATE_NAMESPACE,
        name: W.TEMPLATE_ORDER_CONFIRM,
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: W.TEMPLATE_HEADER_IMAGE_URL } }] },
          { type: 'body', parameters: [
            { type: 'text', text: userName },
            { type: 'text', text: orderNumber },
            { type: 'text', text: `${T.EVENT_NAME} 2026` },
            { type: 'text', text: `${T.EVENT_NAME} 2026` },
          ] },
        ],
      } },
      _orderNumber: orderNumber, // consumed by processTicketingWhatsapp, not sent to Vonage
    }];
  }

  if (output.includes('[T_SEND_TICKET]')) {
    return [{
      ...base, message_type: 'file',
      file: { url: W.ETICKET_PDF_URL, caption: 'Find your tickets attached' },
    }];
  }

  if (output.includes('[T_ONE_WEEK]')) {
    return [{
      ...base, message_type: 'custom',
      custom: { type: 'template', template: {
        namespace: config.TEMPLATE_NAMESPACE,
        name: W.TEMPLATE_ONE_WEEK_MAP,
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { link: W.MAP_PDF_URL, filename: 'MonteCarlo_map.pdf' } }] },
          { type: 'body', parameters: [
            { type: 'text', text: userName },
            { type: 'text', text: `${T.EVENT_NAME} 2026` },
          ] },
        ],
      } },
    }];
  }

  if (output.includes('[T_DDAY]')) {
    return [{
      ...base, message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'button',
        header: { type: 'image', image: { link: T.DAY_PROGRAM_IMAGE_URL } },
        body: { text: `This is the big day, ${userName}! Find today's program attached, along with the new interactive services to make the most of your visit.` },
        action: { buttons: [
          { type: 'reply', reply: { id: 'inseat_delivery', title: 'In-seat delivery!' } },
          { type: 'reply', reply: { id: 'live_score', title: 'Live score' } },
        ] },
      } },
    }];
  }

  if (output.includes('[T_PRODUCT_LIST]')) {
    // WhatsApp's native Commerce Catalog product-list message — same
    // catalog_id as the Real Estate demo's product_list (see
    // businessConfig.js), retailer ids ported from flows_25.json's
    // "Multiple products" node. Tapping a product opens WhatsApp's own
    // product-detail view with a native "Add to cart" button — that
    // behavior comes from the catalog integration itself, not from
    // anything this payload controls.
    return [{
      ...base, message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'product_list',
        header: { type: 'text', text: 'In-seat delivery!' },
        body: { text: "Don't queue, be delivered directly to your seat!" },
        footer: { text: T.EVENT_NAME },
        action: {
          catalog_id: config.CATALOG_ID,
          sections: [
            { title: 'Ice creams', product_items: [
              { product_retailer_id: W.PRODUCT_RETAILER_IDS.mint_ice_cream },
              { product_retailer_id: W.PRODUCT_RETAILER_IDS.lemon_ice_cream },
            ] },
            { title: 'Accessories', product_items: [
              { product_retailer_id: W.PRODUCT_RETAILER_IDS.cap },
              { product_retailer_id: W.PRODUCT_RETAILER_IDS.umbrella },
            ] },
          ],
        },
      } },
    }];
  }

  const deliveryMatch = output.match(/\[T_DELIVERY_METHOD:\s*([^\]]+)\]/);
  if (deliveryMatch) {
    const id = deliveryMatch[1].trim() || state.productId;
    const product = findProduct(id);
    const name = product?.name || 'your order';
    return [{
      ...base, message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'button',
        header: { type: 'image', image: { link: T.DELIVERY_METHOD_IMAGE_URL } },
        body: { text: `Could you confirm how you'd like ${name} delivered, please?` },
        footer: { text: 'Select' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'In-seat_confirmation', title: 'In-seat delivery' } },
          { type: 'reply', reply: { id: 'Collect_seat', title: 'Collect at the stand' } },
          { type: 'reply', reply: { id: 'Cancel_order', title: 'Cancel the order' } },
        ] },
      } },
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
    // Mirrors flows_25.json's "free form answer" seat-confirmation node
    // (interactive button, YES / NO_another_seat ids) — simplified to
    // row+seat only, since ticket_context's fuller Stadium/Grandstand/Gate
    // fields aren't always known (only when a ticket photo was uploaded).
    return [{
      ...base, message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'button',
        body: { text: `Hello ${userName}\n\nJust to confirm — row ${row}, seat ${seat}. Is that correct?` },
        action: { buttons: [
          { type: 'reply', reply: { id: 'In-seat_confirmation_YES', title: 'YES' } },
          { type: 'reply', reply: { id: 'In-seat_confirmation_NO', title: 'NO_another seat' } },
        ] },
      } },
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
    const method = orderMatch[2];
    if (method === 'collect') {
      // Exact wording + generic image header from flows_25.json's "Collect
      // at the stand" node — deliberately doesn't name the item, matching
      // the original.
      return [{
        ...base, message_type: 'custom',
        custom: { type: 'interactive', interactive: {
          type: 'button',
          header: { type: 'image', image: { link: T.COLLECT_AT_STAND_IMAGE_URL } },
          body: { text: "You can collect your order at the Click&Collect of any of the stands. See the site map attached." },
          action: { buttons: [{ type: 'reply', reply: { id: 'continue_after_collect', title: 'Continue ▶' } }] },
        } },
      }];
    }
    const text = PRODUCT_INSEAT_TEXT[id] || `Your order will be delivered to your seat at the next players' changeover, ${userName}!`;
    return [{ ...base, message_type: 'text', text }];
  }

  if (output.includes('[T_VOICE_CALL]')) {
    // Same interactive voice_call pattern as the Real Estate WhatsApp
    // demo's [VOICE_CALL] marker (lib/whatsappFlow.js) — an in-chat "Call
    // on WhatsApp" button, WhatsApp Calling API. FROM here is the
    // Ticketing WABA number, so the resulting inbound call is told apart
    // from Real Estate's by number in voiceHandlers.js, and answered by
    // the dedicated ElevenLabs Ticketing agent.
    return [{
      ...base, message_type: 'custom',
      custom: {
        messaging_product: 'whatsapp', recipient_type: 'individual', type: 'interactive',
        interactive: {
          type: 'voice_call',
          body: { text: 'You can call us directly on WhatsApp now for faster service!' },
          action: { name: 'voice_call', parameters: { display_text: 'Call on WhatsApp', ttl_minutes: 100, payload: 'ticketing_contact_us' } },
        },
      },
    }];
  }

  if (output.includes('[T_REVIEW]')) {
    return [{
      ...base, message_type: 'custom',
      custom: { type: 'template', template: {
        namespace: config.TEMPLATE_NAMESPACE,
        name: W.TEMPLATE_SURVEY,
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: W.TEMPLATE_HEADER_IMAGE_URL } }] },
          { type: 'body', parameters: [
            { type: 'text', text: userName },
            { type: 'text', text: `${T.EVENT_NAME} 2026` },
          ] },
        ],
      } },
    }];
  }

  // [T_WON] is intentionally NOT handled here — for WhatsApp the "you won"
  // reveal only happens once the henry_form3 survey's nfm_reply completion
  // webhook actually arrives (see handleSurveyCompletion below), not from
  // any text reply. There's no Instagram-tagging shortcut on this channel.

  // Plain-text fallback — FAQ answers (once a menu row is picked), the
  // "live score" one-liner, re-asks for row/seat, and the ticket-upload
  // confirmation (already stripped of its TICKET_FIELDS line by
  // processTicketingWhatsapp before reaching here).
  return [{ ...base, message_type: 'text', text: output }];
}

// Same marker -> next-stage table as ticketingFlow.js's computeNextState,
// minus [T_WON] (handled outside the marker loop for this channel — see
// above) and with orderNumber threaded through so it stays stable for the
// rest of the conversation once generated.
function computeNextState(output, extra = {}) {
  if (output.includes('[T_TICKET_ORDER_CONFIRM]')) return { stage: 'ORDER_CONFIRMED', orderNumber: extra.orderNumber };
  if (output.includes('[T_SEND_TICKET]')) return { stage: 'ETICKET_SENT' };
  if (output.includes('[T_ONE_WEEK]')) return { stage: 'ONE_WEEK_SENT' };
  if (output.includes('[T_DDAY]')) return { stage: 'DDAY_SENT' };
  if (output.includes('[T_PRODUCT_LIST]')) return { stage: 'BROWSING_PRODUCTS' };
  if (output.includes('[T_ORDER_CANCELLED]')) return { stage: 'DDAY_SENT' };
  if (output.includes('[T_REVIEW]')) return { stage: 'REVIEW_SENT' };

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

// henry_form3's completion arrives the same way henry_form2's does for the
// Real Estate demo (see whatsappFlow.js): an inbound interactive message of
// type "nfm_reply", not a normal conversational turn. Intercepted before
// Claude sees anything — this IS the prize-winning trigger for this demo
// (per instruction: keep the survey mechanism found in flows_25.json, not
// the RCS demo's Instagram-tag contest — the visitor only wins by actually
// submitting the survey).
async function handleSurveyCompletion(body) {
  const phone = body.from ?? '';
  const { name: flowName, response_json: responseJson } = body.interactive.nfm_reply;
  let answers = {};
  try {
    answers = responseJson ? JSON.parse(responseJson) : {};
  } catch (err) {
    console.error('Failed to parse Ticketing Flow response_json:', err, responseJson);
  }
  saveFlowResponse({ phone, flowName: flowName || W.TEMPLATE_SURVEY, answers, receivedAt: new Date().toISOString() });
  console.log('Ticketing WhatsApp Flow response from', redactPhone(phone), JSON.stringify(answers));
  logEvent('inbound', `Received Ticketing survey (${flowName || W.TEMPLATE_SURVEY}) response from ${redactPhone(phone)}`);

  const userName = getCallerName(phone) || 'there';
  // Exact content ported from flows_25.json's "Your won!" node.
  await sendVonageMessage({
    from: FROM, to: phone, channel: 'whatsapp', message_type: 'custom',
    custom: { type: 'image', image: {
      link: T.WINNER_IMAGE_URL,
      caption: '🎉 Great news! Your picture has been selected! 🎁 Your won 2 tickets for the quarter-final next year! 🎾',
    } },
  });
  logEvent('outbound', `Sent Ticketing WhatsApp "Your won!" to ${redactPhone(phone)}`);
  setTicketingState(phone, { stage: 'CONTEST_WON' });
}

async function processTicketingWhatsapp(req, res) {
  res.status(200).json({ status: 'received' }); // ack immediately, matching whatsappFlow.js

  try {
    const body = req.body || {};
    if (isDuplicateMessage(body.message_uuid)) {
      console.log('Duplicate Ticketing WhatsApp webhook delivery ignored, message_uuid:', body.message_uuid);
      return;
    }

    if (body.interactive?.type === 'nfm_reply' && body.interactive?.nfm_reply) {
      await handleSurveyCompletion(body);
      return;
    }

    const fields = extractFields(body);

    const capturedName = captureNameFromGreeting(fields.messageText);
    if (capturedName) {
      setCallerName(fields.clientPhone, capturedName);
      fields.userName = capturedName;
    }

    console.log('Ticketing WhatsApp inbound fields:', JSON.stringify(fields));
    logEvent('inbound', `Ticketing WhatsApp message from ${redactPhone(fields.clientPhone)}: "${fields.messageText}"`);

    const state = getTicketingState(fields.clientPhone);

    // First-ever contact: send the priority-access template deterministically,
    // no Claude call — same reasoning as ticketingFlow.js's RCS equivalent.
    if (!state.stage) {
      await sendVonageMessage(buildPriorityTemplate(fields.userName));
      logEvent('outbound', `Sent Ticketing WhatsApp template "${W.TEMPLATE_PRIORITY}" to ${redactPhone(fields.clientPhone)}`);
      setTicketingState(fields.clientPhone, { stage: 'AWAITING_PURCHASE' });
      return;
    }

    // FAQ menu short-circuit — see maybeSendFaqMenu's comment. Only applies
    // once the visitor is already past the very first template above.
    if (await maybeSendFaqMenu(fields)) return;

    if ((fields.messageType === 'image' || fields.messageType === 'file') && fields.mediaUrl) {
      try {
        fields.imageBase64 = await downloadAsBase64(fields.mediaUrl);
        fields.imageMediaType = fields.mediaMimeType;
      } catch (err) {
        console.error('Ticketing WhatsApp: failed to download uploaded ticket media:', err.message);
        logEvent('inbound', `Ticketing WhatsApp: could not download uploaded ticket from ${redactPhone(fields.clientPhone)}`);
      }
    }

    let output = await decideTicketingMarker(fields);
    console.log('Claude marker decision (Ticketing WhatsApp):', output);

    let ticketFieldsJustExtracted = null;
    if (output.includes('TICKET_FIELDS:')) {
      const parsed = extractTicketFieldsLine(output);
      output = parsed.text;
      if (parsed.fields) {
        ticketFieldsJustExtracted = setTicketFields(fields.clientPhone, parsed.fields);
      }
    }

    logEvent('decision', `Marker decision (Ticketing WhatsApp): ${output.length > 80 ? output.slice(0, 80) + '…' : output}`);

    const payloads = buildPayloads(output, fields, state);
    let orderNumber;
    for (const payload of payloads) {
      if (payload._orderNumber) orderNumber = payload._orderNumber;
      const { _orderNumber, ...toSend } = payload;
      await sendVonageMessage(toSend);
      const kind =
        toSend.message_type === 'custom' && toSend.custom?.type === 'template'
          ? `template "${toSend.custom.template.name}"`
          : toSend.message_type === 'custom'
          ? 'interactive message'
          : toSend.message_type;
      logEvent('outbound', `Sent Ticketing WhatsApp ${kind} to ${redactPhone(fields.clientPhone)}`);
    }

    const next = computeNextState(output, { orderNumber });
    if (next.stage) {
      const { stage, ...patch } = next;
      setTicketingState(fields.clientPhone, { stage, ...patch });
    }

    // Same ticket-photo auto-completion as ticketingFlow.js's RCS version.
    if (state.stage === 'AWAITING_SEAT' && ticketFieldsJustExtracted) {
      const row = ticketFieldsJustExtracted.Row || ticketFieldsJustExtracted.Grandstand || 'unknown';
      const seat = ticketFieldsJustExtracted.Seat || 'unknown';
      const productId = state.productId || 'your order';
      const confirmMarker = `[T_SEAT_CONFIRM: ${productId}:${row}:${seat}]`;
      const confirmPayloads = buildPayloads(confirmMarker, fields, state);
      for (const payload of confirmPayloads) {
        await sendVonageMessage(payload);
        logEvent('outbound', `Sent Ticketing WhatsApp ${payload.message_type} to ${redactPhone(fields.clientPhone)}`);
      }
      setTicketingState(fields.clientPhone, { stage: 'CONFIRMING_SEAT', productId, row, seat });
    }
  } catch (err) {
    console.error('processTicketingWhatsapp error:', err);
  }
}

// Placing an outbound "feedback call" is NOT needed here (unlike Real
// Estate's maybeTriggerFeedbackCall) — Ticketing's contact path is
// visitor-initiated via the voice_call button above, mirroring the RCS
// demo's dial-suggestion pattern exactly (visitor taps, they call us — we
// never call them). Kept out of this file on purpose.

module.exports = { extractFields, buildPayloads, computeNextState, processTicketingWhatsapp };
