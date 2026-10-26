/**
 * @file verification.js
 * @description Authenticated, owner-scoped identity-verification endpoints (Phase 2 foundation).
 * Challenges are started and verified here; raw codes are NEVER returned in responses. Real code
 * delivery is gated by the verification config's deliveryEnabled flag; when disabled the start
 * endpoint reports that delivery is unavailable rather than silently pretending to send.
 */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { pool, query } from '../db.js';
import { validateEmail } from '../validation.js';
import { verificationConfig } from '../runtime-config.js';
import { createVerificationService } from '../verification-service.js';
import { createGoogleReauthService } from '../google-reauth-service.js';
import {
  createBrevoVerificationAdapter,
  createInMemoryVerificationAdapter,
  VerificationDeliveryError,
} from '../verification-email.js';

const START_FIELDS = new Set(['operation', 'target']);
const VERIFY_FIELDS = new Set(['challengeId', 'operation', 'code', 'target']);
const REAUTH_FIELDS = new Set(['selector', 'nonce', 'idToken']);
const EMAIL_OPERATIONS = new Set(['change_phone', 'change_email', 'set_password', 'change_password']);

function hasExactFields(body, allowed) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).every((field) => allowed.has(field));
}

/** Masks an email like m•••@example.com for safe display. */
function maskEmail(email) {
  const [local, domain] = String(email ?? '').split('@');
  if (!domain) return null;
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

export function createVerificationRouter({
  dbQuery = query,
  databasePool = pool,
  authenticate = requireAuth,
  config = verificationConfig(),
  verification = createVerificationService({ databasePool, config }),
  googleReauth = createGoogleReauthService({ databasePool }),
  // Delivery adapter: real Brevo only when enabled; otherwise an in-memory sink (never emails).
  emailAdapter = config.deliveryEnabled ? createBrevoVerificationAdapter(config) : createInMemoryVerificationAdapter(),
} = {}) {
  const router = Router();
  router.use(authenticate);

  // POST /api/verification/start { operation, target? }
  router.post('/start', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      if (!hasExactFields(body, START_FIELDS) || !EMAIL_OPERATIONS.has(body.operation)) {
        return res.status(400).json({ message: 'Choose a valid operation to verify.' });
      }
      if (!verification.available()) {
        return res.status(503).json({ message: 'Verification is not available right now.' });
      }

      const userResult = await dbQuery(
        'SELECT email, first_name FROM users WHERE id = $1',
        [req.userId],
      );
      if (!userResult.rows.length) return res.status(401).json({ message: 'Please log in again.' });
      const { email: currentEmail, first_name: firstName } = userResult.rows[0];

      // Choose the delivery destination. For change_email the code must go to the NEW email to
      // prove the customer controls it; every other operation verifies via the current email.
      let email = currentEmail;
      if (body.operation === 'change_email') {
        const newEmail = String(body.target ?? '').trim().toLowerCase();
        if (validateEmail(newEmail)) {
          return res.status(400).json({ message: 'Enter a valid new email address.' });
        }
        if (newEmail === String(currentEmail).trim().toLowerCase()) {
          return res.status(409).json({ message: 'That is already your email address.' });
        }
        // Reject an address already in use before sending a code to it (friendly, non-leaking).
        const taken = await dbQuery('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [newEmail, req.userId]);
        if (taken.rowCount) {
          return res.status(409).json({ message: 'That email already has an account. Try another.' });
        }
        email = newEmail;
      }

      const result = await verification.start({
        userId: req.userId,
        operation: body.operation,
        channel: 'email',
        target: body.target ?? null,
        ipAddress: req.ip,
        authVersion: req.authVersion ?? null,
      });
      if (result.kind === 'throttled' || result.kind === 'cooldown') {
        if (result.retryAfter) res.set?.('Retry-After', String(result.retryAfter));
        return res.status(429).json({ message: result.message, retryAfter: result.retryAfter });
      }
      if (result.kind !== 'started') {
        return res.status(result.kind === 'disabled' ? 503 : 400).json({ message: result.message });
      }

      // Deliver the code out-of-band. Real emails only when delivery is enabled; the raw code
      // is passed to the adapter, never placed in the HTTP response or any log.
      let delivered = false;
      let deliveryFailed = false;
      // canRetry governs the UI: a CONFIRMED rejection voids the dead challenge and frees its
      // rate-limit slot, so the user may try again right away. An AMBIGUOUS failure keeps the
      // challenge (the email may have gone out) and lets the normal cooldown prevent duplicates.
      let canRetry = false;
      if (config.deliveryEnabled) {
        try {
          await emailAdapter.sendVerificationCode({
            recipient: email, firstName, code: result.code, operation: body.operation,
          });
          delivered = true;
        } catch (sendError) {
          deliveryFailed = true;
          const outcome = sendError instanceof VerificationDeliveryError ? sendError.outcome : 'ambiguous';
          if (outcome === 'rejected') {
            // Confirmed not-sent: void the challenge + refund this attempt's rate-limit slots.
            await verification.voidFailedDelivery({
              userId: req.userId,
              challengeId: result.challengeId,
              operation: body.operation,
            });
            canRetry = true;
          }
          // Log the failure WITHOUT the OTP, recipient, or provider body.
          console.warn(`[verification] delivery failed (outcome=${outcome}) for operation=${body.operation}`);
        }
      }
      // A voided (confirmed-rejected) challenge is dead; do not hand its id back as if usable.
      const challengeId = deliveryFailed && canRetry ? null : result.challengeId;
      return res.status(201).json({
        challengeId,
        operation: result.operation,
        channel: result.channel,
        maskedDestination: maskEmail(email),
        expiresInMinutes: result.expiresInMinutes,
        // Honest signals for the UI: `delivered` is true only when a send actually succeeded.
        delivered,
        deliveryFailed,
        canRetry,
        deliveryEnabled: Boolean(config.deliveryEnabled),
      });
    } catch (error) {
      return next(error);
    }
  });

  // POST /api/verification/verify { challengeId, operation, code, target? }
  router.post('/verify', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      if (!hasExactFields(body, VERIFY_FIELDS) || !EMAIL_OPERATIONS.has(body.operation)) {
        return res.status(400).json({ message: 'Enter the verification code to continue.' });
      }
      const result = await verification.verify({
        userId: req.userId,
        challengeId: body.challengeId,
        operation: body.operation,
        code: body.code,
        target: body.target ?? null,
        // Move to the explicit VERIFIED state WITHOUT consuming. The paired protected-change
        // endpoint atomically consumes it (verification-service.consumeVerified) inside the
        // same transaction as the account update, so verifying alone never authorizes a change.
        consume: false,
      });
      if (result.kind === 'verified') {
        return res.json({ verified: true, challengeId: result.challengeId, operation: result.operation });
      }
      if (result.kind === 'incorrect') return res.status(400).json({ message: result.message });
      if (result.kind === 'locked') return res.status(429).json({ message: result.message });
      return res.status(result.kind === 'disabled' ? 503 : 400).json({ message: result.message });
    } catch (error) {
      return next(error);
    }
  });

  // POST /api/verification/google/nonce  (step-up reauth nonce for Google-linked customers)
  router.post('/google/nonce', async (req, res, next) => {
    try {
      if (req.body && Object.keys(req.body).length) {
        return res.status(400).json({ message: 'This request must not include data.' });
      }
      const result = await googleReauth.issueNonce(req.userId);
      if (result.kind === 'issued') return res.status(201).json({ selector: result.selector, nonce: result.nonce });
      if (result.kind === 'not_linked') {
        return res.status(409).json({ message: 'This account is not linked to Google.' });
      }
      return res.status(result.kind === 'disabled' ? 503 : 400).json({ message: 'Google reauthentication is unavailable.' });
    } catch (error) {
      return next(error);
    }
  });

  // POST /api/verification/google/verify { selector, nonce, idToken }
  router.post('/google/verify', async (req, res, next) => {
    try {
      if (!hasExactFields(req.body, REAUTH_FIELDS)
        || Object.keys(req.body).length !== REAUTH_FIELDS.size) {
        return res.status(400).json({ message: 'Google reauthentication could not be completed.' });
      }
      const result = await googleReauth.verify({ userId: req.userId, ...req.body });
      if (result.kind === 'verified') return res.json({ verified: true });
      return res.status(result.kind === 'disabled' ? 503 : 400).json({
        message: 'Google reauthentication could not be completed.',
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export default createVerificationRouter();
