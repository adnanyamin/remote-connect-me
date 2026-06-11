import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionUser, getDeviceFromRequest } from '@/lib/auth';
import { issueTurnCredentials } from '@/lib/turn';
import { limit, BUCKETS } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

/**
 * Returns short-lived TURN credentials. Authed as EITHER:
 *  - a signed-in web user (viewer side), or
 *  - a paired device via Bearer <deviceId>.<secret> (host side).
 *
 * Always returns the full iceServers array — drop it into
 * new RTCPeerConnection({ iceServers }) verbatim.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let userId: string | null = null;

  const user = await getSessionUser(req);
  if (user) {
    if (!user.emailVerifiedAt) {
      return res.status(403).json({ error: 'verify your email first' });
    }
    userId = user.id;
  } else {
    const device = await getDeviceFromRequest(req);
    if (!device) return res.status(401).json({ error: 'auth required' });
    userId = device.userId;
  }

  const rl = await limit({ key: `turn:${userId}`, ...BUCKETS.turn });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many TURN credential requests' });
  }

  try {
    const creds = issueTurnCredentials(userId!);
    await writeAudit({ action: 'turn.credentials_issued', userId, req });
    return res.status(200).json(creds);
  } catch (e: any) {
    return res.status(503).json({ error: e?.message || 'turn not configured' });
  }
}
