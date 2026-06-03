import { useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Something went wrong');
      setSent(true);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Head><title>Forgot password · RemoteConnectMe</title></Head>
      <div className="min-h-screen grid place-items-center px-6">
        {sent ? (
          <div className="card w-full max-w-md space-y-4 text-center">
            <h1 className="text-2xl font-semibold">Check your email</h1>
            <p className="text-white/70">
              If an account exists for <strong>{email}</strong>, we sent a password reset link. Check your inbox.
            </p>
            <Link href="/login" className="text-sm text-white/60 hover:text-white">
              ← Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="card w-full max-w-md space-y-4">
            <h1 className="text-2xl font-semibold">Forgot password</h1>
            <p className="text-sm text-white/70">Enter your email and we'll send you a reset link.</p>
            <input
              className="input"
              type="email"
              placeholder="you@example.com"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {err && <div className="text-red-300 text-sm">{err}</div>}
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
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
