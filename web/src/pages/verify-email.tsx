import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

type State = 'pending' | 'waiting' | 'ok' | 'error';

export default function VerifyEmail() {
  const router = useRouter();
  const [state, setState] = useState<State>('pending');
  const [message, setMessage] = useState('Verifying your email…');
  const [resent, setResent] = useState(false);

  const isPending = router.isReady && router.query.pending === '1';

  useEffect(() => {
    if (!router.isReady) return;

    // Redirected here because email isn't verified yet — show "check your inbox" UI
    if (router.query.pending === '1') {
      setState('waiting');
      setMessage('Check your inbox for a verification link. You must verify your email before accessing the dashboard.');
      return;
    }

    const token = String(router.query.token || '');
    if (!token) {
      setState('error');
      setMessage('Missing token in URL.');
      return;
    }
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          setState('ok');
          setMessage('Your email is verified. You can now access the dashboard.');
        } else {
          setState('error');
          setMessage(j.error || 'Verification failed.');
        }
      })
      .catch((e) => {
        setState('error');
        setMessage(e.message || 'Network error.');
      });
  }, [router.isReady, router.query.token, router.query.pending]);

  async function resendVerification() {
    setResent(false);
    const r = await fetch('/api/auth/resend-verification', { method: 'POST' });
    if (r.ok) setResent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow text-center">
        <h1 className="text-xl font-semibold mb-3">
          {state === 'pending' && 'Verifying…'}
          {state === 'waiting' && 'Verify your email'}
          {state === 'ok' && "You're verified!"}
          {state === 'error' && 'Something went wrong'}
        </h1>
        <p className="text-gray-700">{message}</p>

        {state === 'waiting' && (
          <div className="mt-4 space-y-3">
            <button
              onClick={resendVerification}
              className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Resend verification email
            </button>
            {resent && <p className="text-green-600 text-sm">Sent! Check your inbox.</p>}
            <p className="text-sm text-gray-500">
              Wrong account?{' '}
              <a href="/login" className="text-blue-600 hover:underline">Sign in with a different email</a>
            </p>
          </div>
        )}

        {state === 'ok' && (
          <a href="/dashboard" className="inline-block mt-4 text-blue-600 hover:underline">
            Go to dashboard →
          </a>
        )}

        {state === 'error' && (
          <a href="/login" className="inline-block mt-4 text-blue-600 hover:underline">
            Back to login
          </a>
        )}
      </div>
    </div>
  );
}
