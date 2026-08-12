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
};
