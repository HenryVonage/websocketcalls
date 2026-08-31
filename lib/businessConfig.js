// Business config reused as-is from the n8n "WhatsApp Real Estate" flows.
// Update these values here if the business details ever change.

// Declared before module.exports (rather than inline) so the Ticketing
// WhatsApp demo's config further down can reference the same number
// without a self-referential `module.exports.FROM_WHATSAPP` lookup.
const REAL_ESTATE_WHATSAPP_NUMBER = '447520691413';

module.exports = {
  FROM_WHATSAPP: REAL_ESTATE_WHATSAPP_NUMBER,
  VIDEO_URL: 'https://storage.googleapis.com/henryvideorealestate/FlatViewing_whatsapp.mp4',
  FLOORPLAN_URL: 'https://storage.googleapis.com/henryvideorealestate/Floorplan.png',
  // Real Regent's Park property photo — also reused for
  // henry_confirmationviewing's WhatsApp image header.
  PROPERTY_PHOTO_URL: 'https://storage.googleapis.com/henryvideorealestate/1000053556.jpg',
  // Real Angel Loft property photo (RCS product-list card — see rcsFlow.js).
  ANGEL_PHOTO_URL: 'https://storage.googleapis.com/henryvideorealestate/1000053558.jpg',
  CATALOG_ID: '2806150799683508',
  TEMPLATE_NAMESPACE: '9b6b4fcb_da19_4a26_8fe8_78074a91b584',
  PROPERTY_MAP: { L1234: "Regent's Park", L5678: 'Angel Loft' },
  VONAGE_OFFICE: {
    longitude: -0.085228,
    latitude: 51.523287,
    name: 'Vonage office',
    address: '15 Bonhill st, London',
  },
  SUPPORT_PHONE: '+44 20 7946 0958',
  SUPPORT_EMAIL: 'hello@vonageestate.co.uk',

  // --- 2nd demo: RCS (same business, same Vonage Application, different
  // channel) ---
  // The Messages API "from" sender for RCS sends (rcsFlow.js,
  // voiceHandlers.js). Was previously set to the RBM technical address
  // ("...@rbm.goog") on the assumption it worked like the WhatsApp/RCS
  // deep-link addressing — but a live send confirmed the Messages API
  // rejects that with a 422 "Invalid sender". It wants the plain sender_id
  // instead (same value as RCS_AGENT_SENDER_ID below). The "...@rbm.goog"
  // form is ONLY correct for the frontend's client-built sms: deep link
  // (demo.html's own hardcoded rcsServiceId field) — a separate, Google-side
  // addressing scheme unrelated to the Messages API.
  RCS_AGENT_ID: 'henry_rcs_demo3',
  // PSTN number linked to the same Vonage Application — inbound calls here
  // go through the same /answer + /events + ElevenLabs bridge as the
  // WhatsApp-calling demo, but the post-call recap/appointment gets sent
  // over RCS instead of WhatsApp (see voiceHandlers.js).
  RCS_PSTN_NUMBER: '447441443052',
  // Used to call Vonage's Channel Manager "generate RCS deeplink" endpoint
  // (see vonageApi.js's generateRcsDeeplink + server.js's /api/rcs-deeplink)
  // — the officially-supported way to get a deep link Android's native
  // Camera app recognizes as this RBM agent, rather than the hand-built
  // sms: URI in demo.html (which only some third-party scanners honor).
  // NOT the same as the RBM technical address above — the deeplink
  // endpoint rejected that with "Sender ID must have AlphaNumeric format".
  // Trying the plain agent name instead; update if Vonage's dashboard
  // shows a different Sender ID for this agent.
  RCS_AGENT_SENDER_ID: 'henry_rcs_demo3',
  // Separate from the sender_id above — the test-devices endpoint wants the
  // real internal agent id, not the human-readable sender_id. Confirmed via
  // GET /v1/channel-manager/rcs/agents (see /api/rcs-agents): this is
  // "Henry RCS Demo3" (sender_id "henry_rcs_demo3", application_id
  // 5650d142-3440-4bc1-8377-a12cc20e2605 — matches this app's).
  RCS_AGENT_ID_CM: '019ff6b2-b467-7e09-9d1d-91ce72de26d2',
  RCS_DEEPLINK_COUNTRY: 'GB',

  // --- 3rd demo: Ticketing (RCS-only) ---
  // Rebuilt from the "RCS _ MonteCarlo ticketing" Node-RED flow (tab
  // 447312277021 / sender "VonageRCSDemo-Henry") — same event, same media,
  // same conversation steps, but driven by Claude (see
  // lib/ticketingEngine.js) instead of hardcoded switch/change nodes.
  //
  // Deliberately reuses the SAME Vonage Application, the SAME RCS agent
  // (RCS_AGENT_ID/RCS_AGENT_SENDER_ID/RCS_AGENT_ID_CM above) and the SAME
  // linked PSTN number (RCS_PSTN_NUMBER above) as the Real Estate RCS demo —
  // per instruction, no second RCS agent or second virtual number. A single
  // inbound webhook (server.js's /vonage-estate-whatsapp) receives every RCS
  // message regardless of which demo it's for; lib/demoRouter.js decides
  // which conversation a given phone number is in, keyed off the QR code's
  // pre-filled greeting text (see frontend/demo.html's DEMOS[] entry for
  // this demo) and remembered per-phone for the rest of that conversation
  // (including a later PSTN call from the same number).
  TICKETING: {
    EVENT_NAME: 'Rolex Monte-Carlo Masters',
    // Image/media URLs carried over as-is from the original flow's Google
    // Cloud Storage bucket / ibb.co hosting — confirmed still reachable at
    // the time this demo was rebuilt. Swap any of these if they ever 404.
    WELCOME_IMAGE_URL: 'https://i.ibb.co/HPs5JKN/Screenshot-2024-09-10-at-10-22-22.png',
    MAP_IMAGE_URL: 'https://storage.googleapis.com/henryticketing/MonteCarlo_map%20.png',
    DAY_PROGRAM_IMAGE_URL: 'https://storage.googleapis.com/henryticketing/Screenshot%202024-09-18%20at%2011.54.25.png',
    DELIVERY_METHOD_IMAGE_URL: 'https://storage.googleapis.com/henryticketing/Screenshot%202024-09-26%20at%2015.41.27.png',
    COLLECT_AT_STAND_IMAGE_URL: 'https://i.ibb.co/Q9WnvQh/Screenshot-2023-06-22-at-15-13-22.png',
    SAMPLE_ETICKET_IMAGE_URL: 'https://storage.googleapis.com/henryticketing/Monte%20Carlo%202016%20-ETicket.png',
    WINNER_IMAGE_URL: 'https://storage.googleapis.com/henryticketing/Screenshot%202024-09-18%20at%2011.19.30.png',
    APP_URL: 'https://play.google.com/store/apps/details?id=federall.monte_carlo_rolex_masters',
    TICKETING_SITE_URL: 'https://store.montecarlotennismasters.com/en',
    SHUTTLE_INFO_URL: 'https://montecarlotennismasters.com/en/practical-information/shuttle-buses/',
    INFO_URL: 'https://montecarlotennismasters.com/en/tournament/tournament-info/',
    INSTAGRAM_HASHTAG: '#rolexmontecarlomasters2025',
    // In-seat food/merch menu — id must match what buildPayloads /
    // ticketingEngine.js's system prompt use as postback_data / order items.
    PRODUCTS: [
      { id: 'mint_ice_cream', name: 'Mint ice cream', price: '£5', imageUrl: 'https://storage.googleapis.com/henryticketing/Screenshot%202024-09-23%20at%2012.48.54.png' },
      { id: 'lemon_ice_cream', name: 'Lemon ice cream', price: '£5', imageUrl: 'https://storage.googleapis.com/henryticketing/Screenshot%202024-09-23%20at%2012.49.58.png' },
      { id: 'cap', name: 'Rolex MCM cap', price: '£20', imageUrl: 'https://storage.googleapis.com/henryticketing/Screenshot%202024-09-23%20at%2012.59.57.png' },
      { id: 'umbrella', name: 'Tournament umbrella', price: '£30', imageUrl: 'https://storage.googleapis.com/henryticketing/Screenshot%202024-09-23%20at%2013.00.21.png' },
    ],
    // ElevenLabs agent for the "Contact us" voice escalation (Contact us
    // suggestion -> dial -> PSTN -> same Vonage Application -> this agent),
    // separate from the Real Estate voice persona so the caller hears a
    // ticketing-appropriate greeting/knowledge base. Falls back to the
    // shared ELEVENLABS_AGENT_ID (see realtimeBridge.js) if this isn't set
    // yet — create the agent in ElevenLabs and set
    // ELEVENLABS_TICKETING_AGENT_ID in Render once ready.
    ELEVENLABS_AGENT_ID_ENV: 'ELEVENLABS_TICKETING_AGENT_ID',

    // --- 4th demo: Ticketing (WhatsApp) — same event, same Claude-driven
    // journey (lib/ticketingEngine.js, unchanged) and same product catalog
    // as the RCS version above, but over WhatsApp — rebuilt from the
    // "WhatsApp _ MonteCarlo ticketing" Node-RED flow (flows_25.json).
    //
    // Unlike the two RCS demos (which share one RCS agent and are told
    // apart by greeting text, see demoRouter.js), this demo gets its OWN
    // dedicated WABA number — confirmed from the Node-RED flow, every
    // outbound message there uses "from": "447312277021", distinct from
    // Henry's Real Estate WhatsApp number (FROM_WHATSAPP above). That
    // means inbound routing between the two WhatsApp demos can key off
    // which number the visitor messaged (body.to on the inbound webhook)
    // instead of sniffing greeting text — see lib/whatsappFlow.js.
    WHATSAPP: {
      // Henry asked to run this demo on the SAME WABA number as the Real
      // Estate WhatsApp demo (FROM_WHATSAPP above) rather than provision
      // 447312277021 as a genuinely separate linked number on this Vonage
      // Application — the flow's own JSON used that number, but it was
      // never actually linked here, which is why the first live test saw
      // zero inbound webhooks at all (confirmed via Render logs: nothing
      // reached the server, not a template-send failure). Sharing the
      // number means routing between the two WhatsApp demos now works
      // exactly like the two RCS demos already do — by greeting text (see
      // demoRouter.js's detectDemoFromText, reused as-is for WhatsApp in
      // server.js) rather than by which number was messaged.
      //
      // If 447312277021 ever does get linked to this Application later,
      // switch this back to that value — server.js's dispatch already
      // checks for a genuinely distinct dedicated number first (see its
      // comment) and only falls back to content-based routing when this
      // equals FROM_WHATSAPP, so no other code needs to change.
      //
      // One real risk worth testing for: WhatsApp template approval is
      // per WhatsApp Business Account, not per phone number within it.
      // henry_ticketing1/2/3 and henry_form3 were approved for whichever
      // WABA 447312277021 belongs to — if that's a DIFFERENT WhatsApp
      // Business Account than FROM_WHATSAPP belongs to, sends from this
      // shared number will fail with a template-not-found-style error
      // even though routing itself works. Watch Render logs on first
      // live test for exactly that.
      FROM_WHATSAPP: REAL_ESTATE_WHATSAPP_NUMBER,
      // Same Commerce Catalog as Real Estate's product_list (CATALOG_ID
      // above) — confirmed via flows_25.json's "Multiple products" node,
      // same catalog_id. product_retailer_id order there was: Ice creams
      // section = [mint, lemon], Accessories section = [cap, umbrella],
      // matching T.PRODUCTS' order exactly — mapped positionally below.
      PRODUCT_RETAILER_IDS: {
        mint_ice_cream: 'som7dv3uu0',
        lemon_ice_cream: '0jq9l5hx42',
        cap: 'vgg6v8hb14',
        umbrella: 'f25ozv0mww',
      },
      // Real e-ticket PDF (WhatsApp supports a genuine PDF attachment,
      // unlike RCS's rich-card media which is India-only — see
      // SAMPLE_ETICKET_IMAGE_URL's comment above). From flows_25.json's
      // "send ticket" node.
      ETICKET_PDF_URL: 'https://storage.googleapis.com/henryticketing/Monte%20Carlo%202016%20-ETicket.pdf',
      // Approved WhatsApp Business templates for this demo (namespace:
      // TEMPLATE_NAMESPACE above, same as every other henry_* template).
      // Exact header/body shapes confirmed from flows_25.json's inject-node
      // demo payloads (all four capture Henry's own live WhatsApp Manager
      // config, not guessed):
      //   henry_ticketing1 — image header + 5 body vars (name, event name,
      //     full event description incl. dates, two more date/time
      //     strings) — used as the very first "priority access" outbound,
      //     mirroring the RCS demo's deterministic buildPriorityCard().
      //   henry_ticketing2 — image header + 4 body vars (name, an order
      //     number, event name x2) — used for order confirmation.
      //   henry_ticketing3bis — DOCUMENT header (the venue map PDF) + 1 body
      //     var (name) + a static "Shuttle service" website-URL button —
      //     used for the "one week to go" reminder, WhatsApp's PDF-map
      //     counterpart to the RCS map image. Replaces the original
      //     henry_ticketing3, which was approved on a different WABA than
      //     447520691413's and so was unusable for this number (see
      //     /admin/whatsapp-templates diagnostic route in server.js) —
      //     henry_ticketing3bis was rebuilt from scratch and approved
      //     directly on this WABA, with a slightly different shape
      //     (1 body var instead of 2; the button is static, no params).
      //   henry_form3 — image header + 2 body vars (name, event name) +
      //     a "Complete flow" button opening a WhatsApp Flow survey.
      //     Confirmed via Henry's own WhatsApp Manager screenshot: body
      //     text is "Hi {{1}}, thank you for your venue at {{2}}. We would
      //     love you to fill out that survey... you can also participate
      //     in our exclusive games such as MEET YOUR IDOL to win
      //     outstanding prizes...". This is the prize-entry mechanism for
      //     this demo (per instruction) — NOT the RCS demo's
      //     Instagram-photo-tag contest, even though flows_25.json also
      //     contains that alternate path (the "Post on IG"/"Your won!"
      //     nodes). The survey's own screens live in Meta's Flow Builder
      //     and aren't visible here; this demo just sends the template and
      //     reacts to its nfm_reply completion webhook (see
      //     lib/ticketingWhatsappFlow.js) the same way henry_form2 already
      //     works for the Real Estate demo (lib/whatsappFlow.js).
      TEMPLATE_PRIORITY: 'henry_ticketing1',
      TEMPLATE_ORDER_CONFIRM: 'henry_ticketing2',
      TEMPLATE_ONE_WEEK_MAP: 'henry_ticketing3bis',
      TEMPLATE_SURVEY: 'henry_form3',
      // Shared header image used by henry_ticketing1/henry_form3 per
      // Henry's WhatsApp Manager config (same asset as WELCOME_IMAGE_URL
      // above, re-hosted at ibb.co for the template's approved media).
      TEMPLATE_HEADER_IMAGE_URL: 'https://i.ibb.co/HPs5JKN/Screenshot-2024-09-10-at-10-22-22.png',
      MAP_PDF_URL: 'https://storage.googleapis.com/henryticketing/MonteCarlo_map.pdf',
    },
  },
};
