// 2nd demo: same "Henry's Real Estate" conversation, delivered over RCS
// instead of WhatsApp. Reuses the exact same Claude decision engine
// (conversationEngine.js) as whatsappFlow.js — only the message-building
// layer differs, since RCS has no template-approval system (cards,
// suggestions and text can be sent directly) but has its own payload
// shapes, character limits, and suggestion-count limits.
//
// IMPORTANT CAVEAT: unlike the WhatsApp templates (which we could verify
// screenshot-by-screenshot against Meta's Template Manager), there's no
// equivalent approval UI for RCS — these payloads are built directly from
// Vonage's public RCS API docs (developer.vonage.com/messages/guides/rcs)
// and have NOT been tested against a live RBM agent yet. Expect to debug
// specific fields against real DLR/rejection responses the same way we did
// for the WhatsApp templates — check the activity log (/api/logs) for
// "rejected"/"undeliverable" entries after the first test.
const config = require('./businessConfig');
const { sendVonageMessage, createVonageCall } = require('./vonageApi');
const { setCallContext, getCallerName, setCallerName, resetConversation } = require('./store');
const { buildAnswerNcco } = require('./nccoBuilder');
const { logEvent, redactPhone } = require('./activityLog');
const { decideMarker } = require('./conversationEngine');
const { captureNameFromGreeting, isResetGreeting } = require('./nameCapture');
const { isDuplicateMessage } = require('./dedup');
const { resolveDemo, DEMOS } = require('./demoRouter');
const { extractFields: ticketingExtractFields, processTicketingRcs } = require('./ticketingFlow');

const FROM = config.RCS_AGENT_ID;

function extractFields(body) {
  const rawType = body.message_type ?? 'text';
  // RCS "reply" suggestions (predefined quick responses, tapped as chips)
  // play the same conversational role as WhatsApp's quick-reply buttons —
  // the shared conversationEngine's prompt checks for message_type
  // 'button', so normalize here rather than forking the prompt per
  // channel. Suggested *actions* (dial/open_url/etc.) arrive as 'button'
  // already, per Vonage's RCS docs, so those pass through unchanged.
  const messageType = rawType === 'reply' ? 'button' : rawType;

  const replyId = body.reply?.id;
  // Property-selection cards use the reply's postback_data as the
  // property ID directly (e.g. "L1234") — see buildRcsPayloads's
  // [PRODUCT_LIST] case. Anything else is a normal reply/button.
  const productId = replyId && config.PROPERTY_MAP[replyId] ? replyId : '';

  const messageText =
    productId ||
    replyId ||
    body.button?.payload ||
    body.button?.text ||
    body.text ||
    'Hello';

  return {
    clientPhone: body.from ?? '',
    messageType,
    messageText,
    productId,
    userName: getCallerName(body.from) || 'Client',
  };
}

