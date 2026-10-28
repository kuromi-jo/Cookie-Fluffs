/**
 * @file recovery-email.js
 * @description Optional Brevo adapter for sending password-reset codes without exposing credentials.
 */

const BREVO_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function plainText(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function passwordResetEmail(firstName, code) {
  const safeName = firstName ? escapeHtml(plainText(firstName)) : '';
  const safeCode = String(code).replace(/\D/g, '').slice(0, 6);
  const greeting = safeName ? `Hi ${safeName},` : 'Hello,';
  const textGreeting = firstName ? `Hi ${plainText(firstName)},` : 'Hello,';
  const htmlContent = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#fff5f7;color:#4a3024;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#fff5f7;"><tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;border:1px solid #fbcfe8;border-radius:20px;background:#ffffff;">
<tr><td style="padding:28px 28px 12px;text-align:center;"><div style="font-family:Georgia,Times,serif;font-size:28px;font-weight:700;color:#523628;">Cookie Fluffs</div><div style="margin-top:6px;font-size:13px;color:#be185d;">Account security</div></td></tr>
<tr><td style="padding:12px 28px 30px;"><p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${greeting}</p><h1 style="margin:0 0 12px;font-family:Georgia,Times,serif;font-size:25px;line-height:1.25;color:#4a3024;">Reset your password</h1><p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#6d5144;">Enter this code in the Cookie Fluffs app within 30 minutes to choose a new password.</p><p style="margin:0 0 18px;text-align:center;"><span style="display:inline-block;padding:14px 26px;border:1px solid #fbcfe8;border-radius:12px;background:#fff5f7;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#523628;">${safeCode}</span></p><p style="margin:0 0 18px;font-size:13px;line-height:1.55;color:#6d5144;">Never share this code. Cookie Fluffs will never ask you for it.</p><p style="margin:0;padding:14px 16px;border:1px solid #fbcfe8;border-radius:12px;background:#fce7f3;font-size:13px;line-height:1.55;color:#6d5144;">If you did not request this reset, ignore this email. Your password will remain unchanged.</p></td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #fbcfe8;text-align:center;font-size:12px;line-height:1.5;color:#8a6d61;">Cookie Fluffs account security<br>This automated message does not ask for your password.</td></tr>
</table></td></tr></table></body></html>`;
  const textContent = `${textGreeting}\n\nReset your Cookie Fluffs password\n\nYour code: ${safeCode}\nEnter it in the app within 30 minutes. Never share this code.\n\nIf you did not request this reset, ignore this email. Your password will remain unchanged.\n\nCookie Fluffs account security`;
  return { htmlContent, textContent };
}

/** Creates a bounded server-side Brevo sender. */
export function createBrevoEmailAdapter(config, { fetchFn = globalThis.fetch } = {}) {
  return {
    async sendPasswordReset({ recipient, firstName, code }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const content = passwordResetEmail(firstName, code);
        const response = await fetchFn(BREVO_EMAIL_URL, {
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
            subject: 'Your Cookie Fluffs password reset code',
            headers: {
              'X-Mailin-track-opens': '0',
              'X-Mailin-track-clicks': '0',
            },
            htmlContent: content.htmlContent,
            textContent: content.textContent,
          }),
        });
        if (!response.ok) throw new Error('Email provider rejected the request.');
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
