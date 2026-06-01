import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma, User, Organization, Membership } from '@prisma/client';
import { prisma } from './db';
import { getSessionUser } from './auth';
import { hasRole, isRole, type Role } from './rbac';

/**
 * Tenant resolution + membership checks for Wave 2.
 *
 * Resolution order for "which org is this request scoped to?":
 *   1. `remotely_active_org` cookie, if it points at an org the user belongs to
 *   2. The user's personal org (every user has exactly one, created at signup)
 *   3. First membership by createdAt (fallback for users whose personal org was
 *      converted into a team org)
 *
 * Endpoints generally call `requireOrgRole(req, 'technician')` etc., which
 * combines session-lookup + active-org resolution + role check in one go.
 */

export const ACTIVE_ORG_COOKIE = 'remotely_active_org';

function readCookie(req: NextApiRequest, name: string): string | null {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** Lowercases + dashes the local-part of an email for use in an org slug. */
export function slugFromEmail(email: string): string {
  const local = email.split('@')[0] || 'user';
  return local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'user';
}

/**
 * Atomically create a personal org + owner membership for a new user. Caller
 * passes a Prisma transaction client so this composes with user creation in
 * `signup`. Handles slug collisions by appending the last 6 chars of the
 * user id — guaranteed unique because user ids are unique.
 */
export async function createPersonalOrg(
  tx: Prisma.TransactionClient,
  user: Pick<User, 'id' | 'email' | 'createdAt'>,
): Promise<{ org: Organization; membership: Membership }> {
  const local = user.email.split('@')[0] || 'user';
  const name = `${local}'s workspace`;
  const base = slugFromEmail(user.email);
  // Avoid the `Organization_slug_key` unique-constraint collision by appending
  // the tail of the user id; identical to what the migration backfill does for
  // legacy users so the format stays consistent across rows.
  const slug = `p-${base}-${user.id.slice(-6).toLowerCase()}`;

  const org = await tx.organization.create({
    data: { name, slug, personal: true, createdAt: user.createdAt },
  });
  const membership = await tx.membership.create({
    data: { userId: user.id, orgId: org.id, role: 'owner', createdAt: user.createdAt },
  });
  return { org, membership };
}

export interface ActiveOrgContext {
  user: User;
  org: Organization;
  membership: Membership;
  role: Role;
}

/**
 * Resolves the active org for the current request. Returns null if not signed
 * in or the user has no memberships (shouldn't happen post-Wave-2 signup, but
 * a legacy account without a backfilled membership would hit this).
 */
export async function getActiveOrg(req: NextApiRequest): Promise<ActiveOrgContext | null> {
  const user = await getSessionUser(req);
  if (!user) return null;

  const requested = readCookie(req, ACTIVE_ORG_COOKIE);
  let membership = null as Membership | null;

  if (requested) {
    membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: requested } },
    });
  }

  if (!membership) {
    // Prefer the personal org. Fall back to oldest membership.
    membership = await prisma.membership.findFirst({
      where: { userId: user.id, org: { personal: true } },
      orderBy: { createdAt: 'asc' },
    });
  }
  if (!membership) {
    membership = await prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  if (!membership) return null;
  if (!isRole(membership.role)) return null;

  const org = await prisma.organization.findUnique({ where: { id: membership.orgId } });
  if (!org) return null;

  return { user, org, membership, role: membership.role };
}

/**
 * `Result` is a discriminated union so the caller can `if (!result.ok) return;`
 * after a 401/403 has been written, and still get a typed `ctx` on success.
 */
export type RequireOrgResult =
  | { ok: true; ctx: ActiveOrgContext }
  | { ok: false; status: 401 | 403 | 404; error: string };

export async function requireOrgRole(
  req: NextApiRequest,
  res: NextApiResponse,
  min: Role,
): Promise<RequireOrgResult> {
  const ctx = await getActiveOrg(req);
  if (!ctx) {
    res.status(401).json({ error: 'not signed in' });
    return { ok: false, status: 401, error: 'not signed in' };
  }
  if (!hasRole(ctx.role, min)) {
    res.status(403).json({ error: `requires ${min} role or higher` });
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true, ctx };
}

/**
 * Like `requireOrgRole`, but checks membership in a SPECIFIC org passed in
 * (typically from a URL segment). Use this for `/api/orgs/[orgId]/...`
 * endpoints where the path determines the tenant, not the active-org cookie.
 *
 * Returns 404 (not 403) when the caller has no membership at all — we don't
 * leak whether the org exists to non-members.
 */
export async function requireOrgRoleByPath(
  req: NextApiRequest,
  res: NextApiResponse,
  orgId: string,
  min: Role,
): Promise<RequireOrgResult> {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'not signed in' });
    return { ok: false, status: 401, error: 'not signed in' };
  }
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: user.id, orgId } },
  });
  if (!membership || !isRole(membership.role)) {
    res.status(404).json({ error: 'not found' });
    return { ok: false, status: 404, error: 'not found' };
  }
  if (!hasRole(membership.role, min)) {
    res.status(403).json({ error: `requires ${min} role or higher` });
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) {
    res.status(404).json({ error: 'not found' });
    return { ok: false, status: 404, error: 'not found' };
  }
  return { ok: true, ctx: { user, org, membership, role: membership.role } };
}

/** Sets the `remotely_active_org` cookie so future requests scope to this org. */
export function setActiveOrgCookie(res: NextApiResponse, orgId: string) {
  const cookie = [
    `${ACTIVE_ORG_COOKIE}=${encodeURIComponent(orgId)}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 90}`, // 90 days
    process.env.NODE_ENV === 'production' ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  // Compose with any cookies a previous handler already set.
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing.map(String), cookie]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookie]);
  }
}
