const { randomUUID } = require('crypto');
const config = require('./businessConfig');
const { buildAnswerNcco } = require('./nccoBuilder');
const { sendVonageMessage } = require('./vonageApi');
const { getCallContext, setCallContext, setCallSummaryText, getCallerName, getActiveDemo, getTicketingState } = require('./store');
const { fetchTranscriptWithRetry, summarizeTranscript, analyzeBookingIntent } = require('./callSummary');
const { logEvent, redactPhone } = require('./activityLog');
const { DEMOS } = require('./demoRouter');
const { maybeContinueJourney } = require('./ticketingWhatsappFlow');

function normalizeNumber(n) {
  return String(n || '').replace(/\D/g, '');
}

// All four demos share one Vonage Application, Answer URL, and Event URL —
// so this is the one place that tells them apart. Inbound calls to the RCS
// demo's linked PSTN number (config.RCS_PSTN_NUMBER) get the 'rcs' channel
// tag; calls to the Ticketing demo's dedicated WABA number get 'whatsapp'
// with a definite Ticketing demo (see detectDemo below — no ambiguity,
// unlike the RCS number, since this number is only ever dialed from within
// that one demo's WhatsApp Calling button); everything else (the original
// Real Estate WhatsApp-calling number) keeps the existing 'whatsapp'
// behavior. Used below to decide where the post-call recap goes.
function detectChannel(toNumber) {
  if (normalizeNumber(toNumber) === normalizeNumber(config.RCS_PSTN_NUMBER)) return 'rcs';
  return 'whatsapp';
}

