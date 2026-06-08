import { useEffect, useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';

type Device = {
  id: string; name: string; platform: string;
  lastSeenAt: string | null; createdAt: string;
  requireApproval: boolean;
};

type ActiveOrg = {
  id: string; name: string; slug: string;
  personal: boolean;
  role: 'owner' | 'admin' | 'technician' | 'viewer';
};

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<{ email: string; activeOrg: ActiveOrg } | null>(null);
  const [orgs, setOrgs] = useState<ActiveOrg[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);

  async function load() {
    setLoading(true);
    const meR = await fetch('/api/auth/me');
    if (!meR.ok) { router.replace('/login'); return; }
    const meData = await meR.json();
    if (!meData.emailVerified) { router.replace('/verify-email?pending=1'); return; }
    setMe({ email: meData.email, activeOrg: meData.activeOrg });

    // Org list + device list in parallel; the switcher uses the org list.
    const [oR, dR] = await Promise.all([
      fetch('/api/orgs'),
      fetch('/api/devices'),
    ]);
    if (oR.ok) setOrgs((await oR.json()).orgs || []);
    const dData = await dR.json();
    setDevices(dData.devices || []);
    setLoading(false);
  }

  async function switchOrg(orgId: string) {
    if (!me || orgId === me.activeOrg.id) return;
    const r = await fetch('/api/orgs/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId }),
    });
    if (r.ok) {
      // Full reload — every subsequent request will scope to the new org's cookie.
      window.location.reload();
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  async function removeDevice(id: string) {
    if (!confirm('Remove this device? You will need to pair it again.')) return;
    await fetch(`/api/devices/${id}`, { method: 'DELETE' });
    load();
  }

  async function toggleApproval(id: string, next: boolean) {
    // Optimistic update — UI flips immediately, then we reconcile from the server.
    setDevices((prev) => prev.map((d) => d.id === id ? { ...d, requireApproval: next } : d));
    const r = await fetch(`/api/devices/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requireApproval: next }),
    });
    if (!r.ok) {
      // Roll back on failure.
      setDevices((prev) => prev.map((d) => d.id === id ? { ...d, requireApproval: !next } : d));
      const data = await r.json().catch(() => ({}));
      alert(data.error || 'Failed to update device');
    }
  }

  function isOnline(d: Device) {
    if (!d.lastSeenAt) return false;
    return Date.now() - new Date(d.lastSeenAt).getTime() < 60_000;
  }

  return (
    <>
      <Head><title>Dashboard · RemoteConnectMe</title></Head>
      <div className="min-h-screen">
        <header className="px-6 py-4 flex items-center justify-between max-w-6xl mx-auto w-full">
          <div className="flex items-baseline gap-3">
            <div className="font-semibold text-lg">RemoteConnectMe</div>
            {me?.activeOrg && orgs.length > 1 ? (
              <select
                className="text-sm bg-white/5 hover:bg-white/10 rounded px-2 py-1"
                value={me.activeOrg.id}
                onChange={(e) => switchOrg(e.target.value)}
                title="Switch org"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}{o.personal ? '' : ''}
                  </option>
                ))}
              </select>
            ) : me?.activeOrg ? (
              <span className="text-sm text-white/50">· {me.activeOrg.name}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-white/60">{me?.email}</span>
            <Link href="/settings" className="btn-ghost">Settings</Link>
            <button className="btn-ghost" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.replace('/'); }}>Sign out</button>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
          <section className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold">Devices</h1>
              {me?.activeOrg && (
                <p className="text-sm text-white/50 mt-1">
                  {me.activeOrg.name} · you are an {me.activeOrg.role}
                </p>
              )}
            </div>
            {me?.activeOrg && (me.activeOrg.role === 'owner' || me.activeOrg.role === 'admin') && (
              <button className="btn-primary" onClick={() => setShowAddDialog(true)}>+ Add device</button>
            )}
          </section>

          {loading ? <div className="text-white/60">Loading…</div> : devices.length === 0 ? (
            <div className="card text-center text-white/70">
              <p>No devices yet. Click <b>Add device</b> to pair your first computer.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {devices.map(d => {
                const online = isOnline(d);
                const role = me?.activeOrg?.role;
                const canConnect = role === 'owner' || role === 'admin' || role === 'technician';
                const canRemove  = role === 'owner' || role === 'admin';
                const canManage  = role === 'owner' || role === 'admin';
                return (
                  <li key={d.id} className="card flex items-center justify-between gap-4">
                    <div>
                      <div className="font-medium">{d.name}</div>
                      <div className="text-sm text-white/50 flex flex-wrap gap-2 items-center">
                        <span className={`inline-block w-2 h-2 rounded-full ${online ? 'bg-green-400' : 'bg-white/30'}`} />
                        {online ? 'Online' : d.lastSeenAt ? `Last seen ${new Date(d.lastSeenAt).toLocaleString()}` : 'Not yet paired'}
                        <span>·</span>
                        <span className="capitalize">{d.platform}</span>
                        <span>·</span>
                        {canManage ? (
                          <label className="inline-flex items-center gap-1 cursor-pointer select-none"
                                 title="When on, the host PC asks the local user before each session.">
                            <input
                              type="checkbox"
                              className="accent-emerald-400"
                              checked={d.requireApproval}
                              onChange={(e) => toggleApproval(d.id, e.target.checked)}
                            />
                            <span>Require approval</span>
                          </label>
                        ) : (
                          <span title="Whether the host prompts the local user before each session.">
                            {d.requireApproval ? 'Approval required' : 'Unattended'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {canConnect ? (
                        <Link href={`/connect/${d.id}`} className={online ? 'btn-primary' : 'btn-ghost pointer-events-none opacity-50'}>Connect</Link>
                      ) : (
                        <span className="btn-ghost pointer-events-none opacity-50" title="Viewers can't connect">Connect</span>
                      )}
                      {canRemove && (
                        <button onClick={() => removeDevice(d.id)} className="btn-ghost">Remove</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </main>

        {showAddDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center backdrop:bg-black/60 bg-black/60">
            <div className="rounded-xl bg-[#0b1020] border border-white/10 text-white p-6 w-[28rem] max-w-full space-y-4 shadow-2xl">
              <h2 className="text-xl font-semibold">Add device</h2>
              <p className="text-white/70 text-sm">
                Download and run the RemoteConnectMe client on the PC you want to add.
                It will open a browser window where you&apos;ll name the device and confirm pairing — no codes needed.
              </p>
              <a
                href="https://github.com/adnanyamin/remote-connect-me/releases/latest/download/RemoteConnectMe-Setup.exe"
                className="btn-primary w-full text-center block"
                download
              >
                ↓ Download RemoteConnectMe for Windows
              </a>
              <p className="text-xs text-white/40 text-center">
                After installing, click &quot;Sign in to pair this PC&quot; in the app.
              </p>
              <div className="flex justify-end">
                <button className="btn-ghost" onClick={() => setShowAddDialog(false)}>Close</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
