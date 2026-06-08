import type { NextApiRequest, NextApiResponse } from 'next';
import { requireOrgRoleByPath } from '@/lib/org';
import { sealScope, verifyScope, verifyAnchors, latestAnchor } from '@/lib/auditChain';

/**
 * GET /api/orgs/[orgId]/audit/verify  (admin+)
 *
 * Seals any pending rows (idempotent), then recomputes the org's audit chain
 * and checks all signed anchors. Returns a tamper report the UI can show.
 *
 * Scope is the org id — a tenant only ever verifies its own chain.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'admin');
  if (!auth.ok) return;

  // Seal first so freshly-written rows are included in the verification.
  await sealScope(orgId);
  const chain = await verifyScope(orgId);
  const anchors = await verifyAnchors(orgId);
  const last = await latestAnchor(orgId);

  return res.status(200).json({
    ok: chain.ok && anchors.ok,
    chain: {
      ok: chain.ok,
      count: chain.count,
      head: chain.head,
      brokenAt: chain.brokenAt,
      reason: chain.reason ?? null,
    },
    anchors: {
      ok: anchors.ok,
      total: anchors.total,
      badAnchorIds: anchors.badAnchorIds,
    },
    lastAnchor: last,
  });
}
