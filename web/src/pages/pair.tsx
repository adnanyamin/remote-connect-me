import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

/**
 * Browser-based device pairing page.
 *
 * The Electron client opens this URL:
 *   /pair?callback=http://127.0.0.1:{port}&name={hostname}&platform={platform}
 *
 * 1. User must be logged in (we redirect to /login otherwise).
 * 2. User can customise the device name (pre-filled with the machine hostname).
 * 3. On confirm we POST /api/client/browser-pair which creates the device +
 *    deviceKey, then redirects to the callback URL with the credentials.
 */
export default function PairPage() {
  const router = useRouter();
  const { callback, name: rawName, platform } = router.query as Record<string, string>;

  const [me, setMe] = useState<{ email: string } | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Pre-fill name once query params are ready
  useEffect(() => {
    if (rawName && !deviceName) setDeviceName(decodeURIComponent(rawName));
  }, [rawName]); // eslint-disable-line

  // Check login status
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => {
        if (!r.ok) {
          // Save the current URL and redirect to login
          const returnTo = encodeURIComponent(window.location.href);
          router.replace(`/login?returnTo=${returnTo}`);
          return;
        }
        return r.json();
      })
      .then((data) => {
        if (data) setMe({ email: data.email });
      })
      .finally(() => setLoadingMe(false));
  }, []); // eslint-disable-line

  async function handlePair(e: React.FormEvent) {
    e.preventDefault();
    if (!callback) { setErr('Missing callback URL — please re-open from the desktop app.'); return; }
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch('/api/client/browser-pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceName: deviceName.trim() || 'My PC',
          platform: platform || 'windows',
          callbackUrl: callback,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Pairing failed');
      // API returns { redirectUrl } — the client is listening on that URL
      setDone(true);
      window.location.href = data.redirectUrl;
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  if (loadingMe) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-white/50">Loading…</div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Pair device · RemoteConnectMe</title></Head>
      <div className="min-h-screen grid place-items-center px-6">
        {done ? (
          <div className="card w-full max-w-md text-center space-y-3">
            <div className="text-4xl">✓</div>
            <h1 className="text-2xl font-semibold">Device paired!</h1>
            <p className="text-white/60 text-sm">You can close this tab. The RemoteConnectMe app is ready.</p>
          </div>
        ) : (
          <form onSubmit={handlePair} className="card w-full max-w-md space-y-4">
            <h1 className="text-2xl font-semibold">Pair this PC</h1>
            <p className="text-sm text-white/70">
              Signed in as <strong>{me?.email}</strong>. Give this computer a name and click <b>Pair</b>.
            </p>
            <div>
              <label className="block text-sm text-white/60 mb-1">Device name</label>
              <input
                className="input"
                autoFocus
                required
                maxLength={120}
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. Office PC, Home Desktop"
              />
            </div>
            {err && <div className="text-red-300 text-sm">{err}</div>}
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'Pairing…' : 'Pair this device'}
            </button>
            <p className="text-xs text-white/40 text-center">
              This will link your PC to your RemoteConnectMe account.
            </p>
          </form>
        )}
      </div>
    </>
  );
}
