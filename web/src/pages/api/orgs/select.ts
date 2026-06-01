import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { setActiveOrgCookie } from '@/lib/org';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/orgs/select  { orgId }
 *
 * Sets the `remotely_active_org` cookie so subsequent requests resolve that
 * org as the active one. Requires the caller to be a member — we never let
 * someone "switch into" an org they don't belong to.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });

  const Body = z.object({ orgId: z.string().min(1) });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: user.id, orgId: parsed.data.orgId } },
  });
  if (!membership) return res.status(404).json({ error: 'not found' });

  setActiveOrgCookie(res, parsed.data.orgId);
  await writeAudit({
    action: 'org.switch',
    userId: user.id,
    orgId: parsed.data.orgId,
    req,
  });
  return res.status(200).json({ ok: true });
}
