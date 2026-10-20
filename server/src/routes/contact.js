/**
 * @file contact.js
 * @description "Contact Us" messages, saved to Neon.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { optionalAuth } from '../auth.js';

const router = Router();

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
  } catch (err) {
    next(err);
  }
});

export default router;
