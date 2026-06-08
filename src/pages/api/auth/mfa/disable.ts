import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getSessionUser, verifyPassword } from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';
import { verifyTotp, fromBase32 } from '@/lib/totp';

/**
 * Disable MFA. Requires the current password AND a current TOTP code (if MFA
 * is enabled). Failing the check is rate-limited identically to a login.
 */
const Body = z.object({
  password: z.string().min(1),
  code: z.string().min(6).max(8).optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });

  const ip = clientIp(req);
  const rl = await limit({ key: `mfa-disable:${ip}:${user.id}`, ...BUCKETS.authLogin });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    await writeAudit({ action: 'auth.mfa.fail', userId: user.id, req, metadata: { phase: 'disable_password' } });
    return res.status(401).json({ error: 'wrong password' });
  }

  if (user.mfaEnabledAt && user.mfaSecret) {
    if (!parsed.data.code || !verifyTotp(fromBase32(user.mfaSecret), parsed.data.code)) {
      await writeAudit({ action: 'auth.mfa.fail', userId: user.id, req, metadata: { phase: 'disable_code' } });
      return res.status(401).json({ error: 'wrong code' });
    }
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: null },
  });
  await writeAudit({ action: 'mfa.disable', userId: user.id, req });
  return res.status(200).json({ ok: true });
}
