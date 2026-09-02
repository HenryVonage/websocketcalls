// Sends the "raise a comment/question" feedback form's submissions to
// Henry's own inbox, with any attached photos/video included as real email
// attachments. Uses Gmail SMTP with an App Password (never Henry's real
// account password) — GMAIL_USER and GMAIL_APP_PASSWORD are Render
// environment variables, set directly in the Render dashboard, never
// committed here (same pattern as every other secret in this project).
//
// The transporter is built lazily inside sendFeedbackEmail() rather than
// once at module load: this file is required by server.js at boot, before
// Render has necessarily injected env vars in every deploy path, and
// building it lazily also makes this trivial to unit-test by monkeypatching
// nodemailer.createTransport in an isolated require() — the established
// testing convention in this repo (see ticketingWhatsappFlow.js's test
// scripts, mocking sendVonageMessage the same way).
const nodemailer = require('nodemailer');

const NOTIFY_TO = 'henryauthier@gmail.com';

// Deliberately simple/permissive — this only gates what the visitor typed
// well enough to catch obvious typos before we try to email a reply to it;
// it's not trying to be RFC 5322-complete. Requires at least one "@" with
// a non-empty local part, a domain with at least one dot, and no
// whitespace anywhere.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

function buildTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    // Surfaced as a 500 to the visitor (see server.js) and logged clearly
    // here so this reads as "env var not set yet" in Render logs, not a
    // mysterious auth failure — this is expected to happen until Henry
    // finishes the one-time Google App Password + Render env var setup.
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set — feedback email not sent.');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

// `files` — multer's in-memory file objects ({ originalname, mimetype,
// buffer, size }) from upload.array(), attached directly rather than
// written to disk first (kept small on purpose — see server.js's 15MB
// total cap, comfortably within Gmail's own attachment limits).
async function sendFeedbackEmail({ name, email, message, demoLabel, files = [] }) {
  if (!isValidEmail(email)) {
    throw new Error('Invalid email address');
  }
  const transporter = buildTransport();

  const safeName = (name || '').trim();
  const safeMessage = (message || '').trim();

  const subject = `Demo feedback${demoLabel ? ` — ${demoLabel}` : ''}${safeName ? ` from ${safeName}` : ''}`;
  const textLines = [
    safeName ? `Name: ${safeName}` : null,
    `Email: ${email}`,
    demoLabel ? `Demo: ${demoLabel}` : null,
    '',
    safeMessage || '(no message text — attachment(s) only)',
    files.length ? `\n${files.length} attachment(s): ${files.map((f) => f.originalname).join(', ')}` : null,
  ].filter(Boolean);

  await transporter.sendMail({
    from: `"Vonage AI Demos" <${process.env.GMAIL_USER}>`,
    to: NOTIFY_TO,
    // So hitting "Reply" in the inbox goes straight to the visitor, not
    // back to Henry's own address.
    replyTo: email,
    subject,
    text: textLines.join('\n'),
    attachments: files.map((f) => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype,
    })),
  });
}

module.exports = { sendFeedbackEmail, isValidEmail };
