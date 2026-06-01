import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Head from 'next/head';

type Stage = 'creds' | 'mfa';

export default function Login() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('creds');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCreds(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Login failed');
      if (data.mfa_required) {
        setMfaToken(data.mfaToken);
        setStage('mfa');
      } else {
        router.push('/dashboard');
      }
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mfaToken, code }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Code rejected');
      router.push('/dashboard');
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Head><title>Sign in · RemoteConnectMe</title></Head>
      <div className="min-h-screen grid place-items-center px-6">
        {stage === 'creds' ? (
          <form onSubmit={submitCreds} className="card w-full max-w-md space-y-4">
            <h1 className="text-2xl font-semibold">Sign in</h1>
            <input className="input" type="email" placeholder="you@example.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className="input" type="password" placeholder="Password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            {err && <div className="text-red-300 text-sm">{err}</div>}
            <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            <div className="text-sm text-white/60 text-center">
              New here? <Link href="/signup">Create an account</Link>
            </div>
          </form>
        ) : (
          <form onSubmit={submitMfa} className="card w-full max-w-md space-y-4">
            <h1 className="text-2xl font-semibold">Two-factor code</h1>
            <p className="text-sm text-white/70">
              Enter the 6-digit code from your authenticator app, or one of your recovery codes.
            </p>
            <input
              className="input tracking-[0.3em] text-center text-lg"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123 456"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {err && <div className="text-red-300 text-sm">{err}</div>}
            <button className="btn-primary w-full" disabled={busy || code.length < 6}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              className="text-sm text-white/60 hover:text-white"
              onClick={() => { setStage('creds'); setCode(''); setMfaToken(null); }}
            >
              ← Back to password
            </button>
          </form>
        )}
      </div>
    </>
  );
}
