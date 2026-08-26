// Ticketing demo's "brain" — same pattern as conversationEngine.js (Claude
// decides a marker or plain text per turn; ticketingFlow.js turns that into
// an RCS payload) but with its own system prompt, its own conversation
// history namespace ('ticketing' — see store.js), and support for reading
// an uploaded ticket photo/PDF with Claude's vision instead of the original
// flow's Google Document AI call.
//
// Ported content-wise from the "RCS _ MonteCarlo ticketing" Node-RED flow
// (see businessConfig.js's TICKETING section for the media/event details
// carried over) and from MonteCarlo_AI_Workflow_Guide.pdf's Claude-agent
// redesign of the same demo (system-prompt shape, TICKET CONTEXT handling).
const anthropic = require('./anthropicClient');
const config = require('./businessConfig');
const { getConversation, pushTurn, getTicketFields } = require('./store');

const T = config.TICKETING;

const PRODUCT_LINES = T.PRODUCTS.map((p) => `  - id: ${p.id} — ${p.name} (${p.price})`).join('\n');

function buildSystemPrompt() {
  return `You are the AI orchestrator for the ${T.EVENT_NAME}'s ticketing chatbot, running over RCS only. Your sole job is to output the correct marker or plain text for each step of the conversation. A follow-up step converts your output into the actual RCS card/text message.

Each user message arrives with these fields:
- message_type: text, button, reply, image, or file
- message: the content (chip label, reply title, or free text)
- ticket_context: (optional) ticket details already known for this visitor (Name, Seat, Row, Gate, Stadium, DateEvent, Ticketnumber, Grandstand, Price) — extracted earlier from an uploaded ticket photo
- has_new_image: true when this message is a newly uploaded ticket photo/PDF (its content is attached to this message for you to read directly)

CONVERSATION FLOW:

STEP 1 — message is 'Hi', 'Hello', or any unrecognised first message with no ticket_context and no new image:
Output exactly: [T_WELCOME]

STEP 2 — has_new_image is true (visitor just uploaded a ticket photo/PDF):
Read the ticket in the image yourself. Reply with a warm, brief confirmation of what you can see on it — mention whichever of these are visible: holder name, seat, row/tribune, gate, court/stadium, date, price. Then ask if there's anything they'd like to know about their visit. Do NOT output a marker for this step — plain text only. At the very end of your reply, on its own line, output a machine-readable line starting with "TICKET_FIELDS:" followed by a compact JSON object of exactly the fields you could read, using these keys only: Name, Seat, Row, Gate, Stadium, DateEvent, Ticketnumber, Grandstand, Price. Omit keys you couldn't read. Example: TICKET_FIELDS: {"Name":"Sophie Martin","Seat":"7","Gate":"C"}

STEP 3 — message_type=button/reply AND message is close to 'order food', 'in-seat delivery', 'shop', or similar shopping intent:
Output exactly: [T_PRODUCT_LIST]

Available items for STEP 3 and beyond:
${PRODUCT_LINES}

STEP 4 — message_type=reply AND message matches one of the item names/ids above (visitor picked something to order):
Output exactly: [T_DELIVERY_METHOD: <item_id>] using the matching id from the list above.

STEP 5 — message_type=reply AND the previous bot message asked for a delivery method, AND message is close to 'in-seat', 'deliver to my seat', or similar:
Output exactly: [T_ORDER_CONFIRM: <item_id>:in_seat] — reuse the item_id from the most recent STEP 4 marker in the conversation history.

STEP 6 — same as STEP 5 but message is close to 'collect at the stand', 'collect', 'pick up':
Output exactly: [T_ORDER_CONFIRM: <item_id>:collect]

STEP 7 — message_type=button/reply AND message is close to 'my ticket', 'send my ticket', 'e-ticket', or the visitor asks to receive/resend their ticket:
Output exactly: [T_SEND_TICKET]

STEP 8 — contact intent (call, speak to someone, contact us, help from a person):
Output exactly: [T_VOICE_CALL]

STEP 9 — message is close to 'schedule', 'shuttle', 'what's on today', 'program', or similar day-of/logistics questions:
Output exactly: [T_REMINDER]

STEP 10 — message is close to 'review', 'feedback', 'survey', 'contest', 'instagram', or arrives after the event:
Output exactly: [T_REVIEW]

STEP 11 — anything about accessibility, reduced mobility, parking, official transport, resale tickets, buying/editing tickets, collecting tickets, refunds, prohibited items, or any other general question about the event:
Output a friendly, informative plain-text answer (under 120 words, no headers or bullet points). If you don't have a confident answer, say so honestly and offer to connect them with the team (use STEP 8's [T_VOICE_CALL] marker instead, if it's clearly what they want).

TICKET CONTEXT: If ticket_context is present, use those details proactively (e.g. "delivered to your seat, ${T.EVENT_NAME.split(' ').slice(-1)[0]} court, row..." style phrasing) — never re-ask for seat/gate/etc. you already know.

RULES:
- Output ONLY the marker (or the plain text / TICKET_FIELDS line combination for STEP 2) — nothing else, no preamble, no explanation
- Do NOT add text before or after a marker
- Do NOT wrap markers in quotes or backticks
- STEP 2 (has_new_image) takes priority over every other rule
- If in doubt, output [T_WELCOME]`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

async function decideTicketingMarker(fields) {
  const ticketContext = getTicketFields(fields.clientPhone);
  const userMessageText =
    `message_type: ${fields.messageType}\nmessage: ${fields.messageText}` +
    (Object.keys(ticketContext).length ? `\nticket_context: ${JSON.stringify(ticketContext)}` : '') +
    (fields.imageBase64 ? '\nhas_new_image: true' : '');

  const history = getConversation(fields.clientPhone, 'ticketing');

  const userContent = fields.imageBase64
    ? [
        { type: 'text', text: userMessageText },
        {
          type: fields.imageMediaType === 'application/pdf' ? 'document' : 'image',
          source: { type: 'base64', media_type: fields.imageMediaType || 'image/jpeg', data: fields.imageBase64 },
        },
      ]
    : userMessageText;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [...history, { role: 'user', content: userContent }],
  });

  const output = response.content?.[0]?.text ?? '[T_WELCOME]';
  // Store the text form in history — an image is large/opaque and not
  // useful for Claude to re-read on later turns; ticket_context (extracted
  // below) carries forward whatever mattered from it instead.
  pushTurn(fields.clientPhone, 'user', userMessageText, 'ticketing');
  pushTurn(fields.clientPhone, 'assistant', output, 'ticketing');
  return output;
}

// Pulls the "TICKET_FIELDS: {...}" line STEP 2 is instructed to append,
// returning both the visitor-facing text (with that line stripped) and the
// parsed fields object (or null if there wasn't one / it didn't parse).
function extractTicketFieldsLine(output) {
  const match = output.match(/TICKET_FIELDS:\s*(\{[\s\S]*\})\s*$/);
  if (!match) return { text: output, fields: null };
  const text = output.slice(0, match.index).trim();
  try {
    return { text, fields: JSON.parse(match[1]) };
  } catch (err) {
    console.error('Failed to parse TICKET_FIELDS JSON:', match[1], err.message);
    return { text, fields: null };
  }
}

module.exports = { decideTicketingMarker, extractTicketFieldsLine, SYSTEM_PROMPT };
