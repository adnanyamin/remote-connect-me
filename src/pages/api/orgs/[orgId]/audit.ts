import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOrgRoleByPath } from '@/lib/org';

/**
 * GET /api/orgs/[orgId]/audit
 *
 * Cursor-paginated audit log query. Admin+.
 *
 * Query params:
 *   action      — exact-match filter on the action code (e.g. "device.connect_token")
 *   userId      — filter by user who performed the action
 *   before      — ISO timestamp; rows strictly older than this. Cursor.
 *   limit       — page size, 1..200, default 50
 *
 * Response:
 *   { rows: [...], nextBefore: string | null }
 *
 * The cursor is just the oldest row's createdAt; `before=<nextBefore>` returns
 * the next page. Stable as long as no two rows on the same page share a
 * timestamp (cuid + insert order makes this overwhelmingly unlikely; we sort
 * by (createdAt, id) to break ties anyway).
 */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'admin');
  if (!auth.ok) return;

  // Parse + clamp params.
  const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : null;
  const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : null;
  let limit = parseInt(String(req.query.limit ?? ''), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  let before: Date | null = null;
  if (typeof req.query.before === 'string' && req.query.before) {
    const t = new Date(req.query.before);
    if (Number.isFinite(t.getTime())) before = t;
  }

  const where: any = { orgId };
  if (action) where.action = action;
  if (userId) where.userId = userId;
  if (before) where.createdAt = { lt: before };

  // +1 to detect a next page without a second query.
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextBefore = hasMore ? page[page.length - 1].createdAt.toISOString() : null;

  // userId is no longer a FK (audit rows are immutable), so resolve emails in a
  // separate lookup. Some users may have been deleted — show null then.
  const userIds = Array.from(new Set(page.map((r) => r.userId).filter(Boolean))) as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  return res.status(200).json({
    rows: page.map((r) => ({
      id: r.id,
      action: r.action,
      userId: r.userId,
      userEmail: r.userId ? (emailById.get(r.userId) ?? null) : null,
      targetType: r.targetType,
      targetId: r.targetId,
      ip: r.ip,
      userAgent: r.userAgent,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
    nextBefore,
  });
}
