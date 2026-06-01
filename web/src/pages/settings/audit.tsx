import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

type Role = 'owner' | 'admin' | 'technician' | 'viewer';
type Me = { id: string; email: string; activeOrg: { id: string; name: string; role: Role } };
type Row = {
  id: string;
  action: string;
  userId: string | null;
  userEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: string | null;
  createdAt: string;
};

const ACTION_GROUPS: { label: string; actions: string[] }[] = [
  { label: 'Auth',     actions: ['auth.signup', 'auth.login.success', 'auth.login.fail', 'auth.logout', 'auth.email_verified', 'auth.email_verify_sent'] },
  { label: 'MFA',      actions: ['auth.mfa.required', 'auth.mfa.success', 'auth.mfa.fail', 'auth.mfa.recovery_used', 'mfa.enroll.start', 'mfa.enroll.complete', 'mfa.disable'] },
  { label: 'Org',      actions: ['org.create', 'org.switch', 'org.invitation.create', 'org.invitation.revoke', 'org.invitation.accept', 'org.member.role_change', 'org.member.remove', 'org.member.leave'] },
  { label: 'Device',   actions: ['device.create', 'device.pair', 'device.pair.fail', 'device.delete', 'device.connect_token'] },
  { label: 'TURN',     actions: ['turn.credentials_issued'] },
];

/**
 * /settings/audit — admin+ audit log viewer.
 *
 * Filter bar drives a cursor-paginated query against /api/orgs/<id>/audit.
 * "Load more" pulls the next page using the response's nextBefore cursor.
 * Click any row to expand its metadata JSON.
 */
