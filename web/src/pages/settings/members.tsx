import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

type Role = 'owner' | 'admin' | 'technician' | 'viewer';
type RecordingPolicy = 'off' | 'optional' | 'required';
type Me = {
  id: string; email: string;
  activeOrg: {
    id: string; name: string; role: Role;
    recordingPolicy: RecordingPolicy; recordingRetentionDays: number;
  };
};
type Member = { userId: string; email: string; role: Role; joinedAt: string };
type Invite = { id: string; email: string; role: Exclude<Role, 'owner'>; expiresAt: string; createdAt: string };

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner', admin: 'Admin', technician: 'Technician', viewer: 'Viewer',
};
const ROLE_RANK: Record<Role, number> = { viewer: 1, technician: 2, admin: 3, owner: 4 };

/**
 * /settings/members — members + pending invitations management.
 *
 * Visibility:
 *   - All members of the org see the list
 *   - Admin+ sees the invite form and per-row controls (role change, remove)
 *   - Only owner can change another admin's role or remove an admin
 */
export default function Members() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<Role, 'owner'>>('viewer');
  const [lastLink, setLastLink] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const meR = await fetch('/api/auth/me');
      if (!meR.ok) { router.replace('/login'); return; }
      const meData: Me = await meR.json();
      setMe(meData);

      const [mR, iR] = await Promise.all([
        fetch(`/api/orgs/${encodeURIComponent(meData.activeOrg.id)}/members`),
        ROLE_RANK[meData.activeOrg.role] >= ROLE_RANK.admin
          ? fetch(`/api/orgs/${encodeURIComponent(meData.activeOrg.id)}/invitations`)
          : Promise.resolve(null),
      ]);
      if (mR.ok) setMembers((await mR.json()).members || []);
      if (iR && iR.ok) setInvites((await iR.json()).invitations || []);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  const isAdminPlus = me && ROLE_RANK[me.activeOrg.role] >= ROLE_RANK.admin;
  const isOwner = me?.activeOrg.role === 'owner';

  async function updateRecordingPolicy(policy: RecordingPolicy) {
    if (!me) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordingPolicy: policy }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      // Reflect locally without a full reload.
      setMe((prev) => prev ? { ...prev, activeOrg: { ...prev.activeOrg, recordingPolicy: policy } } : prev);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!me) return;
    setErr(null); setBusy(true); setLastLink(null);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/invitations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setLastLink(data.link);
      setInviteEmail('');
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    if (!me) return;
    if (!confirm('Revoke this invitation?')) return;
    setBusy(true);
    try {
      await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/invitations/${id}`,
        { method: 'DELETE' });
      await load();
    } finally { setBusy(false); }
  }

  async function changeRole(userId: string, role: Role) {
    if (!me) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!r.ok) {
        const data = await r.json(); throw new Error(data.error);
      }
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function removeMember(userId: string, email: string) {
    if (!me) return;
    if (!confirm(`Remove ${email} from this org?`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/members/${userId}`,
        { method: 'DELETE' });
      if (!r.ok) {
        const data = await r.json(); throw new Error(data.error);
      }
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function transferOwnership(userId: string, email: string) {
    if (!me) return;
    if (!confirm(
      `Transfer ownership to ${email}? You will be demoted to admin and they will become the new owner.`
    )) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/orgs/${encodeURIComponent(me.activeOrg.id)}/transfer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toUserId: userId, demoteTo: 'admin' }),
      });
      if (!r.ok) {
        const data = await r.json(); throw new Error(data.error);
      }
      // Caller's role changed — reload everything (the role-gating in the UI
      // is now different).
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (loading || !me) return null;

  return (
    <>
      <Head><title>Members · RemoteConnectMe</title></Head>
      <div className="min-h-screen">
        <header className="px-6 py-4 flex items-center justify-between max-w-6xl mx-auto w-full">
          <div className="font-semibold text-lg">RemoteConnectMe</div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/dashboard" className="btn-ghost">Dashboard</Link>
            <Link href="/settings" className="btn-ghost">Settings</Link>
            <span className="text-white/60">{me.email}</span>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">
          <div>
            <h1 className="text-2xl font-semibold">Members</h1>
            <p className="text-sm text-white/60 mt-1">{me.activeOrg.name}</p>
          </div>

          {isAdminPlus && (
            <section className="card space-y-3">
              <h2 className="font-medium">Invite teammate</h2>
              <form onSubmit={sendInvite} className="flex flex-wrap gap-2 items-stretch">
                <input
                  className="input flex-1 min-w-[16rem]"
                  type="email"
                  placeholder="teammate@example.com"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
                <select
                  className="input w-40"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Exclude<Role, 'owner'>)}
                >
                  {(isOwner ? ['admin', 'technician', 'viewer'] : ['technician', 'viewer']).map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r as Role]}</option>
                  ))}
                </select>
                <button className="btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send invite'}</button>
              </form>
              {lastLink && (
                <div className="text-xs text-white/60 break-all">
                  Invite sent. Direct link (in case email is delayed):
                  {' '}<code className="font-mono text-white/80">{lastLink}</code>
                </div>
              )}
              {err && <div className="text-red-300 text-sm">{err}</div>}
            </section>
          )}

          {isOwner && (
            <section className="card space-y-3">
              <div>
                <h2 className="font-medium">Session recording</h2>
                <p className="text-sm text-white/60 mt-1">
                  Controls whether remote-control sessions are recorded. Recordings are
                  encrypted at rest and retained for {me.activeOrg.recordingRetentionDays} days.
                </p>
              </div>
              <div className="flex flex-col gap-2 text-sm">
                {([
                  ['off', 'Off', 'No sessions are recorded.'],
                  ['optional', 'Optional', 'Technicians can toggle recording per session.'],
                  ['required', 'Required', 'Every session is recorded automatically.'],
                ] as [RecordingPolicy, string, string][]).map(([val, label, desc]) => (
                  <label key={val} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="recordingPolicy"
                      className="mt-1 accent-emerald-400"
                      checked={me.activeOrg.recordingPolicy === val}
                      disabled={busy}
                      onChange={() => updateRecordingPolicy(val)}
                    />
                    <span>
                      <span className="font-medium">{label}</span>
                      <span className="text-white/50"> — {desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              {me.activeOrg.recordingPolicy !== 'off' && (
                <Link href="/settings/recordings" className="btn-ghost text-sm inline-block">
                  View recordings →
                </Link>
              )}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="font-medium">Current members</h2>
            <ul className="space-y-2">
              {members.map((m) => {
                // Self-row never gets edit/remove buttons; admins can't touch other admins/owners unless they're owner.
                const isSelf = m.userId === me.id;
                const targetRank = ROLE_RANK[m.role];
                const canEdit = isAdminPlus && !isSelf && m.role !== 'owner' &&
                  (targetRank < ROLE_RANK.admin || isOwner);
                const canRemove = canEdit; // identical rules
                // Transfer is owner-only and only makes sense for admins (you
                // hand the keys to someone already trusted to manage).
                const canTransfer = isOwner && !isSelf && m.role === 'admin';
                return (
                  <li key={m.userId} className="card flex items-center justify-between gap-4">
                    <div>
                      <div className="font-medium">
                        {m.email}{isSelf && <span className="text-xs text-white/40"> (you)</span>}
                      </div>
                      <div className="text-xs text-white/40">
                        Joined {new Date(m.joinedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {canEdit ? (
                        <select
                          className="bg-white/10 rounded px-2 py-1 text-sm"
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => changeRole(m.userId, e.target.value as Role)}
                        >
                          {(['admin', 'technician', 'viewer'] as Role[])
                            // Admin can't promote anyone to admin; owner can.
                            .filter((r) => r !== 'admin' || isOwner)
                            .map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      ) : (
                        <span className="text-sm text-white/60">{ROLE_LABEL[m.role]}</span>
                      )}
                      {canTransfer && (
                        <button className="btn-ghost text-sm" disabled={busy}
                          onClick={() => transferOwnership(m.userId, m.email)}
                          title="Hand ownership of this org to this admin">
                          Make owner
                        </button>
                      )}
                      {canRemove && (
                        <button className="btn-ghost text-sm" disabled={busy}
                          onClick={() => removeMember(m.userId, m.email)}>
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {isAdminPlus && invites.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-medium">Pending invitations</h2>
              <ul className="space-y-2">
                {invites.map((inv) => (
                  <li key={inv.id} className="card flex items-center justify-between gap-4">
                    <div>
                      <div className="font-medium">{inv.email}</div>
                      <div className="text-xs text-white/40">
                        {ROLE_LABEL[inv.role]} · expires {new Date(inv.expiresAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button className="btn-ghost text-sm" disabled={busy} onClick={() => revoke(inv.id)}>
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
      </div>
    </>
  );
}