// Ticketing's RCS "Contact us" escalation dials the SAME PSTN number as the
// Real Estate RCS demo (per design — no second virtual number), so a call
// arriving there could be for either demo. The only signal available is
// which demo this caller's phone number was last resolved to over RCS text
// (store.js, set by lib/demoRouter.js) — same cross-channel lookup already
// used for callerName.
//
// The Ticketing WhatsApp demo currently shares the Real Estate demo's WABA
// number (see businessConfig.js's TICKETING.WHATSAPP.FROM_WHATSAPP comment
// for why) rather than dialing a genuinely dedicated one — so a call
// landing on that number is exactly as ambiguous as the RCS PSTN number
// already is, and resolved the same way: whichever demo this caller's
// phone number was last bound to over text (store.js, set by
// lib/demoRouter.js's resolveDemo() — called from both the RCS AND
// WhatsApp inbound-text paths now, see server.js).
//
// If a truly dedicated Ticketing WhatsApp number is ever linked later
// (TICKETING.WHATSAPP.FROM_WHATSAPP no longer equal to FROM_WHATSAPP),
// that number becomes unambiguous on its own — checked first below.
//
// Falls back to 'real-estate' for a cold call with no prior text message
// from that number, on either shared number.
function detectDemo(toNumber, fromNumber) {
  const dedicatedTicketingNumber = config.TICKETING.WHATSAPP.FROM_WHATSAPP;
  const hasDedicatedNumber = normalizeNumber(dedicatedTicketingNumber) !== normalizeNumber(config.FROM_WHATSAPP);
  if (hasDedicatedNumber && normalizeNumber(toNumber) === normalizeNumber(dedicatedTicketingNumber)) {
    return DEMOS.TICKETING;
  }
  return getActiveDemo(fromNumber) === DEMOS.TICKETING ? DEMOS.TICKETING : DEMOS.REAL_ESTATE;
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
  const demo = detectDemo(q.to, q.from);
  // meta.context (realtimeBridge.js) reads this to pick the right
  // ElevenLabs agent persona; the 'ticketing_' prefix is what it matches on.
  const context = demo === DEMOS.TICKETING ? 'ticketing_inquiry' : 'inbound_inquiry';
  const ncco = buildAnswerNcco({
    context,
    callerPhone: q.from,
    callUuid: q.uuid,
    conversationUuid: q.conversation_uuid,
  });
  setCallContext(q.conversation_uuid, {
    context,
    phone: q.from,
    channel,
    demo,
    // Populated if this caller previously messaged in via the demo
    // landing page's pre-filled greeting (see whatsappFlow.js/rcsFlow.js)
    // — lets the post-call recap use their real first name instead of the
    // generic "there" fallback.
    callerName: getCallerName(q.from),
  });
  logEvent('call', `Inbound call answered from ${redactPhone(q.from)} (${channel}${demo === DEMOS.TICKETING ? '/ticketing' : ''})`);
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
        if (context?.demo === DEMOS.TICKETING && context?.channel === 'whatsapp') {
          await sendTicketingWhatsappCallFollowUp(phone, context);
        } else if (context?.demo === DEMOS.TICKETING) {
          await sendTicketingCallFollowUp(phone, context);
        } else if (context?.context === 'feedback_call') {
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

              // henry_form2 (approved shape, Utility • Flows category, per
              // Meta template manager): header "Thanks" has no variable, so
              // no header component is sent. Body has two variables — {{1}}
              // the caller's name (sample "Henry"), {{2}} the company name
              // (sample "Vonage" in the template editor's preview, but sent
              // here as "Vonage Estate" to match every other template's
              // company-name parameter). The single button is a "Complete
              // flow" button (sub_type: flow) wired to the template's own
              // pre-defined "Survey" screen — no flow_action_data needed for
              // a pre-defined screen, just a unique flow_token per send.
              // Sent unconditionally, right after the call recap, regardless
              // of booking intent.
              await sendVonageMessage({
                from: config.FROM_WHATSAPP,
                to: phone,
                channel: 'whatsapp',
                message_type: 'custom',
                custom: {
                  type: 'template',
                  template: {
                    namespace: config.TEMPLATE_NAMESPACE,
                    name: 'henry_form2',
                    language: { policy: 'deterministic', code: 'en' },
                    components: [
                      {
                        type: 'body',
                        parameters: [
                          { type: 'text', text: callerName },
                          { type: 'text', text: 'Vonage Estate' },
                        ],
                      },
                      {
                        type: 'button',
                        sub_type: 'flow',
                        index: 0,
                        parameters: [{ type: 'action', action: { flow_token: randomUUID() } }],
                      },
                    ],
                  },
                },
              });
              logEvent('outbound', `Sent henry_form2 survey (Flow) to ${redactPhone(phone)}`);

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

// Post-call follow-up for the Ticketing demo's "Contact us" voice
// escalation — a simpler, RCS-only counterpart to the Real Estate branch
// above (no PDF recap, no booking-intent detection/appointment template,
// since the original ticketing flow has no equivalent concept). Just a
// short Claude-written recap of what was discussed, sent back over RCS
// from the same RCS agent the text conversation used.
async function sendTicketingCallFollowUp(phone, context) {
  if (!context?.elevenConversationId) {
    logEvent('call', `No transcript available for Ticketing call with ${redactPhone(phone)} — follow-up skipped`);
    return;
  }
  const transcript = await fetchTranscriptWithRetry(context.elevenConversationId);
  if (!transcript) {
    logEvent('call', `No transcript available for Ticketing call with ${redactPhone(phone)} — follow-up skipped`);
    return;
  }
  const summary = await summarizeTranscript(transcript, { businessName: config.TICKETING.EVENT_NAME });
  const callerName = context?.callerName || 'there';
  await sendVonageMessage({
    from: config.RCS_AGENT_ID,
    to: phone,
    channel: 'rcs',
    message_type: 'text',
    text: `Hi ${callerName}, thanks for calling about your ${config.TICKETING.EVENT_NAME} visit! ${summary}`,
  });
  logEvent('outbound', `Sent Ticketing call follow-up to ${redactPhone(phone)}`);
}

// WhatsApp counterpart to sendTicketingCallFollowUp below — same
// reasoning (a short Claude-written recap, no PDF/booking-intent
// machinery, since the ticketing flow has no viewing-appointment concept)
// but sent as free-form WhatsApp text from the Ticketing WABA number. A
// free-form send is safe here (unlike the Real Estate demo's henry_callrecap
// template) because this call can only ever be reached via the in-chat
// [T_VOICE_CALL] button, which means a 24h session window is always open.
async function sendTicketingWhatsappCallFollowUp(phone, context) {
  if (!context?.elevenConversationId) {
    logEvent('call', `No transcript available for Ticketing WhatsApp call with ${redactPhone(phone)} — follow-up skipped`);
    return;
  }
  const transcript = await fetchTranscriptWithRetry(context.elevenConversationId);
  if (!transcript) {
    logEvent('call', `No transcript available for Ticketing WhatsApp call with ${redactPhone(phone)} — follow-up skipped`);
    return;
  }
  const summary = await summarizeTranscript(transcript, { businessName: config.TICKETING.EVENT_NAME });
  const callerName = context?.callerName || 'there';
  await sendVonageMessage({
    from: config.TICKETING.WHATSAPP.FROM_WHATSAPP,
    to: phone,
    channel: 'whatsapp',
    message_type: 'text',
    text: `Hi ${callerName}, thanks for calling about your ${config.TICKETING.EVENT_NAME} visit! ${summary}`,
  });
  logEvent('outbound', `Sent Ticketing WhatsApp call follow-up to ${redactPhone(phone)}`);

  // Same reasoning as the FAQ auto-continue (ticketingWhatsappFlow.js): a
  // phone call is a side interaction, not a reply that's supposed to
  // advance the journey — without this, the conversation dead-ends the
  // moment a visitor calls instead of texting. Resume with whatever this
  // stage's unconditional next step is, if it has one.
  const state = getTicketingState(phone);
  await maybeContinueJourney({ clientPhone: phone, userName: callerName }, state);
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
