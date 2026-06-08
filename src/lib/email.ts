import { randomBytes, createHash } from 'crypto';

/**
 * Email driver. Two modes:
 *  - Dev / unconfigured: logs the email body to stderr so you can grab the
 *    verification link from `next dev` output without setting up SMTP.
 *  - Production: HTTPS POST to Resend (resend.com). Cheapest tier is free.
 *    Set RESEND_API_KEY + EMAIL_FROM to switch on.
 *
 * The verification-token helper produces a plaintext token (emailed) and a
 * SHA-256 hash (stored). Tokens are never persisted in plaintext.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'RemoteConnectMe <no-reply@example.com>';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

export interface SendArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(args: SendArgs): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log(
      `\n[email:dev] -> ${args.to}\nSubject: ${args.subject}\n${args.text}\n`,
    );
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html || args.text,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`resend send failed: ${r.status} ${body}`);
  }
}

/** Returns { plaintext: emailed token, hash: stored SHA-256 hex }. */
export function generateEmailToken() {
  const plaintext = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}

export function hashEmailToken(plaintext: string) {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function verificationLink(token: string) {
  return `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
}
