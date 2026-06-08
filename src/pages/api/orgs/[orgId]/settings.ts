import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRoleByPath } from '@/lib/org';

/**
 * PATCH /api/orgs/[orgId]/settings  { recordingPolicy?, recordingRetentionDays?, name? }
 *
 * Owner-only org settings. Currently covers recording policy/retention and
 * the org display name. Audited as org.settings.update with a per-field diff.
 */
const Body = z.object({
  name: z.string().min(1).max(80).optional(),
  recordingPolicy: z.enum(['off', 'optional', 'required']).optional(),
  recordingRetentionDays: z.number().int().min(1).max(3650).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'owner');
  if (!auth.ok) return;
  const { ctx } = auth;

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  const before = ctx.org;
  const updated = await prisma.organization.update({
    where: { id: orgId },
    data: parsed.data,
  });

  // Build a diff of only what actually changed.
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(parsed.data) as (keyof typeof parsed.data)[]) {
    if ((before as any)[k] !== (updated as any)[k]) {
      diff[k] = { from: (before as any)[k], to: (updated as any)[k] };
    }
  }

  await writeAudit({
    action: 'org.settings.update',
    userId: ctx.user.id,
    orgId,
    targetType: 'org',
    targetId: orgId,
    req,
    metadata: diff,
  });

  return res.status(200).json({
    id: updated.id,
    name: updated.name,
    recordingPolicy: updated.recordingPolicy,
    recordingRetentionDays: updated.recordingRetentionDays,
  });
}
