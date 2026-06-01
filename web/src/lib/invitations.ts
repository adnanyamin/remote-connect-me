import type { Role } from './rbac';

/**
 * Helpers shared between invitation endpoints.
 *
 * Tokens follow the same pattern as email-verification tokens: a random
 * 32-byte plaintext goes in the email, only the SHA-256 hash is stored. The
 * server-side row never holds material that could be used to accept the
 * invitation if leaked from the DB.
 */

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Roles an admin is allowed to grant via the invitation flow. Owner is
 *  intentionally excluded — ownership transfer is a separate, gated action. */
export const INVITABLE_ROLES: readonly Exclude<Role, 'owner'>[] = ['admin', 'technician', 'viewer'];

export function isInvitableRole(s: unknown): s is Exclude<Role, 'owner'> {
  return typeof s === 'string' && (INVITABLE_ROLES as readonly string[]).includes(s);
}

export function inviteLink(plaintextToken: string): string {
  return `${APP_BASE_URL}/invite/${encodeURIComponent(plaintextToken)}`;
}

export function inviteEmailBody(opts: {
  orgName: string;
  inviterEmail?: string | null;
  role: string;
  link: string;
}): { subject: string; text: string } {
  const inviter = opts.inviterEmail ? `${opts.inviterEmail} ` : '';
  const subject = `${inviter || 'Someone'}invited you to ${opts.orgName} on Remotely`;
  const text =
    `${inviter || 'A teammate'}invited you to join "${opts.orgName}" on Remotely as a ${opts.role}.\n\n` +
    `Accept the invitation here (expires in 7 days):\n\n` +
    `${opts.link}\n\n` +
    `If you weren't expecting this, ignore the email — the invite expires automatically.`;
  return { subject, text };
}
