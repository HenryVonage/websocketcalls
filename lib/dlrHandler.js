const { logEvent, redactPhone } = require('./activityLog');

// Ported from the "Vonage DLR Status Handler" n8n workflow: normalizes a
// delivery-receipt callback and logs it. Respond immediately (Vonage
// doesn't need anything back beyond a 200).
function handleDlr(req, res) {
  const body = req.body || {};
  const normalised = {
    messageUuid: body.message_uuid ?? '',
    deliveryStatus: body.status ?? 'unknown',
    channel: body.channel ?? '',
    toNumber: body.to ?? '',
    fromNumber: body.from ?? '',
    timestamp: body.timestamp ?? '',
    errorCode: body.error?.title ?? '',
    errorReason: body.error?.detail ?? '',
    providerMessage: body.provider_message ?? '',
  };

  console.log('Vonage DLR:', JSON.stringify(normalised));
  logEvent(
    'dlr',
    `Delivery ${normalised.deliveryStatus} to ${redactPhone(normalised.toNumber)}` +
      (normalised.errorReason ? ` — ${normalised.errorReason}` : '')
  );
  res.status(200).json({ status: 'ok' });
}

module.exports = { handleDlr };
