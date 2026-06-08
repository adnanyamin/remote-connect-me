import type { NextApiRequest, NextApiResponse } from 'next';
import { purgeExpiredRecordings } from '@/lib/retention';
import { isAuthorizedCron } from '@/lib/cronAuth';

/**
 * GET|POST /api/internal/cron/purge-recordings
 *
 * Triggers the recording-retention sweep. Protected by isAuthorizedCron (shared
 * secret or Vercel Cron header) — NOT a user-facing endpoint. Vercel Cron sends
 * GET, so both verbs are accepted.
 *
 * Wire it up in web/vercel.json:
 *   { "crons": [{ "path": "/api/internal/cron/purge-recordings", "schedule": "0 3 * * *" }] }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'unauthorized' });

  const result = await purgeExpiredRecordings();
  return res.status(200).json({ ok: true, ...result });
}
