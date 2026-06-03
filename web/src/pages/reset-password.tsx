import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Head from 'next/head';

export default function ResetPassword() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (router.isReady) {
      setToken(String(router.query.token || ''));
    }
  }, [router.isReady, router.query.token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setErr('Passwords do not match.'); return; }
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Reset failed');
      setDone(true);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Head><title>Reset password · RemoteConnectMe</title></Head>
      <div className="min-h-screen grid place-items-center px-6">
        {done ? (
          <div className="card w-full max-w-md space-y-4 text-center">
            <h1 className="text-2xl font-semibold">Password updated</h1>
            <p className="text-white/70">Your password has been reset. You can now sign in.</p>
            <Link href="/login" className="btn-primary inline-block">Sign in →</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="card w-full max-w-md space-y-4">
            <h1 className="text-2xl font-semibold">Reset password</h1>
            <input
              className="input"
              type="password"
              placeholder="New password (min 8 characters)"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input
              className="input"
              type="password"
              placeholder="Confirm new password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {err && <div className="text-red-300 text-sm">{err}</div>}
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
            <div className="text-sm text-white/60 text-center">
              <Link href="/login" className="hover:text-white">← Back to sign in</Link>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
