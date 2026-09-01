const config = require('./businessConfig');
const { sendVonageMessage, createVonageCall } = require('./vonageApi');
const { setCallContext, getCallerName, setCallerName, saveFlowResponse } = require('./store');
const { buildAnswerNcco } = require('./nccoBuilder');
const { logEvent, redactPhone } = require('./activityLog');
const { decideMarker } = require('./conversationEngine');
const { captureNameFromGreeting } = require('./nameCapture');
const { isDuplicateMessage } = require('./dedup');

function extractFields(body) {
  return {
    clientPhone: body.from ?? '',
    messageType: body.message_type ?? 'text',
    messageText:
      body.text ??
      body.button?.text ??
      body.button?.payload ??
      body.interactive?.button_reply?.title ??
      body.interactive?.list_reply?.title ??
      body.reply?.title ??
      body.whatsapp?.referred_product?.product_retailer_id ??
      'Hello',
    productId: body.whatsapp?.referred_product?.product_retailer_id ?? '',
    userName: getCallerName(body.from) || body.profile?.name || 'Client',
  };
}

// Ported verbatim (logic-wise) from Flow 3's "Build Vonage Payload" Code node.
function buildPayloads(output, fields) {
  const { clientPhone, userName, productId } = fields;
  const FROM = config.FROM_WHATSAPP;
  const propertyName = config.PROPERTY_MAP[productId] || "Regent's Park";

  if (output.includes('[WELCOME]')) {
    return [{
      from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
      custom: { type: 'template', template: {
        namespace: config.TEMPLATE_NAMESPACE,
        name: 'henry_realestatewelcome2',
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: 'https://i.ibb.co/Q9WnvQh/Screenshot-2023-06-22-at-15-13-22.png' } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Vonage Estate' }] },
          { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'Flats available near by' }] },
          { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'Viewing' }] },
        ],
      } },
    }];
  }

  if (output.includes('[VOICE_CALL]')) {
    return [{
      from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
      custom: {
        messaging_product: 'whatsapp', recipient_type: 'individual', type: 'interactive',
        interactive: {
          type: 'voice_call',
          body: { text: 'You can call us on WhatsApp now for faster service!' },
          action: { name: 'voice_call', parameters: { display_text: 'Call on WhatsApp', ttl_minutes: 100, payload: 'contact_us' } },
        },
      },
    }];
  }

  if (output.includes('[PRODUCT_LIST]')) {
    return [{
      from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'product_list',
        header: { type: 'text', text: 'Our top properties' },
        body: { text: 'Check out these available properties' },
        footer: { text: 'Vonage Estate' },
        action: { catalog_id: config.CATALOG_ID, sections: [{ title: 'Available Properties', product_items: [{ product_retailer_id: 'L1234' }, { product_retailer_id: 'L5678' }] }] },
      } },
    }];
  }

  if (output.includes('[FLAT_TYPE_LIST]')) {
    return [{
      from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'list',
        header: { type: 'text', text: 'What type of flat?' },
        body: { text: 'Select the type of flat' },
        footer: { text: 'Criteria' },
        action: { button: 'Select', sections: [
          { title: 'Studio', rows: [
            { id: 'less1000', title: 'less than £1000', description: 'budget studios' },
            { id: 'between1000and1500', title: 'between £1000-£1500', description: 'studios to feel cosy' },
            { id: 'over1500', title: 'over £1500', description: 'exclusive studios' },
          ] },
          { title: '1 bedroom', rows: [
            { id: 'less1500', title: 'less than £1500', description: 'budget 1 bedroom flats' },
            { id: 'between1500and2000', title: 'between £1500-£2000', description: 'cosy 1 bedroom flats' },
            { id: 'over2000', title: 'over £2000', description: 'luxury 1 bedroom flats' },
          ] },
          { title: '2 bedroom', rows: [
            { id: 'less1800', title: 'less than £1800', description: 'budget 2 bedroom flats' },
            { id: 'between1800and2200', title: 'between £1800-£2200', description: 'cosy 2 bedroom flats' },
            { id: 'over2200', title: 'over £2200', description: 'luxury 2 bedroom flats' },
          ] },
        ] },
      } },
    }];
  }

  if (output.includes('[VIEWING_INTEREST]')) {
    return [
      {
        from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
        custom: { type: 'template', template: {
          namespace: config.TEMPLATE_NAMESPACE,
          name: 'henry_videorealestate',
          language: { policy: 'deterministic', code: 'en' },
          components: [
            { type: 'header', parameters: [{ type: 'video', video: { link: config.VIDEO_URL } }] },
            { type: 'body', parameters: [{ type: 'text', text: userName }, { type: 'text', text: propertyName }] },
          ],
        } },
      },
      {
        from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'image',
        image: { url: config.FLOORPLAN_URL, caption: 'Floorplan' },
      },
      {
        from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
        custom: { type: 'template', template: {
          namespace: config.TEMPLATE_NAMESPACE,
          name: 'henry_confirmationviewing',
          language: { policy: 'deterministic', code: 'en' },
          components: [
            // Approved template has an IMAGE header (a property photo) —
            // the earlier "Invalid template or template parameters"
            // rejection was because this component was missing entirely.
            { type: 'header', parameters: [{ type: 'image', image: { link: config.PROPERTY_PHOTO_URL } }] },
            { type: 'body', parameters: [{ type: 'text', text: propertyName }] },
            { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'BOOK A VIEWING' }] },
            { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'NOT INTERESTED' }] },
            { type: 'button', sub_type: 'quick_reply', index: 2, parameters: [{ type: 'payload', payload: 'QUESTIONS ABOUT THE FLAT' }] },
          ],
        } },
      },
    ];
  }

  // The user just tapped "Book a viewing" — offer a few concrete slots
  // instead of jumping straight to a confirmation with a fixed time (see
  // conversationEngine.js's STEP 6). Uses the same interactive 'list'
  // shape as [FLAT_TYPE_LIST] above, since that shape is already
  // confirmed working against the Messages API.
  if (output.includes('[TIMESLOT_LIST')) {
    const m = output.match(/\[TIMESLOT_LIST(?::\s*([^\]]+))?\]/);
    const name = (m && m[1]) ? m[1].trim() : userName;
    return [{
      from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'list',
        header: { type: 'text', text: 'Choose a viewing time' },
        body: { text: `Great, ${name}! What time works best for your viewing at ${propertyName}?` },
        footer: { text: 'Vonage Estate' },
        action: { button: 'Select a time', sections: [
          { title: 'Available times', rows: [
            { id: 'Tomorrow 10:00', title: 'Tomorrow 10:00' },
            { id: 'Tomorrow 14:30', title: 'Tomorrow 14:30' },
            { id: 'Thu 11:00', title: 'Thu 11:00' },
          ] },
        ] },
      } },
    }];
  }

  if (output.includes('[VIDEO_TOUR')) {
    // STEP 6B (conversationEngine.js) threads the timeslot the user
    // actually picked from [TIMESLOT_LIST] through as "name|slot" — fall
    // back to the old fixed slot only if it's ever missing (e.g. a stale
    // client still sending the old marker shape).
    const m = output.match(/\[VIDEO_TOUR(?::\s*([^\]]+))?\]/);
    const raw = (m && m[1]) ? m[1].trim() : '';
    const [rawName, rawSlot] = raw.split('|').map((s) => s?.trim());
    const name = rawName || userName;
    const appointmentTime = rawSlot || '14:30 tomorrow';
    return [{
      from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'custom',
      custom: { type: 'template', template: {
        namespace: config.TEMPLATE_NAMESPACE,
        name: 'henryappointment',
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'location', location: config.VONAGE_OFFICE }] },
          { type: 'body', parameters: [{ type: 'text', text: name }, { type: 'text', text: propertyName }, { type: 'text', text: appointmentTime }, { type: 'text', text: 'Vonage Estate' }] },
          { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'YES' }] },
          { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'NO' }] },
        ],
      } },
    }];
  }

  if (output.includes('[ASK_LOCATION]')) {
    return [{ from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'text', text: 'Please share your current location, or type an address' }];
  }

  return [{ from: FROM, to: clientPhone, channel: 'whatsapp', message_type: 'text', text: output }];
}

