const crypto = require('crypto');
const fs = require('fs');

// Cached after the first read — the key never changes without a redeploy
// (which re-execs the process anyway), so re-reading/re-parsing it on every
// single API call (a blocking fs.readFileSync when VONAGE_PRIVATE_KEY_PATH
// is used) was pure per-request overhead for no benefit.
let cachedPrivateKey = null;

// Loads the Vonage Application private key from an env var (with literal
// "\n" sequences, as Render's env var editor stores multi-line values that
// way) or from a Secret File path if VONAGE_PRIVATE_KEY_PATH is set instead.
// Never hardcode the key in source — see the setup guide for how to store it
// in Render.
function getPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (process.env.VONAGE_PRIVATE_KEY_PATH) {
    cachedPrivateKey = fs.readFileSync(process.env.VONAGE_PRIVATE_KEY_PATH, 'utf8');
    return cachedPrivateKey;
  }
  if (process.env.VONAGE_PRIVATE_KEY) {
    cachedPrivateKey = process.env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n');
    return cachedPrivateKey;
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

// Reused until shortly before it expires — a fresh RSA-SHA256 signature
// (plus, previously, a re-read of the key file) was being generated on
// every single Messages/Calls API call even though a token is valid for 15
// minutes, so a multi-message marker (e.g. [VIEWING_INTEREST], three sends)
// was signing three tokens for no reason. Vonage doesn't require a fresh
// jti per request. Refreshed 60s before the real expiry so an in-flight
// request never gets handed a token that expires mid-call.
let cachedJwt = null; // { value, expiresAt }
const REFRESH_MARGIN_MS = 60 * 1000;

// Generates a short-lived (15 min) RS256 JWT for authenticating calls to
// Vonage's REST APIs (Messages API, Voice API), signed with the
// Application's private key. Same pattern the n8n Code nodes used.
function generateVonageJwt() {
  if (cachedJwt && cachedJwt.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return cachedJwt.value;
  }

  const appId = process.env.VONAGE_APPLICATION_ID;
  if (!appId) throw new Error('VONAGE_APPLICATION_ID not set');
  const privateKey = getPrivateKey();

  const header = base64url({ alg: 'RS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const expSeconds = now + 900;
  const payload = base64url({
    application_id: appId,
    iat: now,
    exp: expSeconds,
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

  const jwt = `${signingInput}.${signature}`;
  cachedJwt = { value: jwt, expiresAt: expSeconds * 1000 };
  return jwt;
}

module.exports = { generateVonageJwt };
