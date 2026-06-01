import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

type Role = 'owner' | 'admin' | 'technician' | 'viewer';

type Preview = {
  status: 'pending' | 'expired' | 'used';
  invitation: {
    email: string;
    role: Role;
    expiresAt: string;
    invitedBy: string | null;
    org: { id: string; name: string; slug: string };
  };
  session: { email: string; emailMatches: boolean } | null;
};

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner', admin: 'Admin', technician: 'Technician', viewer: 'Viewer',
};

/**
 * /invite/[token] — landing page invitees hit from the email link.
 *
 * Four states the UI handles:
 *   1. Preview loading / not found / expired / already used    → static message
 *   2. Signed out                                              → sign in / sign up CTAs
 *   3. Signed in with wrong email                              → "sign in as X@..." hint
 *   4. Signed in with matching email                           → Accept button
 */
export default function InvitePage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPreview() {
    if (!token) return;
    setErr(null);
    try {
      const r = await fetch(`/api/invitations/${encodeURIComponent(token)}`);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'Invitation not found');
      }
      setPreview(await r.json());
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { loadPreview(); }, [token]); // eslint-disable-line

  async function accept() {
    setErr(null); setBusy(true);
    try {
      const r = await fetch(`/api/invitations/${encodeURIComponent(token)}/accept`,
        { method: 'POST' });
      const data = await r.json();
      if (!r.ok) {
        if (data.expectedEmail) {
          throw new Error(`Sign in as ${data.expectedEmail} to accept this invitation.`);
        }
        throw new Error(data.error || 'Failed to accept');
      }
      // Active org cookie just got set by the server; the dashboard will land
      // the user in their new org.
      router.replace('/dashboard');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <>
      <Head><title>Invitation · Remotely</title></Head>
      <div className="min-h-screen grid place-items-center px-6">
        <div className="card w-full max-w-md space-y-4">
          <h1 className="text-2xl font-semibold">You're invited</h1>

          {!preview && !err && (
            <div className="text-white/60 text-sm">Loading invitation…</div>
          )}

          {err && !preview && (
            <div className="text-red-300 text-sm">{err}</div>
          )}

          {preview && (preview.status === 'expired' || preview.status === 'used') && (
            <div className="space-y-2">
              <div className="text-red-300 text-sm">
                {preview.status === 'expired'
                  ? 'This invitation has expired.'
                  : 'This invitation was already used.'}
              </div>
              <p className="text-sm text-white/60">
                Ask the admin who invited you to send a new one.
              </p>
            </div>
          )}

          {preview && preview.status === 'pending' && (
            <>
              <p className="text-sm text-white/70">
                {preview.invitation.invitedBy ? (
                  <><span className="font-medium">{preview.invitation.invitedBy}</span> invited </>
                ) : 'You\'ve been invited '}
                you to join <span className="font-medium">{preview.invitation.org.name}</span>{' '}
                as a <span className="font-medium">{ROLE_LABEL[preview.invitation.role]}</span>.
              </p>
              <p className="text-xs text-white/40">
                Invitation for <code className="font-mono">{preview.invitation.email}</code>
                {' '}· expires {new Date(preview.invitation.expiresAt).toLocaleDateString()}
              </p>

              {/* Signed out */}
              {!preview.session && (
                <div className="space-y-2 pt-2">
                  <p className="text-sm text-white/70">
                    Sign in or create an account with <code className="font-mono">{preview.invitation.email}</code> to accept.
                  </p>
                  <div className="flex gap-2">
                    <Link href={`/login?next=${encodeURIComponent(router.asPath)}`} className="btn-primary">Sign in</Link>
                    <Link href={`/signup?next=${encodeURIComponent(router.asPath)}`} className="btn-ghost">Create account</Link>
                  </div>
                </div>
              )}

              {/* Signed in but wrong email */}
              {preview.session && !preview.session.emailMatches && (
                <div className="space-y-2 pt-2">
                  <p className="text-sm text-amber-300">
                    You're signed in as <code className="font-mono">{preview.session.email}</code>,
                    but this invitation is for <code className="font-mono">{preview.invitation.email}</code>.
                  </p>
                  <p className="text-sm text-white/60">
                    Sign out and back in as the invited address, or ask the admin to re-invite your current address.
                  </p>
                  <button
                    className="btn-ghost"
                    onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); loadPreview(); }}>
                    Sign out
                  </button>
                </div>
              )}

              {/* Signed in and matching */}
              {preview.session && preview.session.emailMatches && (
                <div className="pt-2">
                  <button className="btn-primary w-full" onClick={accept} disabled={busy}>
                    {busy ? 'Accepting…' : 'Accept invitation'}
                  </button>
                </div>
              )}

              {err && <div className="text-red-300 text-sm">{err}</div>}
            </>
          )}
        </div>
      </div>
    </>
  );
}