// Ported from Flow 3's "YES or NO?" -> "Wait 3 Seconds" -> "Build Voice Call
// JWT" -> "Trigger Vonage Voice Call" branch. Now places the call through
// the same connect->websocket path as every other call, tagged with
// 'feedback_call' context so the realtime bridge greets appropriately.
async function maybeTriggerFeedbackCall(fields) {
  if (fields.messageText !== 'YES' && fields.messageText !== 'NO') return;

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const ncco = buildAnswerNcco({ context: 'feedback_call', callerPhone: fields.clientPhone });
  const result = await createVonageCall({ to: fields.clientPhone, from: config.FROM_WHATSAPP, ncco });
  setCallContext(result.conversation_uuid, { context: 'feedback_call', phone: fields.clientPhone });
  logEvent('call', `Placed feedback call to ${redactPhone(fields.clientPhone)}`);
}

async function handleWhatsAppInbound(req, res) {
  res.status(200).json({ status: 'received' }); // ack immediately, like the n8n webhook did

  try {
    const body = req.body || {};
    if (isDuplicateMessage(body.message_uuid)) {
      console.log('Duplicate WhatsApp webhook delivery ignored, message_uuid:', body.message_uuid);
      return;
    }

    // henry_form2's "Survey" Flow completion lands here like any other
    // inbound message, shaped like Meta's raw webhook: an interactive
    // message of type "nfm_reply" whose response_json holds whatever fields
    // the flow's terminal screen collected. It's a pre-defined Meta screen
    // (not a custom flow JSON we authored), so the exact field names aren't
    // known ahead of time — stored as-is rather than mapped to named
    // fields. This isn't a conversational turn, so skip Claude's marker
    // decision and buildPayloads entirely and just capture the answers.
    if (body.interactive?.type === 'nfm_reply' && body.interactive?.nfm_reply) {
      const phone = body.from ?? '';
      const { name: flowName, response_json: responseJson } = body.interactive.nfm_reply;
      let answers = {};
      try {
        answers = responseJson ? JSON.parse(responseJson) : {};
      } catch (err) {
        console.error('Failed to parse Flow response_json:', err, responseJson);
      }
      saveFlowResponse({ phone, flowName: flowName || 'henry_form2', answers, receivedAt: new Date().toISOString() });
      console.log('WhatsApp Flow response from', redactPhone(phone), JSON.stringify(answers));
      logEvent('inbound', `Received Survey (henry_form2) response from ${redactPhone(phone)}`);
      return;
    }

    const fields = extractFields(body);

    // First-touch from the demo landing page: capture the visitor's typed
    // first name from the pre-filled greeting and remember it for this
    // phone number, so every subsequent template in this and later turns
    // (including a follow-up voice call) is personalized with it.
    const capturedName = captureNameFromGreeting(fields.messageText);
    if (capturedName) {
      setCallerName(fields.clientPhone, capturedName);
      fields.userName = capturedName;
    }

    console.log('WhatsApp inbound fields:', JSON.stringify(fields));
    logEvent('inbound', `WhatsApp message from ${redactPhone(fields.clientPhone)}: "${fields.messageText}"`);

    const output = await decideMarker(fields);
    console.log('Claude marker decision:', output);
    logEvent('decision', `Marker decision: ${output.length > 80 ? output.slice(0, 80) + '…' : output}`);

    // STEP 3B (conversationEngine.js) — only the RCS "share_location" chip
    // tap triggers this in practice, but handled here too for parity since
    // the marker engine is shared across channels.
    if (output.trim() === '[IGNORE]') {
      return;
    }

    const payloads = buildPayloads(output, fields);

    for (const payload of payloads) {
      await sendVonageMessage(payload);
      const kind =
        payload.message_type === 'custom' && payload.custom?.type === 'template'
          ? `template "${payload.custom.template.name}"`
          : payload.message_type === 'custom'
          ? 'interactive message'
          : payload.message_type;
      logEvent('outbound', `Sent ${kind} to ${redactPhone(fields.clientPhone)}`);
    }

    await maybeTriggerFeedbackCall(fields);
  } catch (err) {
    console.error('handleWhatsAppInbound error:', err);
  }
}

module.exports = { handleWhatsAppInbound };
