import type { NextApiRequest, NextApiResponse } from 'next';
import { clearSessionCookie, getSessionUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req);
  clearSessionCookie(res);
  if (user) await writeAudit({ action: 'auth.logout', userId: user.id, req });
  res.status(200).json({ ok: true });
}
