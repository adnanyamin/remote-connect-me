import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Head from 'next/head';

export default function Signup() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Signup failed');
      // If returnTo is set (e.g. from Electron pairing), pass it through verify-email.
      const returnTo = router.query.returnTo as string | undefined;
      const dest = returnTo
        ? `/verify-email?pending=1&returnTo=${encodeURIComponent(returnTo)}`
        : '/dashboard';
      router.push(dest);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Head><title>Sign up · RemoteConnectMe</title></Head>
      <div className="min-h-screen grid place-items-center px-6">
        <form onSubmit={submit} className="card w-full max-w-md space-y-4">
          <h1 className="text-2xl font-semibold">Create your account</h1>
          <input className="input" type="email" placeholder="you@example.com" required value={email} onChange={e => setEmail(e.target.value)} />
          <input className="input" type="password" placeholder="Password (8+ chars)" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} />
          {err && <div className="text-red-300 text-sm">{err}</div>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Creating…' : 'Sign up'}</button>
          <div className="text-sm text-white/60 text-center">
            Already have an account? <Link href="/login">Sign in</Link>
          </div>
        </form>
      </div>
    </>
  );
}
