import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { hashEmailToken } from '@/lib/email';
import { getSessionUser } from '@/lib/auth';

/**
 * GET /api/invitations/[token]
 *
 * Public preview. Lets a non-signed-in invitee see what they're being invited
 * to before deciding to sign up. Never returns the inviter's user id or
 * anything that would allow enumeration — just enough to render the page.
 *
 * Token in the URL is the plaintext from the email; we hash + look up.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const tokenHash = hashEmailToken(String(req.query.token));
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash },
    include: { org: true, invitedBy: true },
  });

  if (!invitation) return res.status(404).json({ error: 'invalid or revoked invitation' });

  const expired = invitation.expiresAt < new Date();
  const used = !!invitation.usedAt;

  // Status the UI uses to decide which CTA to show.
  let status: 'pending' | 'expired' | 'used' = 'pending';
  if (used) status = 'used';
  else if (expired) status = 'expired';

  const sessionUser = await getSessionUser(req);
  const emailMatchesSession =
    sessionUser ? sessionUser.email.toLowerCase() === invitation.email.toLowerCase() : null;

  return res.status(200).json({
    status,
    invitation: {
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      invitedBy: invitation.invitedBy?.email || null,
      org: { id: invitation.org.id, name: invitation.org.name, slug: invitation.org.slug },
    },
    session: sessionUser ? { email: sessionUser.email, emailMatches: emailMatchesSession } : null,
  });
}
