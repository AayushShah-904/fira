const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { getDb } = require('../db/connection');
const { signToken, requireAuth } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
  firm: z.string().nullable().optional(),
  reg_no: z.string().nullable().optional(),
  ria_reg_no: z.string().nullable().optional(),  // alias — frontend sends this
  advisor_type: z.string().nullable().optional(),
});

// POST /api/v1/auth/login
router.post('/login', (req, res) => {
  const parse = LoginSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'Invalid request', details: parse.error.flatten() });
  const { email, password } = parse.data;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(user.id);
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, firm: user.firm,
            reg_no: user.ria_reg_no, role: user.role, plan: user.plan, advisor_type: user.advisor_type },
  });
});

// POST /api/v1/auth/register
router.post('/register', (req, res) => {
  const parse = RegisterSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'Invalid request', details: parse.error.flatten() });
  const { email, password, name, firm, reg_no, advisor_type } = parse.data;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const hash = bcrypt.hashSync(password, 12);
  const result = db.prepare(`
    INSERT INTO users(email,password_hash,name,firm,ria_reg_no,advisor_type,role,plan)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(email, hash, name, firm || null, reg_no || null, advisor_type || null, 'user', 'free');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, name: user.name, firm: user.firm,
            role: user.role, plan: user.plan, advisor_type: user.advisor_type },
  });
});

// POST /api/v1/auth/guest — continue as guest (no credentials needed)
router.post('/guest', (req, res) => {
  const crypto = require('crypto');
  const db = getDb();
  const guestId = crypto.randomUUID().slice(0, 8);
  const email = `guest-${guestId}@guest.fira.in`;
  const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

  const result = db.prepare(`
    INSERT INTO users(email,password_hash,name,role,plan)
    VALUES(?,?,?,?,?)
  `).run(email, hash, 'Guest', 'guest', 'guest');

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, name: user.name, firm: null,
            role: user.role, plan: user.plan, advisor_type: null },
  });
});

// POST /api/v1/auth/upgrade  — upgrade plan (in prod this hooks into payment gateway)
router.post('/upgrade', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!['pro','enterprise'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  const db = getDb();
  db.prepare('UPDATE users SET plan=? WHERE id=?').run(plan, req.user.id);

  // Notify the business team via email (fire-and-forget)
  try {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const notifyTo = process.env.UPGRADE_NOTIFY_EMAIL || 'business@bharatomni.com';
    const timestamp = new Date().toISOString();
    const html = `
      <h2>FIA Upgrade Request</h2>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
        <tr><td style="padding:6px 12px;font-weight:bold;">Name</td><td style="padding:6px 12px;">${user.name}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Email</td><td style="padding:6px 12px;">${user.email}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Firm</td><td style="padding:6px 12px;">${user.firm || '—'}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Advisor type</td><td style="padding:6px 12px;">${user.advisor_type || '—'}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Reg. number</td><td style="padding:6px 12px;">${user.ria_reg_no || '—'}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Requested plan</td><td style="padding:6px 12px;">${plan}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Timestamp</td><td style="padding:6px 12px;">${timestamp}</td></tr>
      </table>
      <p style="margin-top:16px;color:#555;">This user has requested an upgrade via FIA. Please follow up within 24 hours.</p>
    `;
    sendMail(notifyTo, `FIA Upgrade Request - ${user.name}`, html);
  } catch (mailErr) {
    console.error('Upgrade notification email failed:', mailErr.message);
  }

  res.json({ success: true, plan });
});

// POST /api/v1/auth/request-guide — send investor guide request notification
router.post('/request-guide', requireAuth, async (req, res) => {
  const { type } = req.body;
  const guideNames = { nri: 'NRI Fixed Income Guide', domestic: 'Domestic Investor Guide' };
  const guideName = guideNames[type] || type || 'Investor Guide';

  try {
    const notifyTo = process.env.UPGRADE_NOTIFY_EMAIL || 'business@bharatomni.com';
    const html = `
      <h2>FIA — Investor Guide Request</h2>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
        <tr><td style="padding:6px 12px;font-weight:bold;">Guide</td><td style="padding:6px 12px;">${guideName}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Name</td><td style="padding:6px 12px;">${req.user.name}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Email</td><td style="padding:6px 12px;">${req.user.email}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Firm</td><td style="padding:6px 12px;">${req.user.firm || '—'}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:bold;">Timestamp</td><td style="padding:6px 12px;">${new Date().toISOString()}</td></tr>
      </table>
      <p style="margin-top:16px;color:#555;">Please send the ${guideName} to ${req.user.email} within 24 hours.</p>
    `;
    sendMail(notifyTo, `FIA Guide Request — ${guideName} — ${req.user.name}`, html);
  } catch (_) {}

  res.json({ success: true });
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id, email: req.user.email, name: req.user.name,
    firm: req.user.firm, reg_no: req.user.ria_reg_no,
    role: req.user.role, plan: req.user.plan, advisor_type: req.user.advisor_type,
  });
});

// POST /api/v1/auth/profile
router.post('/profile', requireAuth, (req, res) => {
  const { sebi_category, city, aum_bracket, client_types, fd_uses, source, advisor_type } = req.body;
  const db = getDb();
  // Update advisor_type on user record too
  if (advisor_type) {
    db.prepare('UPDATE users SET advisor_type=? WHERE id=?').run(advisor_type, req.user.id);
  }
  db.prepare(`
    INSERT INTO ria_profiles(user_id,sebi_category,city,aum_bracket,client_types,fd_uses,source,onboarding_done)
    VALUES(?,?,?,?,?,?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET
      sebi_category=excluded.sebi_category, city=excluded.city,
      aum_bracket=excluded.aum_bracket, client_types=excluded.client_types,
      fd_uses=excluded.fd_uses, source=excluded.source,
      onboarding_done=1, updated_at=datetime('now')
  `).run(
    req.user.id,
    sebi_category || null, city || null, aum_bracket || null,
    client_types ? JSON.stringify(client_types) : null,
    fd_uses      ? JSON.stringify(fd_uses)      : null,
    source || null
  );
  res.json({ success: true });
});

// ─── EMAIL OTP VERIFICATION ─────────────────────────────────────

// POST /api/v1/auth/send-otp
router.post('/send-otp', requireAuth, async (req, res) => {
  try {
    const crypto = require('crypto');
    const otp = String(crypto.randomInt(100000, 999999));
    const otpHash = bcrypt.hashSync(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const db = getDb();
    db.prepare(`
      INSERT INTO email_verifications(user_id, email, otp_hash, expires_at)
      VALUES(?,?,?,?)
    `).run(req.user.id, req.user.email, otpHash, expiresAt);

    await sendMail(
      req.user.email,
      'Your FIA verification code',
      `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;">
        <h2 style="color:#111827;">Verify your email</h2>
        <p style="color:#6b7280;">Your verification code is:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;padding:16px;background:#f8f9fb;border-radius:12px;color:#1a47f5;">
          ${otp}
        </div>
        <p style="color:#9ca3b4;font-size:13px;margin-top:16px;">This code expires in 10 minutes.</p>
      </div>`
    );

    const response = { success: true, email: req.user.email };
    // In development, include OTP in response for testing without real email
    if (process.env.NODE_ENV !== 'production') {
      response.otp = otp;
    }
    res.json(response);
  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// POST /api/v1/auth/verify-otp
router.post('/verify-otp', requireAuth, (req, res) => {
  const { otp } = req.body;
  if (!otp || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'Please enter a valid 6-digit code' });
  }

  const db = getDb();
  const record = db.prepare(`
    SELECT * FROM email_verifications
    WHERE user_id=? AND verified_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(req.user.id);

  if (!record) {
    return res.status(400).json({ error: 'No pending verification. Please request a new code.' });
  }

  if (!bcrypt.compareSync(otp, record.otp_hash)) {
    return res.status(400).json({ error: 'Invalid code. Please try again.' });
  }

  db.prepare("UPDATE email_verifications SET verified_at=datetime('now') WHERE id=?").run(record.id);
  db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(req.user.id);

  res.json({ success: true, email_verified: true });
});

module.exports = router;
