import { createHmac } from 'crypto';

/**
 * Short-lived TURN credentials per the coturn REST API spec
 * (https://github.com/coturn/coturn/blob/master/turndb/schema.userdb.redis).
 *
 * coturn must be configured with:
 *   use-auth-secret
 *   static-auth-secret=<TURN_SECRET>
 *
 * Credentials expire after TURN_CRED_TTL_S seconds. The username encodes the
 * expiry as `<unix_expiry>:<userId>`; the password is HMAC-SHA1(username)
 * base64-encoded with the shared secret. coturn verifies on its side.
 *
 * NEXT_PUBLIC_TURN_URIS is a comma-separated list of `turn:` / `turns:` URIs
 * (no credentials baked in — those come from this endpoint).
 */

const TURN_SECRET = process.env.TURN_SECRET;
const TURN_URIS = process.env.NEXT_PUBLIC_TURN_URIS || '';
const STUN_URIS = process.env.NEXT_PUBLIC_STUN_URIS || 'stun:stun.l.google.com:19302';
const TURN_CRED_TTL_S = 60 * 5;

export interface TurnCredentials {
  username: string;
  password: string;
  ttl: number;
  // Full ICE server list ready to drop into RTCPeerConnection({ iceServers }).
  iceServers: Array<
    | { urls: string }
    | { urls: string; username: string; credential: string }
  >;
}

export function issueTurnCredentials(userId: string): TurnCredentials {
  if (!TURN_SECRET) {
    throw new Error('TURN_SECRET not configured');
  }
  const expiry = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_S;
  const username = `${expiry}:${userId}`;
  const password = createHmac('sha1', TURN_SECRET).update(username).digest('base64');

  const stun = STUN_URIS.split(',').map((s) => s.trim()).filter(Boolean);
  const turn = TURN_URIS.split(',').map((s) => s.trim()).filter(Boolean);

  const iceServers: TurnCredentials['iceServers'] = [
    ...stun.map((u) => ({ urls: u })),
    ...turn.map((u) => ({ urls: u, username, credential: password })),
  ];

  return { username, password, ttl: TURN_CRED_TTL_S, iceServers };
}
