import type { NextApiRequest, NextApiResponse } from 'next';
import { sealAndAnchorAllScopes } from '@/lib/auditChain';
import { isAuthorizedCron } from '@/lib/cronAuth';

/**
 * GET|POST /api/internal/cron/seal-audit
 *
 * Seals pending audit rows into each scope's hash chain and writes a signed
 * anchor over every new head. Run on a schedule (daily) so the log is
 * continuously tamper-evident and there's a fresh signed checkpoint to compare
 * against if history is ever rewritten.
 *
 * Unlike /api/orgs/[orgId]/audit/seal (admin-auth, single org), this is the
 * unattended job: secret-guarded and covers all scopes including the global
 * (null-org) one. Requires AUDIT_ANCHOR_SECRET to be set in production.
 *
 * web/vercel.json:
 *   { "crons": [{ "path": "/api/internal/cron/seal-audit", "schedule": "10 3 * * *" }] }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'unauthorized' });

  const result = await sealAndAnchorAllScopes();
  return res.status(200).json({ ok: true, ...result });
}
