import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

type State = 'pending' | 'ok' | 'error';

export default function VerifyEmail() {
  const router = useRouter();
  const [state, setState] = useState<State>('pending');
  const [message, setMessage] = useState('Verifying your email…');

  useEffect(() => {
    if (!router.isReady) return;
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
          setMessage('Your email is verified. You can close this tab or return to the dashboard.');
        } else {
          setState('error');
          setMessage(j.error || 'Verification failed.');
        }
      })
      .catch((e) => {
        setState('error');
        setMessage(e.message || 'Network error.');
      });
  }, [router.isReady, router.query.token]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow text-center">
        <h1 className="text-xl font-semibold mb-3">
          {state === 'pending' && 'Verifying…'}
          {state === 'ok' && "You're verified"}
          {state === 'error' && 'Something went wrong'}
        </h1>
        <p className="text-gray-700">{message}</p>
        {state === 'ok' && (
          <a
            href="/dashboard"
            className="inline-block mt-4 text-blue-600 hover:underline"
          >
            Go to dashboard →
          </a>
        )}
      </div>
    </div>
  );
}
