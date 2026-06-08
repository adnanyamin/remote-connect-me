import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';

/**
 * Tamper-evident audit log: per-scope hash chaining + signed anchors.
 *
 * Design
 * ------
 * Audit rows are written unchained on the hot path (lib/audit.ts) — fast and
 * never-throw. A *sealing* pass then walks the unsealed rows of a scope in
 * (createdAt, id) order and assigns each one:
 *
 *     chainSeq   0-based position in the scope's chain
 *     prevHash   the previous row's rowHash (or the scope genesis for seq 0)
 *     rowHash    sha256(prevHash + "\n" + canonical(row))
 *
 * Because each rowHash folds in the previous one, you cannot alter, reorder,
 * or delete a sealed row without every subsequent rowHash failing to recompute.
 *
 * A *scope* is one independent chain: an organization id, or the sentinel
 * "__global__" for rows with no org (pre-org events like rate-limited signups).
 * Scoping keeps each tenant's chain verifiable without reading other tenants'
 * rows.
 *
 * Anchors are signed checkpoints: an HMAC over (scope, headSeq, headHash) under
 * AUDIT_ANCHOR_SECRET, stored in AuditAnchor. Anchoring periodically (e.g.
 * daily) means an attacker who later rewrites history also has to forge a past
 * anchor signature — which they can't without the secret.
 *
 * Concurrency: sealing runs in a transaction. SQLite serializes writers so this
 * is safe as-is; on Postgres, wrap callers in a `pg_advisory_xact_lock(scope)`
 * (or accept that two concurrent seals of the same scope is rare and the loser
 * simply seals nothing). Rows are immutable (AuditLog has no FKs that could
 * SET NULL them), so a sealed chain never changes underneath us.
 */

export const GLOBAL_SCOPE = '__global__';

export function scopeFor(orgId: string | null | undefined): string {
  return orgId || GLOBAL_SCOPE;
}

function anchorSecret(): string {
  const v = process.env.AUDIT_ANCHOR_SECRET;
  if (v) return v;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUDIT_ANCHOR_SECRET is required in production for audit anchoring');
  }
  return 'dev-audit-anchor-secret-change-me';
}

/** Genesis prevHash for a scope's seq-0 row. Binds the chain to its scope so
 *  one scope's rows can't be spliced into another's chain. */
function genesisPrev(scope: string): string {
  return createHash('sha256').update('remotely-audit-genesis:' + scope).digest('hex');
}

/** Stable serialization of a row's immutable fields, including its seq. */
function canonical(row: {
  chainSeq: number;
  id: string;
  createdAt: Date;
  action: string;
  userId: string | null;
  orgId: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: string | null;
}): string {
  // Fixed key order; JSON.stringify of an array avoids key-ordering ambiguity.
  return JSON.stringify([
    row.chainSeq,
    row.id,
    row.createdAt.toISOString(),
    row.action,
    row.userId ?? null,
    row.orgId ?? null,
    row.targetType ?? null,
    row.targetId ?? null,
    row.ip ?? null,
    row.userAgent ?? null,
    row.metadata ?? null,
  ]);
}

function hashRow(prevHash: string, payload: string): string {
  return createHash('sha256').update(prevHash + '\n' + payload).digest('hex');
}

function scopeWhere(scope: string): Prisma.AuditLogWhereInput {
  return scope === GLOBAL_SCOPE ? { orgId: null } : { orgId: scope };
}

export interface ChainHead { seq: number; hash: string; }

/**
 * Seal all currently-unsealed rows for a scope. Idempotent: a second call with
 * no new rows is a no-op. Returns the new chain head + how many rows it sealed.
 */
export async function sealScope(scope: string): Promise<{ head: ChainHead | null; sealed: number }> {
  return prisma.$transaction(async (tx) => {
    // Current head = highest already-sealed row in this scope.
    const headRow = await tx.auditLog.findFirst({
      where: { ...scopeWhere(scope), chainSeq: { not: null } },
      orderBy: { chainSeq: 'desc' },
      select: { chainSeq: true, rowHash: true },
    });

    let seq = headRow ? (headRow.chainSeq as number) : -1;
    let prevHash = headRow ? (headRow.rowHash as string) : genesisPrev(scope);

    const unsealed = await tx.auditLog.findMany({
      where: { ...scopeWhere(scope), chainSeq: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, createdAt: true, action: true, userId: true, orgId: true,
        targetType: true, targetId: true, ip: true, userAgent: true, metadata: true,
      },
    });

    let sealed = 0;
    for (const r of unsealed) {
      seq += 1;
      const payload = canonical({ ...r, chainSeq: seq });
      const rowHash = hashRow(prevHash, payload);
      await tx.auditLog.update({
        where: { id: r.id },
        data: { chainSeq: seq, prevHash, rowHash },
      });
      prevHash = rowHash;
      sealed += 1;
    }

    const head: ChainHead | null = seq >= 0 ? { seq, hash: prevHash } : null;
    return { head, sealed };
  });
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  head: ChainHead | null;
  /** First seq where the chain breaks (recompute mismatch / gap), if any. */
  brokenAt: number | null;
  reason?: string;
}

