import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRoleByPath } from '@/lib/org';
import { sendEmail, generateEmailToken } from '@/lib/email';
import {
  INVITATION_TTL_MS, isInvitableRole, inviteLink, inviteEmailBody,
} from '@/lib/invitations';

/**
 * GET  /api/orgs/[orgId]/invitations   — list pending invites (admin+)
 * POST /api/orgs/[orgId]/invitations   — create a new invite (admin+)
 *
 * A pending invite is one whose `usedAt` is null AND `expiresAt > now`. The
 * dashboard treats expired-but-unused rows as garbage to be cleaned up; we
 * leave them in the table so we keep an audit trail of cancellations.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const orgId = String(req.query.orgId);

  if (req.method === 'GET') {
    const auth = await requireOrgRoleByPath(req, res, orgId, 'admin');
    if (!auth.ok) return;
    const invites = await prisma.invitation.findMany({
      where: {
        orgId,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, role: true, expiresAt: true, createdAt: true,
        invitedByUserId: true,
      },
    });
    return res.status(200).json({ invitations: invites });
  }

  if (req.method === 'POST') {
    const auth = await requireOrgRoleByPath(req, res, orgId, 'admin');
    if (!auth.ok) return;
    const { ctx } = auth;

    const Body = z.object({
      email: z.string().email().max(254),
      role: z.string(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
    const targetEmail = parsed.data.email.toLowerCase();
    if (!isInvitableRole(parsed.data.role)) {
      return res.status(400).json({ error: `role must be one of: admin, technician, viewer` });
    }
    if (targetEmail === ctx.user.email.toLowerCase()) {
      return res.status(400).json({ error: 'you can\'t invite yourself' });
    }

    // Already a member?
    const existingUser = await prisma.user.findUnique({ where: { email: targetEmail } });
    if (existingUser) {
      const existingMembership = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: existingUser.id, orgId } },
      });
      if (existingMembership) {
        return res.status(409).json({ error: 'that email is already a member of this org' });
      }
    }

    // Already has a pending (unused, unexpired) invitation? Replace it so the
    // new email's token is the only one that works — preventing stale links
    // from staying live after an admin re-invites someone.
    await prisma.invitation.deleteMany({
      where: {
        orgId,
        email: targetEmail,
        usedAt: null,
      },
    });

    const { plaintext, hash } = generateEmailToken();
    const invitation = await prisma.invitation.create({
      data: {
        orgId,
        email: targetEmail,
        role: parsed.data.role,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedByUserId: ctx.user.id,
      },
    });

    const link = inviteLink(plaintext);
    const body = inviteEmailBody({
      orgName: ctx.org.name,
      inviterEmail: ctx.user.email,
      role: parsed.data.role,
      link,
    });
    try {
      await sendEmail({ to: targetEmail, subject: body.subject, text: body.text });
    } catch (e) {
      // Don't fail the API call on email send error — the admin can re-invite,
      // and the row already exists so revoking it is meaningful.
      console.error('[invitations] email send failed', e);
    }

    await writeAudit({
      action: 'org.invitation.create',
      userId: ctx.user.id,
      orgId,
      targetType: 'invitation',
      targetId: invitation.id,
      req,
      metadata: { email: targetEmail, role: parsed.data.role },
    });

    return res.status(200).json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
      // Returned to the admin's UI so they can show a "copy link" affordance
      // (the email might bounce; a manual link is the escape hatch). Production
      // SaaS posture would be "rely on email"; we surface it for self-hosters.
      link,
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
