import type { NextApiRequest } from 'next';

/**
 * Rate limiter with two-tier protection:
 *
 *  1. Rolling counter — `max` hits per `windowSeconds` window.
 *  2. Extended lockout — once the rolling counter is exceeded, that key is
 *     placed into a long lockout (default: 6 hours). All subsequent attempts
 *     during the lockout return `ok: false` with the remaining cooldown in
 *     `retryAfterSeconds`. The counter only resumes after the lockout expires.
 *
 * This means a single burst of abuse trips a long timeout, not just the
 * original short window — much harder to brute-force.
 *
 * Two backends:
 *   - In-memory (dev / single-process). Not safe across serverless instances.
 *   - Upstash Redis REST. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const DEFAULT_LOCKOUT_SECONDS = 6 * 60 * 60; // 6 hours

const memBuckets = new Map<string, { count: number; resetAt: number }>();
const memLocks = new Map<string, { until: number }>();

export interface LimitOptions {
  key: string;
  max: number;
  windowSeconds: number;
  /**
   * How long to lock out subsequent attempts after the rolling counter trips.
   * Default 6 hours. Set to a value <= windowSeconds to effectively disable
   * the extended lockout and fall back to plain windowed rate limiting.
   */
  extendedLockoutSeconds?: number;
}

export interface LimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
  locked: boolean;
}

export async function limit(opts: LimitOptions): Promise<LimitResult> {
  const lockoutS = opts.extendedLockoutSeconds ?? DEFAULT_LOCKOUT_SECONDS;
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    return upstashLimit(opts.key, opts.max, opts.windowSeconds, lockoutS);
  }
  return memLimit(opts.key, opts.max, opts.windowSeconds, lockoutS);
}

function memLimit(
  key: string,
  max: number,
  windowSeconds: number,
  lockoutSeconds: number,
): LimitResult {
  const now = Date.now();

  // 1) Honor an active lockout first.
  const lock = memLocks.get(key);
  if (lock) {
    if (lock.until > now) {
      return {
        ok: false, remaining: 0, locked: true,
        retryAfterSeconds: Math.ceil((lock.until - now) / 1000),
      };
    }
    memLocks.delete(key);
    memBuckets.delete(key); // fresh counter after lockout expires
  }

  // 2) Rolling counter.
  const windowMs = windowSeconds * 1000;
  const existing = memBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    memBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1, retryAfterSeconds: 0, locked: false };
  }
  existing.count += 1;
  if (existing.count > max) {
    // 3) Trip the extended lockout.
    memLocks.set(key, { until: now + lockoutSeconds * 1000 });
    return { ok: false, remaining: 0, locked: true, retryAfterSeconds: lockoutSeconds };
  }
  return {
    ok: true, locked: false,
    remaining: max - existing.count,
    retryAfterSeconds: 0,
  };
}

async function upstashLimit(
  key: string,
  max: number,
  windowSeconds: number,
  lockoutSeconds: number,
): Promise<LimitResult> {
  const headers = { Authorization: `Bearer ${UPSTASH_TOKEN!}` };
  const lockKey = `lock:${key}`;

  // 1) Honor an active lockout first.
  const lockR = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(lockKey)}`, { headers });
  const { result: lockVal } = (await lockR.json()) as { result: string | null };
  if (lockVal) {
    const ttlR = await fetch(`${UPSTASH_URL}/ttl/${encodeURIComponent(lockKey)}`, { headers });
    const { result: ttl } = (await ttlR.json()) as { result: number };
    return {
      ok: false, remaining: 0, locked: true,
      retryAfterSeconds: ttl > 0 ? ttl : lockoutSeconds,
    };
  }

  // 2) Rolling counter — INCR + EXPIRE-on-first-hit.
  const incrR = await fetch(`${UPSTASH_URL}/incr/${encodeURIComponent(key)}`, { headers });
  const { result: count } = (await incrR.json()) as { result: number };
  if (count === 1) {
    await fetch(`${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${windowSeconds}`, { headers });
  }

  if (count > max) {
    // 3) Trip the extended lockout, and delete the counter so it restarts
    // fresh after the lockout expires.
    await fetch(
      `${UPSTASH_URL}/setex/${encodeURIComponent(lockKey)}/${lockoutSeconds}/1`,
      { headers },
    );
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, { headers });
    return {
      ok: false, remaining: 0, locked: true,
      retryAfterSeconds: lockoutSeconds,
    };
  }

  return {
    ok: true, locked: false,
    remaining: Math.max(0, max - count),
    retryAfterSeconds: 0,
  };
}

/** Pulls the client IP from the request, respecting X-Forwarded-For. */
export function clientIp(req: NextApiRequest): string {
  const xff = (req.headers['x-forwarded-for'] || '') as string;
  if (xff) return xff.split(',')[0].trim();
  return (req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/**
 * Common bucket presets. `max` / `windowSeconds` define the rolling counter;
 * crossing it trips a 6-hour `extendedLockoutSeconds` block. Tune per bucket
 * if 6 hours is too aggressive for your traffic.
 */
export const BUCKETS = {
  authLogin:    { max: 10, windowSeconds: 60,         extendedLockoutSeconds: 6 * 60 * 60 },
  authSignup:   { max: 5,  windowSeconds: 60 * 60,    extendedLockoutSeconds: 6 * 60 * 60 },
  pair:         { max: 20, windowSeconds: 60 * 10,    extendedLockoutSeconds: 6 * 60 * 60 },
  verifyEmail:  { max: 5,  windowSeconds: 60 * 60,    extendedLockoutSeconds: 6 * 60 * 60 },
  turn:         { max: 30, windowSeconds: 60,         extendedLockoutSeconds: 6 * 60 * 60 },
} as const;
