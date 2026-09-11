const { randomUUID } = require('crypto');
const config = require('./businessConfig');
const musicConfig = require('./musicLoversConfig');
const { buildAnswerNcco } = require('./nccoBuilder');
const { sendVonageMessage } = require('./vonageApi');
const {
  getCallContext,
  setCallContext,
  setCallSummaryText,
  getCallerName,
  getActiveDemo,
  getTicketingState,
  getMusicLoversState,
  setMusicTicketDetails,
} = require('./store');
const { fetchTranscriptWithRetry, summarizeTranscript, analyzeBookingIntent, analyzeTicketIntent } = require('./callSummary');
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
// Music Lovers (Sept 2026, henry_ticketingconcert's "Call on WhatsApp"
// button) shares the same WABA number as Real Estate/Ticketing too — see
// musicLoversConfig.js's FROM_WHATSAPP comment — so it's exactly as
// ambiguous on a cold call as Ticketing already was, and resolved the same
// way: whichever demo this caller's phone number was last bound to over
// text (demoRouter.js's resolveDemo(), which tags MUSIC_LOVERS via its own
// greeting-keyword match).
function detectDemo(toNumber, fromNumber) {
  const dedicatedTicketingNumber = config.TICKETING.WHATSAPP.FROM_WHATSAPP;
  const hasDedicatedNumber = normalizeNumber(dedicatedTicketingNumber) !== normalizeNumber(config.FROM_WHATSAPP);
  if (hasDedicatedNumber && normalizeNumber(toNumber) === normalizeNumber(dedicatedTicketingNumber)) {
    return DEMOS.TICKETING;
  }
  const active = getActiveDemo(fromNumber);
  if (active === DEMOS.TICKETING) return DEMOS.TICKETING;
  if (active === DEMOS.MUSIC_LOVERS) return DEMOS.MUSIC_LOVERS;
  return DEMOS.REAL_ESTATE;
}

