import { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';

type Device = {
  id: string; name: string; platform: string;
  lastSeenAt: string | null; online: boolean; createdAt: string;
};
type OrgInfo = { name: string; role: string; personal: boolean };
type UserRow = {
  id: string; email: string; verified: boolean; mfaEnabled: boolean;
  createdAt: string; deviceCount: number; onlineDevices: number;
  orgs: OrgInfo[]; devices: Device[];
};
type Stats = {
  totalUsers: number; verifiedUsers: number; unverifiedUsers: number;
  totalDevices: number; onlineDevices: number; last24h: number; last7d: number;
};

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="card text-center">
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-sm text-white/60 mt-1">{label}</div>
      {sub && <div className="text-xs text-white/40 mt-0.5">{sub}</div>}
    </div>
  );
}

function PlatformIcon({ p }: { p: string }) {
  if (p === 'darwin') return <>🍎</>;
  if (p === 'linux')  return <>🐧</>;
  return <>🪟</>;
}

export default function AdminPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'verified' | 'unverified' | 'has_devices'>('all');

  async function load() {
    setLoading(true); setError(null);
    const r = await fetch('/api/admin/overview');
    if (r.status === 403) { router.replace('/dashboard'); return; }
    if (!r.ok) { setError('Failed to load'); setLoading(false); return; }
    const data = await r.json();
    setStats(data.stats);
    setUsers(data.users);
    setLoading(false);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  const filtered = users.filter(u => {
    const q = search.toLowerCase();
    const matchSearch = !q || u.email.toLowerCase().includes(q) ||
      u.devices.some(d => d.name.toLowerCase().includes(q));
    const matchFilter =
      filter === 'all'         ? true :
      filter === 'verified'    ? u.verified :
      filter === 'unverified'  ? !u.verified :
      filter === 'has_devices' ? u.deviceCount > 0 : true;
    return matchSearch && matchFilter;
  });

  function fmt(d: string) {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtTime(d: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function age(d: string) {
    const ms = Date.now() - new Date(d).getTime();
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  }

  return (
    <>
      <Head><title>Admin · RemoteConnectMe</title></Head>
      <div className="min-h-screen">
        <header className="px-6 py-4 flex items-center justify-between max-w-6xl mx-auto border-b border-white/10">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-white/50 hover:text-white text-sm">← Dashboard</Link>
            <span className="text-white/20">/</span>
            <span className="font-semibold">Admin</span>
          </div>
          <button onClick={load} className="btn-ghost text-sm">↻ Refresh</button>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
          {loading && <div className="text-white/50">Loading…</div>}
          {error && <div className="text-red-300">{error}</div>}

          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <StatCard label="Total users"     value={stats.totalUsers} />
              <StatCard label="Verified"        value={stats.verifiedUsers} />
              <StatCard label="Unverified"      value={stats.unverifiedUsers} />
              <StatCard label="Total devices"   value={stats.totalDevices} />
              <StatCard label="Online now"      value={stats.onlineDevices} />
              <StatCard label="Signups today"   value={stats.last24h} sub="last 24 h" />
              <StatCard label="Signups this week" value={stats.last7d} sub="last 7 d" />
            </div>
          )}

          {!loading && (
            <>
              <div className="flex flex-wrap gap-3 items-center">
                <input
                  className="input flex-1 min-w-[200px] max-w-sm"
                  placeholder="Search by email or device name…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <div className="flex gap-2 text-sm">
                  {(['all', 'verified', 'unverified', 'has_devices'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={filter === f ? 'btn-primary py-1 px-3' : 'btn-ghost py-1 px-3'}
                    >
                      {f === 'has_devices' ? 'Has devices' : f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>
                <span className="text-white/40 text-sm">{filtered.length} users</span>
              </div>

              <div className="space-y-2">
                {filtered.map(u => (
                  <div key={u.id} className="card p-0 overflow-hidden">
                    {/* Row */}
                    <button
                      className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-3 hover:bg-white/5"
                      onClick={() => setExpanded(expanded === u.id ? null : u.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{u.email}</div>
                        <div className="text-xs text-white/40 mt-0.5">Joined {fmt(u.createdAt)} · {age(u.createdAt)}</div>
                      </div>

                      <div className="flex flex-wrap gap-2 items-center text-xs shrink-0">
                        {u.verified
                          ? <span className="px-2 py-0.5 rounded-full bg-green-900/50 text-green-300">Verified</span>
                          : <span className="px-2 py-0.5 rounded-full bg-yellow-900/50 text-yellow-300">Unverified</span>}
                        {u.mfaEnabled && <span className="px-2 py-0.5 rounded-full bg-blue-900/50 text-blue-300">MFA</span>}
                        <span className="text-white/50">
                          {u.deviceCount === 0 ? 'No devices' :
                           u.deviceCount === 1 ? '1 device' : `${u.deviceCount} devices`}
                          {u.onlineDevices > 0 && <span className="text-green-400 ml-1">({u.onlineDevices} online)</span>}
                        </span>
                        <span className="text-white/30">{expanded === u.id ? '▲' : '▼'}</span>
                      </div>
                    </button>

                    {/* Expanded detail */}
                    {expanded === u.id && (
                      <div className="border-t border-white/10 px-4 py-3 bg-white/3 space-y-3 text-sm">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs text-white/60">
                          <div><span className="text-white/40">User ID</span><br /><span className="font-mono">{u.id}</span></div>
                          <div><span className="text-white/40">Email verified</span><br />{u.verified ? '✓ Yes' : '✗ No'}</div>
                          <div><span className="text-white/40">MFA</span><br />{u.mfaEnabled ? '✓ Enabled' : 'Disabled'}</div>
                          {u.orgs.map(o => (
                            <div key={o.name}>
                              <span className="text-white/40">Org</span><br />
                              {o.name} <span className="text-white/30">({o.role})</span>
                            </div>
                          ))}
                        </div>

                        {u.devices.length === 0 ? (
                          <p className="text-white/40 text-xs">No devices paired yet.</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-white/40 text-left">
                                <th className="pb-1 pr-4">Device</th>
                                <th className="pb-1 pr-4">Platform</th>
                                <th className="pb-1 pr-4">Status</th>
                                <th className="pb-1 pr-4">Last seen</th>
                                <th className="pb-1">Added</th>
                              </tr>
                            </thead>
                            <tbody>
                              {u.devices.map(d => (
                                <tr key={d.id} className="border-t border-white/5">
                                  <td className="py-1.5 pr-4 font-medium">{d.name}</td>
                                  <td className="py-1.5 pr-4"><PlatformIcon p={d.platform} /> {d.platform}</td>
                                  <td className="py-1.5 pr-4">
                                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${d.online ? 'bg-green-400' : 'bg-white/20'}`} />
                                    {d.online ? 'Online' : 'Offline'}
                                  </td>
                                  <td className="py-1.5 pr-4 text-white/50">{fmtTime(d.lastSeenAt)}</td>
                                  <td className="py-1.5 text-white/50">{fmt(d.createdAt)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {filtered.length === 0 && (
                  <div className="card text-center text-white/50">No users match your search.</div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