// Mirrors whatsappFlow.js's buildPayloads, one marker at a time, but
// producing RCS message objects (text / card / suggestions) instead of
// WhatsApp templates.
function buildPayloads(output, fields) {
  const { clientPhone, userName, productId } = fields;
  const propertyName = config.PROPERTY_MAP[productId] || "Regent's Park";

  if (output.includes('[WELCOME]')) {
    return [{
      from: FROM, to: clientPhone, channel: 'rcs', message_type: 'card',
      card: {
        title: 'Vonage Estate',
        text: "Welcome! I'm here to help you find your next home. What would you like to do?",
        media_url: config.PROPERTY_PHOTO_URL,
        media_height: 'MEDIUM',
        suggestions: [
          { type: 'reply', text: 'Flats nearby', postback_data: 'Flats available near by' },
          { type: 'reply', text: 'Viewing', postback_data: 'Viewing' },
          // Same dial suggestion as the [VOICE_CALL] marker below, offered
          // straight from the welcome card too — forwards over PSTN to
          // RCS_PSTN_NUMBER, the Vonage number linked to the ElevenLabs
          // voice bridge (Application ID 5650d142-3440-4bc1-8377-a12cc20e2605).
          { type: 'dial', text: 'Call us', postback_data: 'call_us', phone_number: `+${config.RCS_PSTN_NUMBER}` },
        ],
      },
      rcs: { card_orientation: 'VERTICAL' },
    }];
  }

  if (output.includes('[VOICE_CALL]')) {
    // No "calling within RCS" concept — points the caller at the real
    // PSTN number linked to this same Vonage Application instead.
    return [{
      from: FROM, to: clientPhone, channel: 'rcs', message_type: 'text',
      text: 'You can call us directly for faster service!',
      suggestions: [
        { type: 'dial', text: 'Call us', postback_data: 'call_us', phone_number: `+${config.RCS_PSTN_NUMBER}` },
      ],
    }];
  }

  if (output.includes('[PRODUCT_LIST]')) {
    // Two standalone cards rather than a carousel — Vonage's docs don't
    // give an exact JSON shape for RCS carousels, and "card" (confirmed
    // shape) is the safer bet until that's verified against a real send.
    return [
      {
        from: FROM, to: clientPhone, channel: 'rcs', message_type: 'card',
        card: {
          title: "Regent's Park",
          text: 'Two-bedroom flat, recently renovated. Tap to see details.',
          media_url: config.PROPERTY_PHOTO_URL,
          media_height: 'MEDIUM',
          suggestions: [{ type: 'reply', text: 'View this flat', postback_data: 'L1234' }],
        },
        rcs: { card_orientation: 'VERTICAL' },
      },
      {
        from: FROM, to: clientPhone, channel: 'rcs', message_type: 'card',
        card: {
          title: 'Angel Loft',
          text: 'Bright loft-style flat close to transport links.',
          media_url: config.ANGEL_PHOTO_URL,
          media_height: 'MEDIUM',
          suggestions: [{ type: 'reply', text: 'View this flat', postback_data: 'L5678' }],
        },
        rcs: { card_orientation: 'VERTICAL' },
      },
    ];
  }

  if (output.includes('[FLAT_TYPE_LIST]')) {
    // Flattened from WhatsApp's 3-section list (9 rows) into 9 suggestion
    // chips — RCS supports up to 11 chips below a message. Chip text is
    // capped at 25 characters by RCS, so labels are abbreviated.
    return [{
      from: FROM, to: clientPhone, channel: 'rcs', message_type: 'text',
      text: 'What type of flat, and what budget?',
      suggestions: [
        { type: 'reply', text: 'Studio <£1000', postback_data: 'studio_less1000' },
        { type: 'reply', text: 'Studio £1-1.5k', postback_data: 'studio_1000_1500' },
        { type: 'reply', text: 'Studio >£1500', postback_data: 'studio_over1500' },
        { type: 'reply', text: '1bd <£1500', postback_data: 'onebed_less1500' },
        { type: 'reply', text: '1bd £1.5-2k', postback_data: 'onebed_1500_2000' },
        { type: 'reply', text: '1bd >£2000', postback_data: 'onebed_over2000' },
        { type: 'reply', text: '2bd <£1800', postback_data: 'twobed_less1800' },
        { type: 'reply', text: '2bd £1.8-2.2k', postback_data: 'twobed_1800_2200' },
        { type: 'reply', text: '2bd >£2200', postback_data: 'twobed_over2200' },
      ],
    }];
  }

  // The user just tapped "Book a viewing" — offer a few concrete slots
  // instead of jumping straight to a confirmation with a fixed time (see
  // conversationEngine.js's STEP 6). Reply chips carry the slot text
  // itself as postback_data, so STEP 6B can echo it back verbatim.
  if (output.includes('[TIMESLOT_LIST')) {
    const m = output.match(/\[TIMESLOT_LIST(?::\s*([^\]]+))?\]/);
    const name = (m && m[1]) ? m[1].trim() : userName;
    return [{
      from: FROM, to: clientPhone, channel: 'rcs', message_type: 'text',
      text: `Great, ${name}! What time works best for your viewing at ${propertyName}?`,
      suggestions: [
        { type: 'reply', text: 'Tomorrow 10:00', postback_data: 'Tomorrow 10:00' },
        { type: 'reply', text: 'Tomorrow 14:30', postback_data: 'Tomorrow 14:30' },
        { type: 'reply', text: 'Thu 11:00', postback_data: 'Thu 11:00' },
      ],
    }];
  }

  if (output.includes('[VIEWING_INTEREST]')) {
    return [
      {
        from: FROM, to: clientPhone, channel: 'rcs', message_type: 'card',
        card: {
          title: `${propertyName} — video tour`,
          text: `Take a look around, ${userName}!`,
          media_url: config.VIDEO_URL,
          media_height: 'MEDIUM',
        },
        rcs: { card_orientation: 'VERTICAL' },
      },
      {
        from: FROM, to: clientPhone, channel: 'rcs', message_type: 'card',
        card: {
          title: propertyName,
          text: 'Floorplan attached. Would you like to book a viewing?',
          media_url: config.FLOORPLAN_URL,
          media_height: 'MEDIUM',
          suggestions: [
            { type: 'reply', text: 'Book a viewing', postback_data: 'BOOK A VIEWING' },
            { type: 'reply', text: 'Not interested', postback_data: 'NOT INTERESTED' },
            { type: 'reply', text: 'Questions about the flat', postback_data: 'QUESTIONS ABOUT THE FLAT' },
            // Same dial suggestion as [WELCOME]/[VOICE_CALL] — WhatsApp's
            // equivalent step offers a way to reach a human directly too,
            // so mirror that here instead of leaving it only on the
            // welcome card.
            { type: 'dial', text: 'Call us', postback_data: 'call_us', phone_number: `+${config.RCS_PSTN_NUMBER}` },
          ],
        },
        rcs: { card_orientation: 'VERTICAL' },
      },
    ];
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
      from: FROM, to: clientPhone, channel: 'rcs', message_type: 'text',
      text: `Hi ${name}, we're looking forward to welcoming you at ${propertyName}, at ${appointmentTime}. Could you please confirm if this time still works for you?\n\nVonage Estate team!`,
      suggestions: [
        { type: 'reply', text: 'YES', postback_data: 'YES' },
        { type: 'reply', text: 'NO', postback_data: 'NO' },
        {
          type: 'view_location',
          text: 'View office',
          postback_data: 'view_office',
          latitude: String(config.VONAGE_OFFICE.latitude),
          longitude: String(config.VONAGE_OFFICE.longitude),
          pin_label: config.VONAGE_OFFICE.name,
        },
      ],
    }];
  }

  if (output.includes('[ASK_LOCATION]')) {
    return [{
      from: FROM, to: clientPhone, channel: 'rcs', message_type: 'text',
      text: 'Please share your current location, or type an address',
      suggestions: [{ type: 'share_location', text: 'Share location', postback_data: 'share_location' }],
    }];
  }

  return [{ from: FROM, to: clientPhone, channel: 'rcs', message_type: 'text', text: output }];
}