// Everything the Music Lovers ElevenLabs voice persona (realtimeBridge.js)
// needs to talk about this specific caller's song and, if they got that
// far, the specific concert musicLoversFlow.js's sendConcertsTemplate
// resolved for them (see that function's concertArtist/concertDetails
// state fields). Either can be missing — a caller who dials in without
// ever finishing the WhatsApp journey on this phone, or without ever
// asking about concerts — so this always returns every key with a safe ''
// default rather than partial/undefined fields; the agent's own prompt is
// what decides how to handle a blank value (see the prompt drafted for
// Henry: "don't pretend to know them").
function buildMusicLoversDynamicVariables(phone) {
  const state = getMusicLoversState(phone) || {};
  const details = state.concertDetails || {};
  return {
    caller_name: getCallerName(phone) || 'there',
    artist_name: state.concertArtist || state.artist || '',
    song_title: state.title || '',
    concert_venue: details.venue || '',
    concert_date: details.date || '',
    concert_url: details.url || '',
  };
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
  // ElevenLabs agent persona; the 'ticketing_'/'music_lovers_' prefixes are
  // what it matches on.
  let context = 'inbound_inquiry';
  let dynamicVariables;
  if (demo === DEMOS.TICKETING) {
    context = 'ticketing_inquiry';
  } else if (demo === DEMOS.MUSIC_LOVERS) {
    context = 'music_lovers_concert';
    // NCCO/Vonage websocket headers only carry small routing strings (see
    // nccoBuilder.js) — this richer payload travels via callContext
    // (store.js) instead, keyed by conversationUuid, which realtimeBridge.js
    // already has available to look it up by.
    dynamicVariables = buildMusicLoversDynamicVariables(q.from);
  }
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
    dynamicVariables,
  });
  logEvent(
    'call',
    `Inbound call answered from ${redactPhone(q.from)} (${channel}${
      demo === DEMOS.TICKETING ? '/ticketing' : demo === DEMOS.MUSIC_LOVERS ? '/music-lovers' : ''
    })`
  );
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
        } else if (context?.demo === DEMOS.MUSIC_LOVERS) {
          // Music Lovers used to have no dedicated branch here at all, so a
          // completed call fell through into the generic Real-Estate branch
          // below and got Real-Estate-flavored messaging (henry_callrecap
          // with "Vonage Estate" wording, henry_form2, possibly
          // henryappointment) — wrong business, wrong booking concept. See
          // sendMusicLoversCallFollowUp below for the two outcomes Henry
          // asked for (Sept 2026): a ticket-confirmation template if the
          // caller ordered tickets, otherwise a plain call-recap PDF.
          await sendMusicLoversCallFollowUp(phone, context, body.conversation_uuid);
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

              // henry_callrecap's header is a document (the PDF) — WhatsApp
              // has to fetch it from our /call-summary/:id.pdf route before
              // that message can actually be delivered. So even though this
              // API call returns before the messages below are sent, the
              // recap can otherwise still land on the phone *after* them
              // (they carry no media to fetch, so they deliver almost
              // instantly). Give the recap a head start so it reliably
              // arrives first — this was reported as henry_form2 showing up
              // before the recap in practice.
              await new Promise((resolve) => setTimeout(resolve, 4000));

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
              // Sent after the short delay above so it reliably arrives
              // after the call recap, regardless of booking intent.
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

// Post-call follow-up for the Music Lovers demo's inbound-call ticketing
// agent (Sept 2026, Henry's request, verbatim: "if the user has ordered
// concert tickets > send the templated message 'henry_ticketing2' ...
// Then if the user click on 'My tickets over WhatsApp', please generate a
// fake ticket ... if the user doesn't make an inbound call to book ticket,
// just send an outbound message with a .pdf that summarizes what the
// discussion was about."). Two outcomes, decided by analyzeTicketIntent:
//   - Ticket intent detected (and this caller actually has a concert on
//     file, from an earlier henry_ticketingconcert send — see
//     musicLoversFlow.js's sendConcertsTemplate): send henry_ticketing2 and
//     stash a fake ticket for the "My tickets over WhatsApp" button
//     (musicLoversFlow.js's handleMyTicketsButtonTap).
//   - Otherwise: plain PDF call-recap, same henry_callrecap/PDF-route
//     mechanism the Real Estate branch uses, just Music-Lovers-worded.
//
// henry_ticketing2's real approved shape (confirmed via the enhanced
// /admin/whatsapp-templates?name= diagnostic route, Sept 2026 — two earlier
// image attachments of its design failed to come through in chat):
//   header: IMAGE
//   body (4 vars): "Dear {{1}}, Thank you for your order {{2}}. We can't
//     wait to see you at the {{3}}. To best prepare your venue, you can
//     download the {{4}} app..." — Henry's own approved copy reuses the
//     venue/event name in BOTH {{3}} and {{4}} (its own example values are
//     the same string twice), matching his instruction to replace both with
//     the venue name.
//   buttons: [0] URL "Download the App" — static, no component needed (see
//     ticketing3bis's same pattern); [1] QUICK_REPLY "MY TICKETS OVER
//     WHATSAPP" — the button Henry described; [2] QUICK_REPLY "OTHER
//     QUESTION" — sendable (every quick_reply button needs its own payload
//     component or the send is rejected) but not wired to anything yet;
//     Henry only asked for the "My tickets" tap to do something.
async function sendMusicLoversCallFollowUp(phone, context, conversationUuid) {
  if (!context?.elevenConversationId) {
    logEvent('call', `No transcript available for Music Lovers call with ${redactPhone(phone)} — follow-up skipped`);
    return;
  }
  const transcript = await fetchTranscriptWithRetry(context.elevenConversationId);
  if (!transcript) {
    logEvent('call', `No transcript available for Music Lovers call with ${redactPhone(phone)} — follow-up skipped`);
    return;
  }

  const callerName = context?.callerName || 'there';
  const musicState = getMusicLoversState(phone) || {};
  const artist = musicState.concertArtist || musicState.artist;
  const venue = musicState.concertDetails?.venue;

  const [summary, ticketIntent] = await Promise.all([
    summarizeTranscript(transcript, { businessName: 'Vonage Music Lovers' }),
    analyzeTicketIntent(transcript),
  ]);

  // Only takes the ticket-confirmation path when the caller actually asked
  // for tickets AND there's a real artist+venue on file for them — a caller
  // who never got as far as henry_ticketingconcert (or who cold-calls in)
  // has no concertArtist/concertDetails yet, so there's nothing genuine to
  // put on a "ticket" for them; falls back to the plain recap instead of
  // sending a ticket with fabricated event details.
  if (ticketIntent?.wantsTickets && artist && venue) {
    const orderNumber = `ML-${Math.floor(100000 + Math.random() * 900000)}`;
    const ticketKey = randomUUID();
    const ticketName = ticketIntent.name && ticketIntent.name !== 'there' ? ticketIntent.name : callerName;
    setMusicTicketDetails(phone, {
      ticketKey,
      orderNumber,
      name: ticketName,
      artist,
      venue,
      date: musicState.concertDetails?.date || 'date TBA',
    });

    await sendVonageMessage({
      from: config.FROM_WHATSAPP,
      to: phone,
      channel: 'whatsapp',
      message_type: 'custom',
      custom: {
        type: 'template',
        template: {
          namespace: config.TEMPLATE_NAMESPACE,
          name: 'henry_ticketing2',
          language: { policy: 'deterministic', code: 'en' },
          components: [
            // Henry's instruction: reuse the same image already used as
            // the Music Lovers demo's 1st outbound (henry_musicselection's
            // header — see musicLoversConfig.js's GENRE_PROMPT_HEADER_IMAGE_URL).
            { type: 'header', parameters: [{ type: 'image', image: { link: musicConfig.GENRE_PROMPT_HEADER_IMAGE_URL } }] },
            {
              type: 'body',
              parameters: [
                { type: 'text', text: ticketName },
                { type: 'text', text: orderNumber },
                { type: 'text', text: venue },
                { type: 'text', text: venue },
              ],
            },
            // Button 0 ("Download the App") is a fully static URL button —
            // omitted, same as henry_ticketing3bis's static Shuttle-service
            // button (businessConfig.js). Buttons 1 and 2 are QUICK_REPLY,
            // which DO need their own payload component each or the send
            // is rejected as a shape mismatch — payload text is ours to
            // choose freely, matched on directly (not the button's own
            // displayed label) by handleMyTicketsButtonTap in
            // musicLoversFlow.js, so a future wording edit to the template
            // in WhatsApp Manager can't silently break the match.
            { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'ML_MY_TICKETS' }] },
            { type: 'button', sub_type: 'quick_reply', index: 2, parameters: [{ type: 'payload', payload: 'ML_OTHER_QUESTION' }] },
          ],
        },
      },
    });
    logEvent('outbound', `Sent henry_ticketing2 (order ${orderNumber}, ${artist}) to ${redactPhone(phone)}`);
    return;
  }

  // No ticket intent (or no concert on file) — plain PDF call-recap, same
  // henry_callrecap/PDF-route mechanism as the Real Estate branch, reused
  // as-is per Henry's own request ("reuse the same logic than the one
  // created for the Real estate demo").
  if (conversationUuid) {
    setCallSummaryText(conversationUuid, summary);
  }
  const base = process.env.PUBLIC_BASE_URL || 'https://websocketcalls.onrender.com';
  const documentUrl = `${base}/call-summary/${conversationUuid}.pdf`;
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
          { type: 'header', parameters: [{ type: 'document', document: { link: documentUrl, filename: 'call-summary.pdf' } }] },
          { type: 'body', parameters: [{ type: 'text', text: callerName }] },
        ],
      },
    },
  });
  logEvent('outbound', `Sent henry_callrecap (PDF) to ${redactPhone(phone)} (Music Lovers, no ticket intent)`);
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
