import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';

type Me = { id: string; email: string; emailVerified: boolean; mfaEnabled: boolean };

export default function Settings() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  // Enrollment flow state
  const [enrollStarted, setEnrollStarted] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Disable flow state
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch('/api/auth/me');
    if (!r.ok) { router.replace('/login'); return; }
    setMe(await r.json());
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  async function startEnroll() {
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/mfa/enroll', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setSecret(data.secret);
      setOtpauthUrl(data.otpauthUrl);
      setEnrollStarted(true);
      // Render QR lazily via the `qrcode` package (browser build).
      try {
        const QR = await import('qrcode');
        const svg = await QR.toString(data.otpauthUrl, { type: 'svg', margin: 1, width: 220 });
        setQrSvg(svg);
      } catch {
        // qrcode dep not installed — user can paste the otpauth:// URL manually
        // or type the secret into their authenticator.
      }
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/mfa/verify-enrollment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: enrollCode }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setRecoveryCodes(data.recoveryCodes);
      setEnrollStarted(false);
      setSecret(null); setOtpauthUrl(null); setQrSvg(null); setEnrollCode('');
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/mfa/disable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: disablePassword, code: disableCode || undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setShowDisable(false); setDisablePassword(''); setDisableCode('');
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  function downloadRecoveryCodes() {
    if (!recoveryCodes) return;
    const blob = new Blob(
      [`Remotely recovery codes for ${me?.email}\n\nEach code can be used exactly once.\nKeep these somewhere safe — anyone with one of these codes can sign in as you.\n\n${recoveryCodes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'remotely-recovery-codes.txt'; a.click();
    URL.revokeObjectURL(url);
  }

  if (!me) return null;

  return (
    <>
      <Head><title>Settings · Remotely</title></Head>
      <div className="min-h-screen">
        <header className="px-6 py-4 flex items-center justify-between max-w-6xl mx-auto w-full">
          <div className="font-semibold text-lg">Remotely</div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/dashboard" className="btn-ghost">Dashboard</Link>
            <span className="text-white/60">{me.email}</span>
          </div>
        </header>

        <main className="max-w-2xl mx-auto px-6 py-8 space-y-8">
          <h1 className="text-2xl font-semibold">Settings</h1>

          <section className="card flex items-center justify-between">
            <div>
              <h2 className="font-medium">Team members</h2>
              <p className="text-sm text-white/60 mt-1">Invite teammates and manage their roles.</p>
            </div>
            <Link href="/settings/members" className="btn-ghost shrink-0">Manage →</Link>
          </section>

          <section className="card flex items-center justify-between">
            <div>
              <h2 className="font-medium">Audit log</h2>
              <p className="text-sm text-white/60 mt-1">Every authentication, device, and member event in this org.</p>
            </div>
            <Link href="/settings/audit" className="btn-ghost shrink-0">View →</Link>
          </section>

          <section className="card flex items-center justify-between">
            <div>
              <h2 className="font-medium">Session recordings</h2>
              <p className="text-sm text-white/60 mt-1">Encrypted recordings of remote-control sessions.</p>
            </div>
            <Link href="/settings/recordings" className="btn-ghost shrink-0">View →</Link>
          </section>

          <section className="card space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-medium">Two-factor authentication (TOTP)</h2>
                <p className="text-sm text-white/60 mt-1">
                  {me.mfaEnabled
                    ? 'Enabled. You\'ll be asked for a 6-digit code each time you sign in.'
                    : 'Disabled. Add an extra layer of security by requiring a code from your authenticator app at sign-in.'}
                </p>
              </div>
              {!me.mfaEnabled && !enrollStarted && (
                <button className="btn-primary shrink-0" onClick={startEnroll} disabled={busy}>
                  {busy ? 'Starting…' : 'Enable 2FA'}
                </button>
              )}
              {me.mfaEnabled && !showDisable && (
                <button className="btn-ghost shrink-0" onClick={() => setShowDisable(true)}>
                  Disable
                </button>
              )}
            </div>

            {enrollStarted && (
              <form onSubmit={confirmEnroll} className="space-y-3 border-t border-white/10 pt-4">
                <p className="text-sm text-white/70">
                  Scan this QR code with Google Authenticator, 1Password, Authy, or any TOTP app.
                  Then enter the 6-digit code it shows.
                </p>
                {qrSvg ? (
                  <div className="bg-white rounded p-3 inline-block" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                ) : (
                  <div className="text-xs text-white/60 break-all">
                    <p className="mb-2">QR rendering unavailable. Add this URL manually:</p>
                    <code className="block p-2 bg-white/5 rounded">{otpauthUrl}</code>
                  </div>
                )}
                {secret && (
                  <div className="text-xs text-white/50">
                    Manual key: <code className="font-mono">{secret}</code>
                  </div>
                )}
                <input
                  className="input tracking-[0.3em] text-center"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123 456"
                  required
                  value={enrollCode}
                  onChange={(e) => setEnrollCode(e.target.value)}
                />
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={busy || enrollCode.length < 6}>
                    {busy ? 'Verifying…' : 'Confirm'}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => { setEnrollStarted(false); setEnrollCode(''); setErr(null); }}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {showDisable && (
              <form onSubmit={disable} className="space-y-3 border-t border-white/10 pt-4">
                <p className="text-sm text-white/70">
                  Confirm with your password{me.mfaEnabled && ' and a current code'}.
                </p>
                <input className="input" type="password" placeholder="Current password" required
                  value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
                <input className="input tracking-[0.3em] text-center" placeholder="123 456"
                  inputMode="numeric" autoComplete="one-time-code"
                  value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={busy}>
                    {busy ? 'Disabling…' : 'Disable 2FA'}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => { setShowDisable(false); setDisablePassword(''); setDisableCode(''); setErr(null); }}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {err && <div className="text-red-300 text-sm">{err}</div>}
          </section>

          {recoveryCodes && (
            <section className="card space-y-3 border-amber-400/40">
              <h3 className="font-medium">Save your recovery codes</h3>
              <p className="text-sm text-white/70">
                Each code can be used once to sign in if you lose your authenticator. We won't show
                these again — save them somewhere safe.
              </p>
              <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-black/30 p-3 rounded">
                {recoveryCodes.map((c) => <span key={c}>{c}</span>)}
              </div>
              <div className="flex gap-2">
                <button className="btn-primary" onClick={downloadRecoveryCodes}>Download as .txt</button>
                <button className="btn-ghost" onClick={() => setRecoveryCodes(null)}>I've saved them</button>
              </div>
            </section>
          )}
        </main>
      </div>
    </>
  );
}
