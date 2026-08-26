// Business config reused as-is from the n8n "WhatsApp Real Estate" flows.
// Update these values here if the business details ever change.
module.exports = {
  FROM_WHATSAPP: '447520691413',
  VIDEO_URL: 'https://storage.googleapis.com/henryvideorealestate/FlatViewing_whatsapp.mp4',
  FLOORPLAN_URL: 'https://storage.googleapis.com/henryvideorealestate/Floorplan.png',
  // Reused for henry_confirmationviewing's image header — same asset
  // already confirmed working as henry_realestatewelcome2's header image.
  // Swap for a proper Regent's Park property photo if you have one.
  PROPERTY_PHOTO_URL: 'https://i.ibb.co/Q9WnvQh/Screenshot-2023-06-22-at-15-13-22.png',
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
  },
};
