import type { NextApiRequest, NextApiResponse } from 'next';
import { getActiveOrg } from '@/lib/org';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ctx = await getActiveOrg(req);
  if (!ctx) return res.status(401).json({ error: 'not signed in' });
  const { user, org, role } = ctx;
  return res.status(200).json({
    id: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    mfaEnabled: !!user.mfaEnabledAt,
    // Active org for the current session. Front-end uses this to render the
    // org name in the header and gate UI affordances by role.
    activeOrg: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      personal: org.personal,
      role,
      recordingPolicy: org.recordingPolicy,
      recordingRetentionDays: org.recordingRetentionDays,
    },
  });
}
