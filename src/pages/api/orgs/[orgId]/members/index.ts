import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOrgRoleByPath } from '@/lib/org';

/**
 * GET /api/orgs/[orgId]/members  — list current members (viewer+).
 *
 * Every member of an org can see the other members. Editing the list (role
 * changes, removals) lives on /api/orgs/[orgId]/members/[userId] and requires
 * admin+.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'viewer');
  if (!auth.ok) return;

  const memberships = await prisma.membership.findMany({
    where: { orgId },
    include: { user: { select: { id: true, email: true, createdAt: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return res.status(200).json({
    members: memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt,
    })),
  });
}
