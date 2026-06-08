import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { getDeviceFromAuthHeader } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/devices/[id]/session-decision  { decision: "accept" | "reject" }
 *
 * Host-authenticated (Bearer device key). Called by the Electron client after
 * the local user dismisses the approval dialog so the decision lands in the
 * org's audit log.
 *
 * Failure here MUST NOT block the live session — the host treats this call as
 * best-effort and ignores errors. We still 4xx loudly though, so a malformed
 * client gets debugged eventually.
 */
const Body = z.object({
  decision: z.enum(['accept', 'reject']),
  // Reserved for a future change where the API plumbs viewer identity into
  // the host dialog; today the host has no way to know who's connecting.
  reason: z.string().max(200).optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const device = await getDeviceFromAuthHeader(req);
  if (!device) return res.status(401).json({ error: 'invalid device key' });

  const id = String(req.query.id);
  // The Bearer token is bound to a specific device, but the URL also carries
  // an id. They must match — otherwise a paired device could write audit rows
  // pretending to be a different device.
  if (device.id !== id) return res.status(404).json({ error: 'not found' });

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  await writeAudit({
    action: parsed.data.decision === 'accept' ? 'session.approved' : 'session.rejected',
    orgId: device.orgId,
    // userId left null on purpose: the device key auths the host machine, not a
    // specific person. The audit "actor" here is the device itself.
    targetType: 'device',
    targetId: device.id,
    req,
    metadata: parsed.data.reason ? { reason: parsed.data.reason } : undefined,
  });

  return res.status(200).json({ ok: true });
}
