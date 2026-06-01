import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { hashEmailToken } from '@/lib/email';
import { getSessionUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { setActiveOrgCookie } from '@/lib/org';
import { isRole } from '@/lib/rbac';

/**
 * POST /api/invitations/[token]/accept
 *
 * Consumes a valid invitation: creates a Membership row, marks the invite
 * used, and switches the active-org cookie so the user lands in their new
 * org's dashboard. Requires the signed-in user's email to match the invite's
 * target email — strict policy, no aliases.
 *
 * All state changes happen in one transaction so a half-applied accept can't
 * leave a Membership row without marking the invitation used (or vice versa).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'sign in first' });

  const tokenHash = hashEmailToken(String(req.query.token));
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash } });
  if (!invitation) return res.status(404).json({ error: 'invalid or revoked invitation' });
  if (invitation.usedAt) return res.status(410).json({ error: 'invitation already used' });
  if (invitation.expiresAt < new Date()) {
    return res.status(410).json({ error: 'invitation expired' });
  }
  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    // 403 is correct here — we DID find the invite, the caller just isn't the
    // intended recipient. Return the target email so the UI can prompt
    // "sign in as X@..." without us having to expose every invite to anyone.
    return res.status(403).json({
      error: 'this invitation is for a different account',
      expectedEmail: invitation.email,
    });
  }
  if (!isRole(invitation.role)) {
    return res.status(500).json({ error: 'invitation has invalid role — contact support' });
  }

  // If the user is somehow already a member (shouldn't be — the invite-create
  // path blocks that — but a race during signup could trigger it), just mark
  // the invite used without duplicating membership.
  const existing = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: user.id, orgId: invitation.orgId } },
  });

  await prisma.$transaction(async (tx) => {
    if (!existing) {
      await tx.membership.create({
        data: { userId: user.id, orgId: invitation.orgId, role: invitation.role },
      });
    }
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date(), usedByUserId: user.id },
    });
  });

  // Park the user in their new org so the next dashboard load shows it.
  setActiveOrgCookie(res, invitation.orgId);

  await writeAudit({
    action: 'org.invitation.accept',
    userId: user.id,
    orgId: invitation.orgId,
    targetType: 'invitation',
    targetId: invitation.id,
    req,
    metadata: { role: invitation.role, alreadyMember: !!existing },
  });

  return res.status(200).json({
    ok: true,
    orgId: invitation.orgId,
    role: invitation.role,
  });
}
