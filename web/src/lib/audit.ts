import type { NextApiRequest } from 'next';
import { prisma } from './db';
import { clientIp } from './ratelimit';

/**
 * Append-only audit log writer. Calls to writeAudit() must never throw — a
 * failure here will be logged to stderr but won't break the user request.
 *
 * Wave 4 will retrofit a hash chain (prevHash / rowHash) on top of this same
 * model so the log becomes tamper-evident.
 */
export type AuditAction =
  | 'auth.signup'
  | 'auth.login.success'
  | 'auth.login.fail'
  | 'auth.logout'
  | 'auth.email_verified'
  | 'auth.email_verify_sent'
  | 'auth.mfa.required'
  | 'auth.mfa.success'
  | 'auth.mfa.fail'
  | 'auth.mfa.recovery_used'
  | 'mfa.enroll.start'
  | 'mfa.enroll.complete'
  | 'mfa.disable'
  | 'org.create'
  | 'org.switch'
  | 'org.invitation.create'
  | 'org.invitation.revoke'
  | 'org.invitation.accept'
  | 'org.member.role_change'
  | 'org.member.remove'
  | 'org.member.leave'
  | 'device.create'
  | 'device.pair'
  | 'device.pair.fail'
  | 'device.delete'
  | 'device.update'
  | 'device.connect_token'
  | 'session.approved'
  | 'session.rejected'
  | 'session.recording.start'
  | 'session.recording.stop'
  | 'session.recording.download'
  | 'session.recording.purge'
  | 'org.settings.update'
  | 'audit.sealed'
  | 'turn.credentials_issued';

export interface AuditInput {
  action: AuditAction;
  userId?: string | null;
  /** Tenant scope. Optional because some events (rate-limited signups, anonymous
   *  pair failures) happen before any org is known. */
  orgId?: string | null;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  req?: NextApiRequest;
  ip?: string;
  userAgent?: string;
}

export async function writeAudit(input: AuditInput): Promise<void> {
  const ip = input.ip ?? (input.req ? clientIp(input.req) : undefined);
  const userAgent =
    input.userAgent ??
    (input.req ? String(input.req.headers['user-agent'] || '').slice(0, 500) : undefined);
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        userId: input.userId || null,
        orgId: input.orgId || null,
        targetType: input.targetType,
        targetId: input.targetId,
        ip,
        userAgent,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });
  } catch (e) {
    console.error('[audit] write failed', e);
  }
}
