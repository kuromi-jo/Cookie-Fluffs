/**
 * @file verification-email.js
 * @description Optional Brevo adapter for delivering identity-verification codes, kept separate
 * from the password-recovery adapter. Real sending is gated by VERIFICATION_DELIVERY_ENABLED;
 * tests use an in-memory sender instead. Codes are only ever placed in the email body, never
 * logged or returned through an API.
 */

const BREVO_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Error raised by a delivery adapter so the caller can tell a CONFIRMED provider rejection
 * (the email was definitely not accepted, so a clean immediate retry is safe) from an AMBIGUOUS
 * failure (network timeout/abort after the request may already have been accepted, so a retry
 * could duplicate the send). Never carries the OTP, recipient, or provider body.
 * @property {('rejected'|'ambiguous')} outcome
 */
export class VerificationDeliveryError extends Error {
  constructor(outcome) {
    super(outcome === 'rejected' ? 'Email provider rejected the request.' : 'Email delivery outcome is unconfirmed.');
    this.name = 'VerificationDeliveryError';
    this.outcome = outcome === 'rejected' ? 'rejected' : 'ambiguous';
  }
}

const OPERATION_LABEL = {
  change_phone: 'change your mobile number',
  change_email: 'change your email address',
  set_password: 'set an account password',
  change_password: 'change your password',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function verificationEmail(firstName, code, operation) {
  const safeName = firstName ? escapeHtml(String(firstName).replace(/[\r\n]+/g, ' ').trim()) : '';
  const greeting = safeName ? `Hi ${safeName},` : 'Hello,';
  const action = OPERATION_LABEL[operation] ?? 'confirm a sensitive account change';
  const safeCode = escapeHtml(code);
  const htmlContent = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#fff5f7;color:#4a3024;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#fff5f7;"><tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;border:1px solid #fbcfe8;border-radius:20px;background:#ffffff;">
<tr><td style="padding:28px 28px 12px;text-align:center;"><div style="font-family:Georgia,Times,serif;font-size:28px;font-weight:700;color:#523628;">Cookie Fluffs</div><div style="margin-top:6px;font-size:13px;color:#be185d;">Account security</div></td></tr>
<tr><td style="padding:12px 28px 30px;"><p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${greeting}</p><p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#6d5144;">Use this code to ${action}. It expires in 10 minutes.</p><p style="margin:0 0 22px;text-align:center;"><span style="display:inline-block;padding:14px 26px;border-radius:14px;background:#fce7f3;color:#4a3024;font-size:28px;font-weight:800;letter-spacing:6px;">${safeCode}</span></p><p style="margin:0;padding:14px 16px;border:1px solid #fbcfe8;border-radius:12px;background:#fce7f3;font-size:13px;line-height:1.55;color:#6d5144;">If you did not request this, ignore this email and your account stays unchanged. We will never ask you for this code.</p></td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #fbcfe8;text-align:center;font-size:12px;line-height:1.5;color:#8a6d61;">Cookie Fluffs account security<br>This automated message does not ask for your password.</td></tr>
</table></td></tr></table></body></html>`;
  const textContent = `${greeting}\n\nUse this code to ${action} (expires in 10 minutes):\n\n${code}\n\nIf you did not request this, ignore this email. We will never ask you for this code.\n\nCookie Fluffs account security`;
  return { htmlContent, textContent };
}

/** Creates a bounded server-side Brevo verification sender. */
export function createBrevoVerificationAdapter(config, { fetchFn = globalThis.fetch } = {}) {
  return {
    async sendVerificationCode({ recipient, firstName, code, operation }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let response;
      try {
        const content = verificationEmail(firstName, code, operation);
        response = await fetchFn(BREVO_EMAIL_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'api-key': config.brevoApiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sender: { email: config.senderEmail, name: config.senderName },
            to: [{ email: recipient, contactPixelTrackingConsent: false }],
            subject: 'Your Cookie Fluffs verification code',
            headers: { 'X-Mailin-track-opens': '0', 'X-Mailin-track-clicks': '0' },
            htmlContent: content.htmlContent,
            textContent: content.textContent,
          }),
        });
      } catch {
        // Abort (timeout) or a transport-level network error: the provider may or may not have
        // accepted the message. Treat as AMBIGUOUS so the caller never triggers a duplicate send.
        throw new VerificationDeliveryError('ambiguous');
      } finally {
        clearTimeout(timeout);
      }
      // A completed HTTP response with a non-2xx status is a CONFIRMED rejection: nothing was sent.
      if (!response.ok) throw new VerificationDeliveryError('rejected');
    },
  };
}

/** In-memory sender for automated tests and the disabled-delivery sandbox. Records nothing sensitive beyond the test process. */
export function createInMemoryVerificationAdapter() {
  const sent = [];
  return {
    sent,
    async sendVerificationCode(message) { sent.push(message); },
  };
}
