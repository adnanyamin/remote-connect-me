import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOrgRoleByPath } from '@/lib/org';

/**
 * GET /api/orgs/[orgId]/recordings  — list recordings in the org (admin+).
 *
 * Cursor-paginated by createdAt, newest first. Joins device name for display.
 * Never returns wrappedKey or storageKey — those are server-internal.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'admin');
  if (!auth.ok) return;

  let limit = parseInt(String(req.query.limit ?? ''), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  let before: Date | null = null;
  if (typeof req.query.before === 'string' && req.query.before) {
    const t = new Date(req.query.before);
    if (Number.isFinite(t.getTime())) before = t;
  }

  const where: any = { orgId };
  if (before) where.createdAt = { lt: before };

  const rows = await prisma.sessionRecording.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  // Resolve device names in one query.
  const deviceIds = Array.from(new Set(rows.map((r) => r.deviceId)));
  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(devices.map((d) => [d.id, d.name]));

  // Resolve viewer emails.
  const viewerIds = Array.from(new Set(rows.map((r) => r.viewerUserId).filter(Boolean))) as string[];
  const users = await prisma.user.findMany({
    where: { id: { in: viewerIds } },
    select: { id: true, email: true },
  });
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextBefore = hasMore ? page[page.length - 1].createdAt.toISOString() : null;

  return res.status(200).json({
    recordings: page.map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      deviceName: nameById.get(r.deviceId) ?? '(deleted device)',
      viewerEmail: r.viewerUserId ? (emailById.get(r.viewerUserId) ?? null) : null,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      durationMs: r.durationMs,
      bytes: r.bytes,
      chunkCount: r.chunkCount,
      expiresAt: r.expiresAt,
    })),
    nextBefore,
  });
}
