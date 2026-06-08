import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRoleByPath } from '@/lib/org';

/**
 * DELETE /api/orgs/[orgId]/invitations/[id]  — revoke a pending invite (admin+).
 *
 * Idempotent: revoking an already-used or already-deleted invite returns 404,
 * never a partial-state error. The actual row is hard-deleted; the audit row
 * carries the email/role so the trail isn't lost.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'admin');
  if (!auth.ok) return;
  const { ctx } = auth;

  const id = String(req.query.id);
  const invitation = await prisma.invitation.findFirst({
    where: { id, orgId, usedAt: null },
  });
  if (!invitation) return res.status(404).json({ error: 'not found' });

  await prisma.invitation.delete({ where: { id: invitation.id } });
  await writeAudit({
    action: 'org.invitation.revoke',
    userId: ctx.user.id,
    orgId,
    targetType: 'invitation',
    targetId: invitation.id,
    req,
    metadata: { email: invitation.email, role: invitation.role },
  });
  return res.status(200).json({ ok: true });
}