export default function AuditLogPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [filterAction, setFilterAction] = useState<string>('');
  const [filterUserId, setFilterUserId] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Integrity check state.
  const [verifying, setVerifying] = useState(false);
  const [integrity, setIntegrity] = useState<
    | { ok: boolean; chain: { count: number; head: { seq: number } | null; brokenAt: number | null; reason: string | null }; anchors: { ok: boolean; total: number }; lastAnchor: { seq: number; createdAt: string } | null }
    | null
  >(null);

  async function verifyIntegrity() {
    if (!me) return;
    setVerifying(true); setErr(null); setIntegrity(null);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/audit/verify`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setIntegrity(data);
      // Re-pull the list — verify seals pending rows, which can add chainSeq.
      loadFirstPage();
    } catch (e: any) { setErr(e.message); }
    finally { setVerifying(false); }
  }

  const loadFirstPage = useCallback(async () => {
    if (!me) return;
    setLoading(true); setErr(null);
    const params = new URLSearchParams();
    if (filterAction) params.set('action', filterAction);
    if (filterUserId) params.set('userId', filterUserId);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/audit?${params}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setRows(data.rows);
      setNextBefore(data.nextBefore);
      setHasMore(!!data.nextBefore);
    } catch (e: any) {
      setErr(e.message);
    } finally { setLoading(false); }
  }, [me, filterAction, filterUserId]);

  async function loadMore() {
    if (!me || !nextBefore) return;
    setBusy(true); setErr(null);
    const params = new URLSearchParams({ before: nextBefore });
    if (filterAction) params.set('action', filterAction);
    if (filterUserId) params.set('userId', filterUserId);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/audit?${params}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setRows((prev) => [...prev, ...data.rows]);
      setNextBefore(data.nextBefore);
      setHasMore(!!data.nextBefore);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  // Bootstrap: load `me`, then load first page.
  useEffect(() => {
    (async () => {
      const r = await fetch('/api/auth/me');
      if (!r.ok) { router.replace('/login'); return; }
      const data = await r.json();
      // Hard role gate at the page level too — the API will 403 viewers/techs,
      // but no point letting them see an empty filter bar either.
      const ROLE_RANK: Record<Role, number> = { viewer: 1, technician: 2, admin: 3, owner: 4 };
      if (ROLE_RANK[data.activeOrg.role as Role] < ROLE_RANK.admin) {
        router.replace('/dashboard'); return;
      }
      setMe(data);
    })();
  }, []); // eslint-disable-line

  useEffect(() => { if (me) loadFirstPage(); }, [me, loadFirstPage]);

  if (!me) return null;

  return (
    <>
      <Head><title>Audit log · Remotely</title></Head>
      <div className="min-h-screen">
        <header className="px-6 py-4 flex items-center justify-between max-w-6xl mx-auto w-full">
          <div className="font-semibold text-lg">Remotely</div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/dashboard" className="btn-ghost">Dashboard</Link>
            <Link href="/settings" className="btn-ghost">Settings</Link>
            <span className="text-white/60">{me.email}</span>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Audit log</h1>
              <p className="text-sm text-white/60 mt-1">{me.activeOrg.name}</p>
            </div>
            <button className="btn-ghost shrink-0" disabled={verifying} onClick={verifyIntegrity}>
              {verifying ? 'Verifying…' : 'Verify integrity'}
            </button>
          </div>

          {integrity && (
            <div className={`card text-sm ${integrity.ok ? 'border-emerald-400/40' : 'border-red-400/60'}`}>
              {integrity.ok ? (
                <span className="text-emerald-300">
                  ✓ Chain intact — {integrity.chain.count} sealed entries
                  {integrity.chain.head ? ` (head #${integrity.chain.head.seq})` : ''}.
                  {integrity.lastAnchor
                    ? ` Last anchor #${integrity.lastAnchor.seq} at ${new Date(integrity.lastAnchor.createdAt).toLocaleString()}.`
                    : ' No signed anchor yet — use Seal to create one.'}
                </span>
              ) : (
                <span className="text-red-300">
                  ⚠ Integrity check FAILED.
                  {integrity.chain.brokenAt != null
                    ? ` Chain breaks at entry #${integrity.chain.brokenAt} (${integrity.chain.reason}).`
                    : ''}
                  {!integrity.anchors.ok ? ` ${integrity.anchors.total} anchor(s) include a signature/head mismatch.` : ''}
                  {' '}This indicates the audit log was altered after the fact.
                </span>
              )}
            </div>
          )}

          <section className="card flex flex-wrap gap-3 items-center">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-white/60">Action</span>
              <select
                className="bg-white/10 rounded px-2 py-1"
                value={filterAction}
                onChange={(e) => setFilterAction(e.target.value)}
              >
                <option value="">All actions</option>
                {ACTION_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.actions.map((a) => (<option key={a} value={a}>{a}</option>))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-white/60">User ID</span>
              <input
                className="input text-sm py-1 w-64"
                placeholder="cuid or empty for all"
                value={filterUserId}
                onChange={(e) => setFilterUserId(e.target.value)}
              />
            </label>
            {(filterAction || filterUserId) && (
              <button
                className="btn-ghost text-sm"
                onClick={() => { setFilterAction(''); setFilterUserId(''); }}
              >
                Clear
              </button>
            )}
          </section>

          {err && <div className="text-red-300 text-sm">{err}</div>}

          {loading ? (
            <div className="text-white/60 text-sm">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="card text-center text-white/60 text-sm">
              No audit rows match the current filter.
            </div>
          ) : (
            <ul className="space-y-1">
              {rows.map((r) => {
                const open = expanded === r.id;
                return (
                  <li key={r.id} className="card !py-2 cursor-pointer"
                      onClick={() => setExpanded(open ? null : r.id)}>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-white/40 font-mono w-44 shrink-0">
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                      <span className="font-mono text-emerald-300 w-56 shrink-0 truncate">
                        {r.action}
                      </span>
                      <span className="text-white/70 truncate">
                        {r.userEmail || (r.userId ? 'unknown@' : 'system')}
                      </span>
                      {r.ip && <span className="text-white/40 text-xs ml-auto">{r.ip}</span>}
                    </div>
                    {open && (
                      <div className="mt-3 pl-44 text-xs text-white/70 space-y-1 font-mono">
                        {r.targetType && (
                          <div>target: <span className="text-white/90">{r.targetType}/{r.targetId}</span></div>
                        )}
                        {r.userAgent && <div>ua: <span className="text-white/60">{r.userAgent}</span></div>}
                        {r.metadata && (
                          <pre className="whitespace-pre-wrap break-words bg-black/30 p-2 rounded text-[11px]">
                            {(() => { try { return JSON.stringify(JSON.parse(r.metadata), null, 2); } catch { return r.metadata; } })()}
                          </pre>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {hasMore && (
            <div className="text-center">
              <button className="btn-ghost" disabled={busy} onClick={loadMore}>
                {busy ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
