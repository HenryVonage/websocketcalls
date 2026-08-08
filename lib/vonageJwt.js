const crypto = require('crypto');
const fs = require('fs');

// Loads the Vonage Application private key from an env var (with literal
// "\n" sequences, as Render's env var editor stores multi-line values that
// way) or from a Secret File path if VONAGE_PRIVATE_KEY_PATH is set instead.
// Never hardcode the key in source — see the setup guide for how to store it
// in Render.
function getPrivateKey() {
  if (process.env.VONAGE_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.VONAGE_PRIVATE_KEY_PATH, 'utf8');
  }
  if (process.env.VONAGE_PRIVATE_KEY) {
    return process.env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  throw new Error(
    'No Vonage private key configured. Set VONAGE_PRIVATE_KEY (PEM content) ' +
    'or VONAGE_PRIVATE_KEY_PATH (path to a Render Secret File).'
  );
}

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// Generates a short-lived (15 min) RS256 JWT for authenticating calls to
// Vonage's REST APIs (Messages API, Voice API), signed with the
// Application's private key. Same pattern the n8n Code nodes used.
function generateVonageJwt() {
  const appId = process.env.VONAGE_APPLICATION_ID;
  if (!appId) throw new Error('VONAGE_APPLICATION_ID not set');
  const privateKey = getPrivateKey();

  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url({
    application_id: appId,
    iat: now,
    exp: now + 900,
    jti: crypto.randomUUID(),
  });

  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${signingInput}.${signature}`;
}

module.exports = { generateVonageJwt };
