const config = require('./businessConfig');
const { buildAnswerNcco } = require('./nccoBuilder');
const { sendVonageMessage } = require('./vonageApi');
const { getCallContext, setCallContext } = require('./store');
const { buildCallSummary } = require('./callSummary');

// Answer URL — replaces Flow 5. Vonage calls this (GET, per the old flow's
// convention) when a call comes in — including WhatsApp-channel calls, once
// the Alpha feature is enabled on the Application. Returns an NCCO that
// connects the call directly into our realtime voice AI over a websocket,
// instead of the old record+talk+input turn-based loop.
function handleAnswer(req, res) {
  const q = req.method === 'GET' ? req.query : req.body;
  const ncco = buildAnswerNcco({
    context: 'inbound_inquiry',
    callerPhone: q.from,
    callUuid: q.uuid,
    conversationUuid: q.conversation_uuid,
  });
  setCallContext(q.conversation_uuid, { context: 'inbound_inquiry', phone: q.from });
  res.status(200).json(ncco);
}

// Event URL — replaces Flow 4's call-state handling. `eventType:
// synchronous` on the connect action (see nccoBuilder.js) means Vonage will
// also use this URL as a fallback NCCO source if the websocket connect
// itself fails (timeout/busy/rejected/unanswered/failed).
async function handleEvents(req, res) {
  res.status(200).json({ status: 'ok' }); // ack immediately

  try {
    const body = req.body || {};
    console.log('Vonage call event:', JSON.stringify(body));

    // Fallback NCCO cases (connect couldn't establish) — talk a short
    // message back instead of leaving the caller on dead air. Only applies
    // when eventType:synchronous requested an NCCO (Vonage expects one back
    // in the HTTP response body in that case) — for a plain state
    // notification, ignore.
    if (['timeout', 'failed', 'rejected', 'unanswered', 'busy'].includes(body.status)) {
      return; // response already sent above as ack; synchronous fallback
      // NOTE: if you see calls going dead on failure, switch this route to
      // respond conditionally instead of ack-first — see setup guide.
    }

    if (body.status === 'completed') {
      const context = getCallContext(body.conversation_uuid);
      const phone = context?.phone || body.from || body.to;
      if (phone) {
        await sendFollowUp(phone, context?.context);

        if (context?.elevenConversationId) {
          const summary = await buildCallSummary(context.elevenConversationId);
          if (summary) {
            await sendVonageMessage({
              from: config.FROM_WHATSAPP,
              to: phone,
              channel: 'whatsapp',
              message_type: 'text',
              text: summary,
            });
          }
        } else {
          console.error('No ElevenLabs conversation_id captured for', body.conversation_uuid, '— skipping call summary.');
        }
      }
    }
  } catch (err) {
    console.error('handleEvents error:', err);
  }
}

async function sendFollowUp(phone, context) {
  if (context === 'feedback_call') {
    await sendVonageMessage({
      from: config.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'text',
      text: 'Thank you for your feedback! Our team will review it and get back to you shortly. Have a wonderful day!',
    });
    return;
  }

  // Default: inbound inquiry call just ended — send the viewing follow-up
  // template (ported from Flow 5's disconnected "Build WA Follow-up" node).
  // Reuses the same approved "henry_confirmationviewing" template used in
  // the WhatsApp text flow's [VIEWING_INTEREST] step — the name used here
  // previously ("henry_realestateviewing") didn't match any real template.
  await sendVonageMessage({
    from: config.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'custom',
    custom: {
      type: 'template',
      template: {
        name: 'henry_confirmationviewing',
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: "Regent's Park" }] },
          { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'BOOK A VIEWING' }] },
          { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'NOT INTERESTED' }] },
          { type: 'button', sub_type: 'quick_reply', index: 2, parameters: [{ type: 'payload', payload: 'QUESTIONS ABOUT THE FLAT' }] },
        ],
      },
    },
  });
}

module.exports = { handleAnswer, handleEvents };