// RCS equivalent of whatsappFlow.js's maybeTriggerFeedbackCall — RCS has
// no "calling within RCS" concept, so this places a standard PSTN call
// (type: 'phone') to the caller's real number instead of a WhatsApp-channel
// call, from the RCS demo's linked PSTN number.
async function maybeTriggerFeedbackCall(fields) {
  if (fields.messageText !== 'YES' && fields.messageText !== 'NO') return;

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const ncco = buildAnswerNcco({ context: 'feedback_call', callerPhone: fields.clientPhone });
  const result = await createVonageCall({
    to: fields.clientPhone,
    from: config.RCS_PSTN_NUMBER,
    ncco,
    type: 'phone',
  });
  setCallContext(result.conversation_uuid, { context: 'feedback_call', phone: fields.clientPhone, channel: 'rcs' });
  logEvent('call', `Placed feedback call to ${redactPhone(fields.clientPhone)} (RCS demo)`);
}

async function handleRcsInbound(req, res) {
  res.status(200).json({ status: 'received' }); // ack immediately

  try {
    const body = req.body || {};
    if (isDuplicateMessage(body.message_uuid)) {
      console.log('Duplicate RCS webhook delivery ignored, message_uuid:', body.message_uuid);
      return;
    }

    const fields = extractFields(body);

    // Both this (Real Estate) and the Ticketing demo share the same
    // Vonage Application, RCS agent, and number — so every inbound RCS
    // message lands here regardless of which demo it's for. Resolve (and
    // remember, per phone number) which one this conversation belongs to
    // before doing anything else — see lib/demoRouter.js. Falls back to
    // this file's own (Real Estate) logic below when it's not Ticketing,
    // so existing behavior is unchanged for every current tester/QR code.
    const demo = resolveDemo(fields.clientPhone, fields.messageText);
    if (demo === DEMOS.TICKETING) {
      await processTicketingRcs(ticketingExtractFields(body));
      return;
    }

    const capturedName = captureNameFromGreeting(fields.messageText);
    if (capturedName) {
      setCallerName(fields.clientPhone, capturedName);
      fields.userName = capturedName;
    }

    // Henry's own testing convenience, mirroring ticketingWhatsappFlow.js's
    // isResetGreeting/resetTicketingJourney: re-scanning the Real Estate QR
    // code should always restart the conversation from scratch, even though
    // conversation history otherwise deliberately survives Render restarts.
    // Without this, a fresh "Welcome to Henrys Real Estate demo!" greeting
    // just gets appended onto whatever stale, already-advanced history this
    // number left behind last time it was tested.
    if (isResetGreeting(fields.messageText)) {
      resetConversation(fields.clientPhone, 'real-estate');
      logEvent('inbound', `Reset phrase detected — cleared Real Estate conversation history for ${redactPhone(fields.clientPhone)}`);
    }

    console.log('RCS inbound fields:', JSON.stringify(fields));
    logEvent('inbound', `RCS message from ${redactPhone(fields.clientPhone)}: "${fields.messageText}"`);

    const output = await decideMarker(fields);
    console.log('Claude marker decision (RCS):', output);
    logEvent('decision', `Marker decision (RCS): ${output.length > 80 ? output.slice(0, 80) + '…' : output}`);

    // STEP 3B (conversationEngine.js): the "share_location" chip tap
    // itself, not actual location data — nothing to send back. Without
    // this, that tap raced the real location message and could jump
    // straight to [PRODUCT_LIST] before the user had finished sharing.
    if (output.trim() === '[IGNORE]') {
      return;
    }

    const payloads = buildPayloads(output, fields);

    for (const payload of payloads) {
      await sendVonageMessage(payload);
      const kind = payload.message_type === 'card' ? `card "${payload.card.title}"` : payload.message_type;
      logEvent('outbound', `Sent RCS ${kind} to ${redactPhone(fields.clientPhone)}`);
    }

    await maybeTriggerFeedbackCall(fields);
  } catch (err) {
    console.error('handleRcsInbound error:', err);
  }
}

module.exports = { handleRcsInbound };
