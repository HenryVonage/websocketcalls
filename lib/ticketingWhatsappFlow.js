// 4th demo: Ticketing, WhatsApp. Same Claude "brain" as the RCS ticketing
// demo (lib/ticketingEngine.js, entirely unchanged — it already doesn't
// reference RCS anywhere except in its own comments) and the same
// deterministic stage machine shape as lib/ticketingFlow.js, but this file
// builds WhatsApp payloads instead of RCS cards.
//
// Originally designed around its own dedicated WABA number, but that
// number (447312277021, from the Node-RED flow) was never actually linked
// to this Vonage Application — the first live test showed zero inbound
// webhooks at all. Per instruction, this demo now shares the Real Estate
// WhatsApp demo's number instead (businessConfig.js's
// TICKETING.WHATSAPP.FROM_WHATSAPP === FROM_WHATSAPP), so inbound routing
// between the two WhatsApp demos works exactly like the two RCS demos
// already share one agent — by greeting text (lib/demoRouter.js's
// detectDemoFromText, reused as-is; see server.js's dispatch).
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
  resetTicketingJourney,
  saveFlowResponse,
} = require('./store');
const { logEvent, redactPhone } = require('./activityLog');
const { waitForDelivery } = require('./deliveryWait');
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

  // FAQ list-menu picks arrive as a reply whose id matches one of
  // buildFaqMenu's row ids (Vonage's WhatsApp list-reply shape is
  // body.reply.{id,title} in this API version; body.interactive.list_reply
  // is also checked for forward-compatibility). Every other button/list
  // reply this demo sends uses different ids, so this lookup safely tells
  // "picked an FAQ topic" apart from every other tap without needing to
  // track "was the FAQ menu just shown" as separate state.
  const faqRowId = body.interactive?.list_reply?.id ?? body.reply?.id ?? null;
  const faqTopicLabel = faqRowId ? FAQ_TOPIC_LABELS[faqRowId] : null;

  return {
    clientPhone: body.from ?? '',
    messageType,
    messageText: messageType === 'image' || messageType === 'file' ? mediaCaption || 'Uploaded ticket' : messageText,
    mediaUrl,
    mediaMimeType: isPdf ? 'application/pdf' : 'image/jpeg',
    userName: getCallerName(body.from) || body.profile?.name || 'Client',
    faqTopicLabel,
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
function buildPriorityTemplate(userName, clientPhone) {
  return {
    from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
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

// Maps each FAQ menu row id (see buildFaqMenu) to a natural-language topic
// label passed to Claude as "faq_topic" — see extractFields below and
// ticketingEngine.js's FAQ TOPIC SELECTED rule. A tapped row gives Claude a
// short noun phrase, not a full question ("collect tikets", not "how do I
// collect my tickets?") — without this, a stage's "anything else" rule can
// misjudge it as a non-question and advance the journey instead of
// answering it (confirmed live: picking "collect tikets" while ETICKET_SENT
// silently sent the one-week reminder instead of an FAQ answer). faq_topic
// makes the FAQ intent explicit instead of relying on Claude to infer it
// from a bare phrase.
// Testing/demo reset trigger — see processTicketingWhatsapp's use of it.
// Henry's own test greetings vary in wording ("Welcome to the Ticketing
// demo!", "Welcome to Rolex Monte-Carlo Masters — Ticketing demo!", ...),
// so an exact-phrase match was too narrow: one of those variants slipped
// past it and got answered from stale, already-advanced state (the
// visitor received the e-ticket PDF instead of the journey restarting).
// Match loosely instead — "welcome" and "ticketing demo" appearing
// anywhere in the message, in either order, with anything in between —
// so any reasonable greeting reliably restarts the journey.
function isResetGreeting(text) {
  const t = (text || '').toLowerCase();
  return t.includes('welcome') && t.includes('ticketing demo');
}

const FAQ_TOPIC_LABELS = {
  reduced_mobility: 'accessibility and reduced mobility',
  parking: 'parking',
  official_transport: 'official transport to the venue',
  resale_tickets: 'reselling tickets',
  buy_edit_tickets: 'buying or editing a ticket order',
  collect_tickets: 'collecting tickets',
  refund: 'refunds',
  items_prohibited: 'prohibited items',
  call_over_phone: 'being called back on the phone',
};

// Every reply/list-reply id this demo's own outbound messages can produce
// (the FAQ menu rows above, plus every interactive button in buildPayloads
// below) — a tap producing one of these ids could only ever have come from
// a Ticketing WhatsApp message, so server.js treats it as a stronger,
// restart-proof routing signal than the phone->demo binding in store.js
// (process-memory only, wiped on every Render restart — see store.js's
// top-of-file comment). Keeps server.js's routing list in sync with this
// file automatically instead of needing its own separately-maintained copy.
const TICKETING_REPLY_IDS = new Set([
  ...Object.keys(FAQ_TOPIC_LABELS),
  'inseat_delivery', 'live_score',
  'In-seat_confirmation', 'Collect_seat', 'Cancel_order',
  'In-seat_confirmation_YES', 'In-seat_confirmation_NO',
  'continue_after_collect',
]);

// Per Henry's direction: an FAQ side question must never block the
// journey's scripted playback. For the stages whose "anything else" rule
// is an UNCONDITIONAL next step (no visitor choice involved — order
// confirm, e-ticket, one-week reminder, day-of program, review/prize
// invite), that next step is sent automatically right after the FAQ
// answer, in the same turn, instead of waiting for another message.
// Deliberately excludes stages whose next step actually depends on what
// the visitor picks (BROWSING_PRODUCTS, CHOOSING_DELIVERY, AWAITING_SEAT,
// CONFIRMING_SEAT, DDAY_SENT's delivery-vs-live-score choice, REVIEW_SENT's
// "posted it" confirmation) — auto-sending one of those would mean
// fabricating a choice the visitor never made.
const FAQ_AUTO_CONTINUE_MARKER = {
  AWAITING_PURCHASE: '[T_TICKET_ORDER_CONFIRM]',
  ORDER_CONFIRMED: '[T_SEND_TICKET]',
  ETICKET_SENT: '[T_ONE_WEEK]',
  ONE_WEEK_SENT: '[T_DDAY]',
  ORDER_PLACED: '[T_REVIEW]',
};

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
            // henry_ticketing3bis's approved body has just 1 variable (name) —
            // the old henry_ticketing3's 2-var shape (name + event name) is gone.
            { type: 'text', text: userName },
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

  if (output.includes('[T_GENERIC_HELP]')) {
    // Henry's requested pattern for a reply that doesn't match any expected
    // option and isn't a genuine question — replaces what used to be
    // several different stage-specific "gently ask again" texts written by
    // Claude (see ticketingEngine.js). This is just the first half; the
    // second half (a call offer, only if nothing further arrives within 5
    // seconds) is sent from processTicketingWhatsapp, not here.
    return [{ ...base, message_type: 'text', text: 'How can we help you?' }];
  }

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

// Builds, sends and logs every payload a marker produces, returning the
// order number if one was generated — shared by the main per-turn send and
// the FAQ auto-continue step below, so both stay in sync with buildPayloads.
async function sendMarkerPayloads(output, fields, state, { auto = false } = {}) {
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
    logEvent('outbound', `Sent Ticketing WhatsApp ${kind} to ${redactPhone(fields.clientPhone)}${auto ? ' (auto-continue after FAQ)' : ''}`);
  }
  return { orderNumber };
}

// Sends the next unconditional scripted step for `state.stage`, if one
// exists (see FAQ_AUTO_CONTINUE_MARKER above) — i.e. resumes the journey
// after a side interaction that didn't advance the stage itself. Used both
// for the FAQ auto-continue case below and by voiceHandlers.js's
// sendTicketingWhatsappCallFollowUp, so a Ticketing WhatsApp Calling call
// doesn't dead-end the conversation any more than an FAQ question does.
// Returns true if it sent something.
async function maybeContinueJourney(fields, state) {
  const continueMarker = FAQ_AUTO_CONTINUE_MARKER[state.stage];
  if (!continueMarker) return false;
  const { orderNumber } = await sendMarkerPayloads(continueMarker, fields, state, { auto: true });
  const next = computeNextState(continueMarker, { orderNumber });
  if (next.stage) {
    const { stage, ...patch } = next;
    setTicketingState(fields.clientPhone, { stage, ...patch });
  }
  return true;
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

    // Bumped on every inbound so the [T_GENERIC_HELP] handler below can
    // tell, after its 5-second wait, whether the visitor sent something
    // else in the meantime — without needing a live connection to "listen"
    // for it (this is a stateless webhook handler; each inbound is its own
    // request). See that handler for the full explanation.
    setTicketingState(fields.clientPhone, { lastInboundAt: Date.now() });

    // Henry's explicit testing convenience: the greeting text his demo
    // script always sends first ("Welcome to the Ticketing demo!") should
    // ALWAYS restart the journey from scratch on this phone number, even
    // though Redis now deliberately keeps ticketing state alive across
    // Render restarts for real, non-reset journeys. Without this, retesting
    // on the same number just resumes wherever the last test left off
    // (confirmed live: a fresh "Hi, I'm Henry — Welcome..." got answered
    // with [T_DDAY] because that number's prior test had already advanced
    // to ONE_WEEK_SENT).
    if (isResetGreeting(fields.messageText)) {
      resetTicketingJourney(fields.clientPhone);
      logEvent('inbound', `Reset phrase detected — cleared Ticketing state for ${redactPhone(fields.clientPhone)}`);
    }

    const state = getTicketingState(fields.clientPhone);

    // First-ever contact: send the priority-access template deterministically,
    // no Claude call — same reasoning as ticketingFlow.js's RCS equivalent.
    // Guarded on !fields.faqTopicLabel too: if a Render restart wiped
    // ticketingState mid-conversation and the visitor's next tap happens to
    // be an FAQ menu row (still visible in their WhatsApp thread from
    // before the restart), that's clearly not a first contact — answer the
    // question instead of silently resending the priority-access template.
    if (!state.stage && !fields.faqTopicLabel) {
      const sendResult = await sendVonageMessage(buildPriorityTemplate(fields.userName, fields.clientPhone));
      logEvent('outbound', `Sent Ticketing WhatsApp template "${W.TEMPLATE_PRIORITY}" to ${redactPhone(fields.clientPhone)}`);
      setTicketingState(fields.clientPhone, { stage: 'AWAITING_PURCHASE' });

      // Henry wants the order-confirmation template to follow 4 seconds
      // later NO MATTER WHAT — not gated on the visitor sending a reply in
      // between (ticketingEngine.js's AWAITING_PURCHASE rule used to be the
      // only way this fired: "any reply at all -> [T_TICKET_ORDER_CONFIRM]",
      // which meant nothing further arrived for a tester who didn't reply
      // right away). That reply-triggered rule is left in place as a faster
      // path for a visitor who does reply quickly; the stage check below
      // just stops this timer from sending a duplicate if that already
      // happened while we were waiting.
      //
      // A fixed 4s pause measured from the SEND of the priority template
      // wasn't enough, though — confirmed twice live via Render's DLR logs:
      // that template has an image header, and WhatsApp doesn't deliver it
      // to the phone the instant Vonage accepts it (one test showed a
      // ~4.7s gap between "submitted" and "delivered" for it, while the
      // order-confirmation template — also image-headered but sent later —
      // delivered much faster). The two messages ended up only ~1-2s apart
      // on the phone even with the 4s send-to-send pause. Fixed by waiting
      // for the priority template's actual "delivered" DLR first (see
      // lib/deliveryWait.js, fed by lib/dlrHandler.js), THEN pausing 4s —
      // so the 4-second gap is measured between real arrivals, not sends.
      // waitForDelivery has its own timeout fallback (15s) so a missing/
      // delayed DLR can never hang this indefinitely.
      await waitForDelivery(sendResult?.message_uuid);
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (getTicketingState(fields.clientPhone).stage === 'AWAITING_PURCHASE') {
        const { orderNumber } = await sendMarkerPayloads(
          '[T_TICKET_ORDER_CONFIRM]', fields, getTicketingState(fields.clientPhone), { auto: true },
        );
        setTicketingState(fields.clientPhone, { stage: 'ORDER_CONFIRMED', orderNumber });
      }
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

    // FAQ rule's "unsure -> suggest [T_VOICE_CALL]" case is the one place
    // Claude is allowed to combine reply text with a marker (see
    // ticketingEngine.js's system prompt) — send them as two separate
    // messages instead of collapsing to just the call button, so the
    // visitor gets an actual answer to read before being pointed at the
    // phone.
    const voiceCallMatch = output.match(/^([\s\S]*?)\[T_VOICE_CALL\]\s*$/);
    const introText = voiceCallMatch ? voiceCallMatch[1].trim() : '';

    let orderNumber;
    if (output.includes('[T_GENERIC_HELP]')) {
      // Henry's requested pattern for any reply that doesn't match a
      // stage's expected options and isn't a genuine question — replaces
      // several previously-separate "gently ask again" texts (D-Day's two
      // options, AWAITING_SEAT's row/seat re-ask, REVIEW_SENT's tag-your-
      // post reminder) with one consistent behavior: a light "How can we
      // help you?", then a call offer ONLY if the visitor doesn't send
      // anything further within 5 seconds. lastInboundAt (bumped on every
      // inbound, near the top of this function) is how we tell — this
      // handler doesn't hold the connection open for 5s waiting on a
      // webhook; it re-checks the stored timestamp after sleeping and
      // bails out if a newer inbound already updated it (that newer
      // message is being — or already was — handled by its own separate
      // request).
      ({ orderNumber } = await sendMarkerPayloads(output, fields, state));
      const waitStartedAt = getTicketingState(fields.clientPhone).lastInboundAt;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (getTicketingState(fields.clientPhone).lastInboundAt === waitStartedAt) {
        await sendMarkerPayloads('[T_VOICE_CALL]', fields, state, { auto: true });
      }
    } else if (introText) {
      await sendMarkerPayloads(introText, fields, state);
      // Awaiting the send above only confirms Vonage accepted it for
      // delivery, not that it actually reached the visitor's phone first —
      // two independent WhatsApp sends issued back-to-back aren't
      // guaranteed to arrive in order (confirmed live: the call offer
      // occasionally beat the written answer there). A short pause before
      // the second send gives WhatsApp's delivery pipeline time to settle,
      // same reasoning as the existing "Wait 3 Seconds" pause this codebase
      // already uses before a call-related follow-up (see
      // maybeTriggerFeedbackCall in whatsappFlow.js/rcsFlow.js).
      await new Promise((resolve) => setTimeout(resolve, 2000));
      ({ orderNumber } = await sendMarkerPayloads('[T_VOICE_CALL]', fields, state, { auto: true }));
    } else {
      ({ orderNumber } = await sendMarkerPayloads(output, fields, state));
    }

    const next = computeNextState(output, { orderNumber });
    if (next.stage) {
      const { stage, ...patch } = next;
      setTicketingState(fields.clientPhone, { stage, ...patch });
    } else if (fields.faqTopicLabel) {
      // A pure FAQ answer (no marker, stage unchanged) — resume the
      // journey if this stage has an unconditional next step, so the FAQ
      // side question didn't stall it.
      await maybeContinueJourney(fields, state);
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

module.exports = { extractFields, buildPayloads, computeNextState, processTicketingWhatsapp, TICKETING_REPLY_IDS, maybeContinueJourney };
