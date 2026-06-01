import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { generateSecret, otpauthUrl } from '@/lib/totp';

/**
 * Step 1 of TOTP enrollment. Generates a fresh secret, stores it on the user
 * (without flipping mfaEnabledAt yet), and returns the otpauth:// URL so the
 * client can render a QR code. The user then enters a current code at
 * /api/auth/mfa/verify-enrollment to actually turn MFA on.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  if (user.mfaEnabledAt) {
    return res.status(409).json({ error: 'MFA is already enabled — disable it first to re-enroll' });
  }

  const { base32 } = generateSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: base32, mfaRecoveryCodes: null },
  });

  const issuer = process.env.APP_NAME || 'Remotely';
  const url = otpauthUrl({ issuer, account: user.email, secret: base32 });

  await writeAudit({ action: 'mfa.enroll.start', userId: user.id, req });

  return res.status(200).json({
    secret: base32,        // for manual entry into the authenticator
    otpauthUrl: url,       // for QR code rendering on the client
  });
}
