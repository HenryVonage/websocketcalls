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
  // The RBM Agent's technical Service ID — used both as the "from" sender
  // ID when sending RCS messages via the Messages API, and as the target
  // of the demo landing page's sms: deep link (see frontend demo.html).
  RCS_AGENT_ID: 'henry_rcs_demo3_byrrgzuw_agent@rbm.goog',
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
  // Separate from the sender_id above — the test-devices endpoint rejected
  // "henry_rcs_demo3" with "RCS Wizard Not Found", so trying this longer
  // form (matches the RBM address's local part, minus the @rbm.goog) next.
  RCS_AGENT_ID_CM: 'henry_rcs_demo3_byrrgzuw_agent',
  RCS_DEEPLINK_COUNTRY: 'GB',
};
