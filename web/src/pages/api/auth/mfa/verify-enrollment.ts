import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import {
  verifyTotp, fromBase32, generateRecoveryCodes, packRecovery,
} from '@/lib/totp';

/**
 * Step 2 of TOTP enrollment. The user supplies a current code from their
 * authenticator app. If it verifies, we flip mfaEnabledAt and hand back
 * 10 single-use recovery codes (shown to the user EXACTLY ONCE).
 */
const Body = z.object({ code: z.string().min(6).max(8) });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  if (!user.mfaSecret) {
    return res.status(400).json({ error: 'no enrollment in progress — start /api/auth/mfa/enroll first' });
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  const ok = verifyTotp(fromBase32(user.mfaSecret), parsed.data.code);
  if (!ok) {
    await writeAudit({ action: 'auth.mfa.fail', userId: user.id, req, metadata: { phase: 'enrollment' } });
    return res.status(401).json({ error: 'wrong code' });
  }

  const recoveryCodes = generateRecoveryCodes(10);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabledAt: new Date(),
      mfaRecoveryCodes: packRecovery(recoveryCodes),
    },
  });
  await writeAudit({ action: 'mfa.enroll.complete', userId: user.id, req });

  return res.status(200).json({ ok: true, recoveryCodes });
}