/** Recompute a scope's sealed chain from genesis and report the first break. */
export async function verifyScope(scope: string): Promise<VerifyResult> {
  const rows = await prisma.auditLog.findMany({
    where: { ...scopeWhere(scope), chainSeq: { not: null } },
    orderBy: { chainSeq: 'asc' },
    select: {
      id: true, createdAt: true, action: true, userId: true, orgId: true,
      targetType: true, targetId: true, ip: true, userAgent: true, metadata: true,
      chainSeq: true, prevHash: true, rowHash: true,
    },
  });

  let prevHash = genesisPrev(scope);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // Contiguity: seq must be exactly its index (no gaps from a deleted row).
    if (r.chainSeq !== i) {
      return { ok: false, count: rows.length, head: null, brokenAt: i, reason: 'sequence gap' };
    }
    if (r.prevHash !== prevHash) {
      return { ok: false, count: rows.length, head: null, brokenAt: i, reason: 'prevHash mismatch' };
    }
    const expect = hashRow(prevHash, canonical({ ...r, chainSeq: i }));
    if (r.rowHash !== expect) {
      return { ok: false, count: rows.length, head: null, brokenAt: i, reason: 'rowHash mismatch' };
    }
    prevHash = r.rowHash as string;
  }

  const head: ChainHead | null = rows.length
    ? { seq: rows.length - 1, hash: prevHash }
    : null;
  return { ok: true, count: rows.length, head, brokenAt: null };
}

function signAnchor(scope: string, seq: number, rowHash: string): string {
  return createHmac('sha256', anchorSecret())
    .update(`${scope}:${seq}:${rowHash}`)
    .digest('hex');
}

/** Sign + store a checkpoint over the scope's current head. Null if empty. */
export async function anchorScope(scope: string): Promise<{ seq: number; rowHash: string; createdAt: Date } | null> {
  const headRow = await prisma.auditLog.findFirst({
    where: { ...scopeWhere(scope), chainSeq: { not: null } },
    orderBy: { chainSeq: 'desc' },
    select: { chainSeq: true, rowHash: true },
  });
  if (!headRow || headRow.chainSeq == null || !headRow.rowHash) return null;

  const seq = headRow.chainSeq;
  const rowHash = headRow.rowHash;
  const anchor = await prisma.auditAnchor.create({
    data: { scope, seq, rowHash, signature: signAnchor(scope, seq, rowHash) },
  });
  return { seq: anchor.seq, rowHash: anchor.rowHash, createdAt: anchor.createdAt };
}

export interface AnchorVerifyResult {
  ok: boolean;
  total: number;
  badAnchorIds: string[];
}

/**
 * Verify every anchor for a scope: the HMAC must validate, AND the anchored
 * (seq, rowHash) must still match the live sealed chain at that seq. A history
 * rewrite that re-seals the chain would change the rowHash at an anchored seq,
 * so the anchor would no longer match — detected here.
 */
export async function verifyAnchors(scope: string): Promise<AnchorVerifyResult> {
  const anchors = await prisma.auditAnchor.findMany({ where: { scope } });
  const bad: string[] = [];

  for (const a of anchors) {
    const expectSig = signAnchor(a.scope, a.seq, a.rowHash);
    const sigOk =
      a.signature.length === expectSig.length &&
      timingSafeEqual(Buffer.from(a.signature), Buffer.from(expectSig));
    if (!sigOk) { bad.push(a.id); continue; }

    const row = await prisma.auditLog.findFirst({
      where: { ...scopeWhere(scope), chainSeq: a.seq },
      select: { rowHash: true },
    });
    if (!row || row.rowHash !== a.rowHash) bad.push(a.id);
  }

  return { ok: bad.length === 0, total: anchors.length, badAnchorIds: bad };
}

/** Most recent anchor for a scope, for display. */
export async function latestAnchor(scope: string) {
  return prisma.auditAnchor.findFirst({
    where: { scope },
    orderBy: { createdAt: 'desc' },
    select: { seq: true, rowHash: true, createdAt: true },
  });
}

/** Every distinct chain scope that currently has audit rows. */
export async function listScopes(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    distinct: ['orgId'],
    select: { orgId: true },
  });
  // Map null orgId -> the global scope sentinel.
  return rows.map((r) => scopeFor(r.orgId));
}

/**
 * Seal + anchor every scope. Intended for a scheduled job (see
 * /api/internal/cron/seal-audit). Returns a per-scope summary.
 */
export async function sealAndAnchorAllScopes(): Promise<{
  scopes: number;
  sealed: number;
  results: { scope: string; sealed: number; head: number | null; anchored: number | null }[];
}> {
  const scopes = await listScopes();
  const results = [];
  let totalSealed = 0;
  for (const scope of scopes) {
    const { head, sealed } = await sealScope(scope);
    const anchor = await anchorScope(scope);
    totalSealed += sealed;
    results.push({ scope, sealed, head: head?.seq ?? null, anchored: anchor?.seq ?? null });
  }
  return { scopes: scopes.length, sealed: totalSealed, results };
}
