const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@fira.in';

// Lazy-initialised transporter — resolves to a real SMTP transport when
// credentials are present, otherwise falls back to an Ethereal test account.
let _transporterPromise = null;

function getTransporter() {
  if (_transporterPromise) return _transporterPromise;

  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    _transporterPromise = Promise.resolve(transporter);
    console.log(`  Mail: SMTP transport → ${SMTP_HOST}:${SMTP_PORT}`);
  } else {
    // Dev fallback — Ethereal test account
    _transporterPromise = nodemailer.createTestAccount().then(account => {
      const transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: account.user, pass: account.pass },
      });
      console.log(`  Mail: Ethereal test account → ${account.user}`);
      return transporter;
    });
  }

  return _transporterPromise;
}

/**
 * Send an email. Failures are logged but never thrown so they cannot crash
 * the calling route handler.
 */
async function sendMail(to, subject, html) {
  try {
    const transporter = await getTransporter();
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html,
    });

    // In dev (Ethereal) log the preview URL so developers can inspect the email
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`  Mail preview: ${previewUrl}`);
    }

    return info;
  } catch (err) {
    console.error('  Mail delivery failed:', err.message);
    return null;
  }
}

module.exports = { sendMail };
