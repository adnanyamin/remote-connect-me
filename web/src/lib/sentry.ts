/**
 * Optional Sentry init. We do not require @sentry/nextjs to be installed —
 * if the env var is unset or the package missing, this is a no-op so dev
 * builds without the dep still run.
 *
 * To enable in production:
 *   1. npm i --save @sentry/nextjs
 *   2. set NEXT_PUBLIC_SENTRY_DSN and SENTRY_DSN env vars
 *   3. (optional) wrap next.config.js with withSentryConfig for source-map
 *      uploads on build
 */

let initialized = false;

export function initSentryBrowser() {
  if (initialized) return;
  if (typeof window === 'undefined') return;
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/nextjs');
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0.5,
      environment: process.env.NODE_ENV,
    });
    initialized = true;
  } catch (e) {
    // package not installed — silently no-op.
  }
}
