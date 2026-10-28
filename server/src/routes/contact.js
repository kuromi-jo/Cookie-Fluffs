/**
 * @file contact.js
 * @description "Contact Us" messages: saved to Neon, shown live in the admin notifications, and
 * forwarded by email to CONTACT_INBOX_EMAIL (with Reply-To set to the customer) when configured.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { optionalAuth } from '../auth.js';

const router = Router();

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Emails the message to the shop inbox through Brevo. Never throws: the message is already saved. */
async function forwardToInbox({ name, email, subject, message }, env = process.env) {
  const inbox = env.CONTACT_INBOX_EMAIL?.trim();
  const apiKey = env.BREVO_API_KEY?.trim();
  const sender = env.BREVO_SENDER_EMAIL?.trim();
  if (!inbox || !apiKey || !sender) return;
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { email: sender, name: env.BREVO_SENDER_NAME?.trim() || 'Cookie Fluffs' },
        to: [{ email: inbox }],
        replyTo: { email, name },
        subject: `Contact Us: ${subject}`.slice(0, 150),
        headers: { 'X-Mailin-track-opens': '0', 'X-Mailin-track-clicks': '0' },
        textContent: `From: ${name} <${email}>\nTopic: ${subject}\n\n${message}`,
        htmlContent: `<p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;<br><strong>Topic:</strong> ${escapeHtml(subject)}</p><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
      }),
    });
    if (!response.ok) console.error('[contact] email forward was rejected by the provider.');
  } catch {
    console.error('[contact] email forward failed.');
  }
}

// POST /api/contact  { name, email, subject, message }
router.post('/', optionalAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const subject = String(req.body.subject || 'General').trim();
    const message = String(req.body.message || '').trim();

    if (name.length < 2) return res.status(400).json({ message: 'Please enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Please enter a valid email.' });
    if (message.length < 5) return res.status(400).json({ message: 'Your message is a little too short.' });
    if (message.length > 2000) return res.status(400).json({ message: 'Please keep your message under 2000 characters.' });

    const { rows } = await query(
      `INSERT INTO contact_messages (user_id, name, email, subject, message)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at AS "createdAt"`,
      [req.userId ?? null, name, email, subject, message],
    );
    res.status(201).json({ id: rows[0].id, createdAt: rows[0].createdAt });
    setImmediate(() => void forwardToInbox({ name, email, subject, message }));
  } catch (err) {
    next(err);
  }
});

export default router;
