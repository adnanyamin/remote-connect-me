/**
 * RBAC primitives for Wave 2.
 *
 * Four roles, totally ordered by privilege:
 *
 *   viewer       — read-only: list devices, view audit log, can NOT connect
 *   technician   — viewer + connect to any device in the org
 *   admin        — technician + add/remove devices, manage members (except owner)
 *   owner        — admin + transfer ownership, delete org
 *
 * Every privileged action declares the *minimum* role it accepts; `hasRole`
 * answers via ROLE_RANK comparison. Keep this file dependency-free so it can
 * be imported from server code, edge middleware, and the React UI alike.
 */

export type Role = 'owner' | 'admin' | 'technician' | 'viewer';

export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  viewer: 1,
  technician: 2,
  admin: 3,
  owner: 4,
});

export const ALL_ROLES: readonly Role[] = ['owner', 'admin', 'technician', 'viewer'];

export function isRole(s: unknown): s is Role {
  return typeof s === 'string' && (s as Role) in ROLE_RANK;
}

/** True iff `actual` is at least as privileged as `min`. */
export function hasRole(actual: Role | null | undefined, min: Role): boolean {
  if (!actual || !isRole(actual)) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}

/** Human-readable role label for UI; English only for now. */
export function roleLabel(r: Role): string {
  switch (r) {
    case 'owner': return 'Owner';
    case 'admin': return 'Admin';
    case 'technician': return 'Technician';
    case 'viewer': return 'Viewer';
  }
}
