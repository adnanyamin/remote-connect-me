import { useEffect } from 'react';
import type { AppProps } from 'next/app';
import '@/styles/globals.css';
import { initSentryBrowser } from '@/lib/sentry';

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    initSentryBrowser();
    // Register the PWA service worker. No-op if the browser doesn't support it
    // or we're running on http://localhost (some browsers allow SW only on
    // localhost + https).
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);
  return <Component {...pageProps} />;
}
