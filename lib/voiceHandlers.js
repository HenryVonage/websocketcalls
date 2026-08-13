const config = require('./businessConfig');
const { buildAnswerNcco } = require('./nccoBuilder');
const { sendVonageMessage } = require('./vonageApi');
const { getCallContext, setCallContext, setCallSummaryText, getCallerName } = require('./store');
const { fetchTranscriptWithRetry, summarizeTranscript, analyzeBookingIntent } = require('./callSummary');
const { logEvent, redactPhone } = require('./activityLog');

function normalizeNumber(n) {
  return String(n || '').replace(/\D/g, '');
}

// Both demos share one Vonage Application, Answer URL, and Event URL — so
// this is the one place that tells the two apart. Inbound calls to the
// RCS demo's linked PSTN number (config.RCS_PSTN_NUMBER) get the 'rcs'
// channel tag; everything else (the original WhatsApp-calling number)
// keeps the existing 'whatsapp' behavior. Used below to decide where the
// post-call recap/appointment gets sent.
function detectChannel(toNumber) {
  return normalizeNumber(toNumber) === normalizeNumber(config.RCS_PSTN_NUMBER) ? 'rcs' : 'whatsapp';
}

// Answer URL — replaces Flow 5. Vonage calls this (GET, per the old flow's
// convention) when a call comes in — including WhatsApp-channel calls and,
// now, plain PSTN calls to the RCS demo's number. Returns an NCCO that
// connects the call directly into our realtime voice AI over a websocket,
// instead of the old record+talk+input turn-based loop. This part needed
// no changes to support the new PSTN number — Vonage routes any inbound
// call on this Application here regardless of which linked number was
// dialed, so the ElevenLabs bridge already "just works" for it.
function handleAnswer(req, res) {
  const q = req.method === 'GET' ? req.query : req.body;
  const channel = detectChannel(q.to);
  const ncco = buildAnswerNcco({
    context: 'inbound_inquiry',
    callerPhone: q.from,
    callUuid: q.uuid,
    conversationUuid: q.conversation_uuid,
  });
  setCallContext(q.conversation_uuid, {
    context: 'inbound_inquiry',
    phone: q.from,
    channel,
    // Populated if this caller previously messaged in via the demo
    // landing page's pre-filled greeting (see whatsappFlow.js/rcsFlow.js)
    // — lets the post-call recap use their real first name instead of the
    // generic "there" fallback.
    callerName: getCallerName(q.from),
  });
  logEvent('call', `Inbound call answered from ${redactPhone(q.from)} (${channel})`);
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
    if (body.status) {
      logEvent('call', `Call event: ${body.status}${body.from ? ` (${redactPhone(body.from)})` : ''}`);
    }

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
      const demoChannel = context?.channel || 'whatsapp';
      if (phone) {
        if (context?.context === 'feedback_call') {
          await sendFeedbackThankYou(phone, demoChannel);
        } else if (context?.elevenConversationId) {
          // Fetch the transcript once, then reuse it for both the recap
          // and the booking-intent check below — avoids a second round of
          // ElevenLabs retries for the same call.
          const transcript = await fetchTranscriptWithRetry(context.elevenConversationId);
          if (transcript) {
            const [summary, booking] = await Promise.all([
              summarizeTranscript(transcript),
              analyzeBookingIntent(transcript),
            ]);

            // Sent as an approved template (not free-form text) — a caller
            // may trigger an inbound voice call without ever having sent a
            // WhatsApp message first, in which case there's no open 24h
            // session window and a free-form text send would be rejected.
            // Templates work regardless of session-window state.
            //
            // henry_callrecap (approved shape, per Meta template manager):
            //   header: DOCUMENT — a PDF, fetched by WhatsApp from a public
            //     URL at send time. We stash the summary text in-memory
            //     (store.js) and render it on demand at
            //     /call-summary/:conversationUuid.pdf (see server.js,
            //     pdfSummary.js) rather than pre-generating a file.
            //   body: single {{1}} variable — "Hello {{1}}, thanks for your
            //     call. Please find a summary of our call." This is the
            //     caller's name, NOT the recap text itself (that lives in
            //     the PDF). Populated from store.js's callerNames map
            //     (captured on the demo landing page / first WhatsApp
            //     message — see whatsappFlow.js), with a "there" fallback
            //     for callers who reach this without going through the
            //     landing page flow.
            setCallSummaryText(body.conversation_uuid, summary);
            const base = process.env.PUBLIC_BASE_URL || 'https://websocketcalls.onrender.com';
            const documentUrl = `${base}/call-summary/${body.conversation_uuid}.pdf`;
            const callerName = context?.callerName || body.from_name || body.caller_name || 'there';
            const bookingName = context?.callerName || booking?.name || 'there';
            const bookingProperty = booking?.propertyName || "Regent's Park";
            const bookingTime = booking?.appointmentTime || 'a time our team will confirm with you';

            if (demoChannel === 'rcs') {
              // RCS has no template-approval system, so the recap/booking
              // messages are sent directly — no pre-approved "henry_*"
              // template needed here, just the same PDF route reused from
              // the WhatsApp demo, linked via a confirmed-safe open_url
              // suggestion (RCS's own PDF-in-card support is India-only
              // per Vonage's docs, so a card header wasn't used here).
              await sendVonageMessage({
                from: config.RCS_AGENT_ID,
                to: phone,
                channel: 'rcs',
                message_type: 'text',
                text: `Hi ${callerName}, thanks for calling Vonage Estate! Tap below for your call recap.`,
                suggestions: [
                  { type: 'open_url', text: 'View recap', postback_data: 'view_recap', url: documentUrl, description: 'Call recap PDF' },
                ],
              });
              logEvent('outbound', `Sent RCS call recap (PDF link) to ${redactPhone(phone)}`);

              if (booking?.wantsViewing) {
                await sendVonageMessage({
                  from: config.RCS_AGENT_ID,
                  to: phone,
                  channel: 'rcs',
                  message_type: 'text',
                  text: `Hi ${bookingName}, we're looking forward to welcoming you at ${bookingProperty}, at ${bookingTime}. Could you please confirm if this time still works for you?\n\nVonage Estate team!`,
                  suggestions: [
                    { type: 'reply', text: 'YES', postback_data: 'YES' },
                    { type: 'reply', text: 'NO', postback_data: 'NO' },
                  ],
                });
                logEvent('outbound', `Sent RCS appointment confirmation to ${redactPhone(phone)} (booking intent detected)`);
              }
            } else {
              await sendVonageMessage({
                from: config.FROM_WHATSAPP,
                to: phone,
                channel: 'whatsapp',
                message_type: 'custom',
                custom: {
                  type: 'template',
                  template: {
                    namespace: config.TEMPLATE_NAMESPACE,
                    name: 'henry_callrecap',
                    language: { policy: 'deterministic', code: 'en' },
                    components: [
                      {
                        type: 'header',
                        parameters: [
                          { type: 'document', document: { link: documentUrl, filename: 'call-summary.pdf' } },
                        ],
                      },
                      {
                        type: 'body',
                        parameters: [{ type: 'text', text: callerName }],
                      },
                    ],
                  },
                },
              });
              logEvent('outbound', `Sent henry_callrecap (PDF) to ${redactPhone(phone)}`);

              // Replaces the old unconditional henry_confirmationviewing
              // follow-up — that template no longer applies to voice calls.
              // Instead, only send henryappointment if the caller actually
              // expressed interest in booking a viewing during the call.
              if (booking?.wantsViewing) {
                await sendVonageMessage({
                  from: config.FROM_WHATSAPP,
                  to: phone,
                  channel: 'whatsapp',
                  message_type: 'custom',
                  custom: {
                    type: 'template',
                    template: {
                      namespace: config.TEMPLATE_NAMESPACE,
                      name: 'henryappointment',
                      language: { policy: 'deterministic', code: 'en' },
                      components: [
                        { type: 'header', parameters: [{ type: 'location', location: config.VONAGE_OFFICE }] },
                        {
                          type: 'body',
                          parameters: [
                            { type: 'text', text: bookingName },
                            { type: 'text', text: bookingProperty },
                            { type: 'text', text: bookingTime },
                            { type: 'text', text: 'Vonage Estate' },
                          ],
                        },
                        { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'YES' }] },
                        { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'NO' }] },
                      ],
                    },
                  },
                });
                logEvent('outbound', `Sent henryappointment to ${redactPhone(phone)} (booking intent detected)`);
              }
            }
          } else {
            logEvent('call', `No transcript available for call with ${redactPhone(phone)} — recap skipped`);
          }
        } else {
          console.error('No ElevenLabs conversation_id captured for', body.conversation_uuid, '— skipping call summary.');
          logEvent('call', `No transcript available for call with ${redactPhone(phone)} — recap skipped`);
        }
      }
    }
  } catch (err) {
    console.error('handleEvents error:', err);
  }
}

async function sendFeedbackThankYou(phone, demoChannel = 'whatsapp') {
  const isRcs = demoChannel === 'rcs';
  await sendVonageMessage({
    from: isRcs ? config.RCS_AGENT_ID : config.FROM_WHATSAPP,
    to: phone,
    channel: isRcs ? 'rcs' : 'whatsapp',
    message_type: 'text',
    text: 'Thank you for your feedback! Our team will review it and get back to you shortly. Have a wonderful day!',
  });
  logEvent('outbound', `Sent feedback thank-you to ${redactPhone(phone)} (${demoChannel})`);
}

module.exports = { handleAnswer, handleEvents };
