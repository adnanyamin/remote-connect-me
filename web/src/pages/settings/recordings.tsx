import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

type Role = 'owner' | 'admin' | 'technician' | 'viewer';
type Me = { id: string; email: string; activeOrg: { id: string; name: string; role: Role } };
type Recording = {
  id: string;
  deviceId: string;
  deviceName: string;
  viewerEmail: string | null;
  status: 'recording' | 'completed' | 'aborted';
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  bytes: number;
  chunkCount: number;
  expiresAt: string | null;
};

const ROLE_RANK: Record<Role, number> = { viewer: 1, technician: 2, admin: 3, owner: 4 };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtDuration(ms: number): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/**
 * /settings/recordings — admin+ list of session recordings, with download
 * links. The download endpoint streams the decrypted WebM.
 */
export default function RecordingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Recording[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    if (!me) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/recordings`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setRows(data.recordings);
      setNextBefore(data.nextBefore);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }, [me]);

  async function loadMore() {
    if (!me || !nextBefore) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/recordings?before=${encodeURIComponent(nextBefore)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setRows((prev) => [...prev, ...data.recordings]);
      setNextBefore(data.nextBefore);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    (async () => {
      const r = await fetch('/api/auth/me');
      if (!r.ok) { router.replace('/login'); return; }
      const data = await r.json();
      if (ROLE_RANK[data.activeOrg.role as Role] < ROLE_RANK.admin) {
        router.replace('/dashboard'); return;
      }
      setMe(data);
    })();
  }, []); // eslint-disable-line

  useEffect(() => { if (me) loadFirst(); }, [me, loadFirst]);

  if (!me) return null;

  return (
    <>
      <Head><title>Recordings · Remotely</title></Head>
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
          <div>
            <h1 className="text-2xl font-semibold">Session recordings</h1>
            <p className="text-sm text-white/60 mt-1">{me.activeOrg.name}</p>
          </div>

          {err && <div className="text-red-300 text-sm">{err}</div>}

          {loading ? (
            <div className="text-white/60 text-sm">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="card text-center text-white/60 text-sm">
              No recordings yet. Sessions are recorded when your org's recording policy is
              set to <b>optional</b> or <b>required</b>.
            </div>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="card flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.deviceName}</div>
                    <div className="text-xs text-white/50 flex flex-wrap gap-2">
                      <span>{new Date(r.startedAt).toLocaleString()}</span>
                      <span>·</span>
                      <span>{fmtDuration(r.durationMs)}</span>
                      <span>·</span>
                      <span>{fmtBytes(r.bytes)}</span>
                      {r.viewerEmail && (<><span>·</span><span>{r.viewerEmail}</span></>)}
                      {r.expiresAt && (<><span>·</span><span>expires {new Date(r.expiresAt).toLocaleDateString()}</span></>)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={
                      r.status === 'completed' ? 'text-emerald-300 text-xs'
                      : r.status === 'recording' ? 'text-amber-300 text-xs'
                      : 'text-white/40 text-xs'
                    }>
                      {r.status}
                    </span>
                    {r.status === 'completed' && r.bytes > 0 ? (
                      <a className="btn-primary text-sm" href={`/api/recordings/${r.id}/download`}>
                        Download
                      </a>
                    ) : (
                      <span className="btn-ghost text-sm pointer-events-none opacity-50">Download</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {nextBefore && (
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
