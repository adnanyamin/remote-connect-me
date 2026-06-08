import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';

/**
 * GET /api/orgs  — list orgs the current user belongs to.
 *
 * Used by the dashboard's org-switcher dropdown. Returns role too, so the UI
 * can render an icon next to "personal" vs team orgs and disable affordances
 * the user wouldn't have.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { org: true },
    orderBy: { createdAt: 'asc' },
  });
  return res.status(200).json({
    orgs: memberships.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      personal: m.org.personal,
      role: m.role,
    })),
  });
}
