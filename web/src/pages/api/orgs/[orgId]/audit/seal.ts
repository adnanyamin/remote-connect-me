import type { NextApiRequest, NextApiResponse } from 'next';
import { requireOrgRoleByPath } from '@/lib/org';
import { writeAudit } from '@/lib/audit';
import { sealScope, anchorScope } from '@/lib/auditChain';

/**
 * POST /api/orgs/[orgId]/audit/seal  (admin+)
 *
 * Seals pending rows into the chain and writes a signed anchor over the new
 * head. Intended to be called periodically (e.g. a daily cron hitting this for
 * each org, or manually from the audit UI). Records its own audit row — which
 * will itself be sealed on the next pass.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'admin');
  if (!auth.ok) return;
  const { ctx } = auth;

  const { head, sealed } = await sealScope(orgId);
  const anchor = await anchorScope(orgId);

  await writeAudit({
    action: 'audit.sealed',
    userId: ctx.user.id,
    orgId,
    targetType: 'org',
    targetId: orgId,
    req,
    metadata: { sealed, head: head?.seq ?? null, anchored: anchor?.seq ?? null },
  });

  return res.status(200).json({
    ok: true,
    sealed,
    head,
    anchor,
  });
}
