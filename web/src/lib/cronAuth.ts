import type { NextApiRequest } from 'next';

/**
 * Authorize a scheduled-task ("cron") request. Two accepted forms:
 *
 *   1. `Authorization: Bearer <CRON_SECRET>` — for any external scheduler, and
 *      what Vercel Cron sends automatically when CRON_SECRET is set as an env var.
 *   2. The `x-vercel-cron` header — present on Vercel Cron invocations even
 *      without a secret (only trust this when CRON_SECRET is unset, for
 *      zero-config Vercel setups).
 *
 * If neither CRON_SECRET is configured nor the Vercel header is present, the
 * request is refused — so a cron endpoint can never be left publicly callable
 * by accident.
 */
export function isAuthorizedCron(req: NextApiRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return presented === secret;
  }
  return !!req.headers['x-vercel-cron'];
}
