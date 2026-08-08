const Anthropic = require('@anthropic-ai/sdk');
const config = require('./businessConfig');
const { sendVonageMessage, createVonageCall } = require('./vonageApi');
const { getConversation, pushTurn, setCallContext } = require('./store');
const { buildAnswerNcco } = require('./nccoBuilder');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Verbatim system prompt from Flow 3's "WA Estate AI Agent" node.
const SYSTEM_PROMPT = `You are the AI orchestrator for Vonage Estate's WhatsApp Business chatbot. Your sole job is to output the correct marker or plain text for each step of the conversation. A follow-up step converts your output into the right Vonage Messages API payload.

Each user message arrives with these fields:
- message_type: the Vonage message type (text, button, reply, location)
- message: the content (button label, list reply title, free text)
- product_selected: (optional) product retailer ID if the user interacted with the product catalog (e.g. L1234, L5678)

CONVERSATION FLOW:

STEP 1 — message is 'Hi', 'Hello', or any unrecognised first message with no product_selected:
Output exactly: [WELCOME]

STEP 2A — message_type=button AND message='Flats available near by':
Output exactly: [FLAT_TYPE_LIST]

STEP 2B — message_type=button AND message='Viewing':
Output exactly: [FLAT_TYPE_LIST]

STEP 2C — contact intent (call, speak to someone, contact us):
Output exactly: [VOICE_CALL]

STEP 3 — message_type=reply AND the previous bot message offered flat types or budgets (Studio / 1 bedroom / 2 bedroom sections):
Output exactly: [ASK_LOCATION]

STEP 4 — message_type=location (user shared GPS coordinates):
Output exactly: [PRODUCT_LIST]

STEP 5 — product_selected field is present (e.g. product_selected: L1234 or L5678), regardless of what the user typed:
Output exactly: [VIEWING_INTEREST]

STEP 6 — message_type=button AND message='BOOK A VIEWING':
Extract user first name from conversation history (default: Client).
Output exactly: [VIDEO_TOUR: <first_name>]

STEP 7 — message_type=button AND message='YES':
Output exactly: Great! We look forward to welcoming you at the Vonage office. See you soon!

STEP 8 — message_type=button AND (message='NO' OR message='NOT INTERESTED'):
Output exactly: No problem! Please call us at ${config.SUPPORT_PHONE} or email ${config.SUPPORT_EMAIL} to find a better time.

STEP 9 — message_type=button AND message='QUESTIONS ABOUT THE FLAT':
Output a friendly, informative plain-text answer about the property. Include key details such as: available flat sizes and layouts, rent range, location highlights, nearby transport links, available move-in dates, and a prompt to book a viewing or ask more questions. Keep it concise (under 200 words) and warm in tone.

RULES:
- Output ONLY the marker or the plain text sentence — nothing else, no preamble, no explanation
- Do NOT add text before or after a marker
- Do NOT wrap markers in quotes or backticks
- STEP 5 (product_selected present) takes priority over all other rules
- If in doubt, output [WELCOME]`;

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
    userName: body.profile?.name ?? 'Client',
  };
}

async function decideMarker(fields) {
  const userMessage =
    `message_type: ${fields.messageType}\nmessage: ${fields.messageText}` +
    (fields.productId ? `\nproduct_selected: ${fields.productId}` : '');

  const history = getConversation(fields.clientPhone);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [...history, { role: 'user', content: userMessage }],
  });

  const output = response.content?.[0]?.text ?? '[WELCOME]';
  pushTurn(fields.clientPhone, 'user', userMessage);
  pushTurn(fields.clientPhone, 'assistant', output);
  return output;
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
          name: 'henry_confirmationviewing',
          language: { policy: 'deterministic', code: 'en' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: propertyName }] },
            { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'BOOK A VIEWING' }] },
            { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: 'NOT INTERESTED' }] },
            { type: 'button', sub_type: 'quick_reply', index: 2, parameters: [{ type: 'payload', payload: 'QUESTIONS ABOUT THE FLAT' }] },
          ],
        } },
      },
    ];
  }

  if (output.includes('[VIDEO_TOUR')) {
    const m = output.match(/\[VIDEO_TOUR(?::\s*([^\]]+))?\]/);
    const name = (m && m[1]) ? m[1].trim() : userName;
    const appointmentTime = '14:30 tomorrow';
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
}

async function handleWhatsAppInbound(req, res) {
  res.status(200).json({ status: 'received' }); // ack immediately, like the n8n webhook did

  try {
    const fields = extractFields(req.body || {});
    const output = await decideMarker(fields);
    const payloads = buildPayloads(output, fields);

    for (const payload of payloads) {
      await sendVonageMessage(payload);
    }

    await maybeTriggerFeedbackCall(fields);
  } catch (err) {
    console.error('handleWhatsAppInbound error:', err);
  }
}

module.exports = { handleWhatsAppInbound };
