import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

/**
 * Envelope encryption for session recordings.
 *
 * This is the same shape KMS uses, implemented with local crypto so it works
 * in self-hosted deployments and is swappable for a real KMS later:
 *
 *   - Each recording gets its own random 256-bit Data Encryption Key (DEK).
 *   - Media chunks are encrypted with the DEK using AES-256-GCM (per-chunk IV).
 *   - The DEK itself is "wrapped" (encrypted) under a deployment master key and
 *     stored alongside the recording row. We never persist an unwrapped DEK.
 *
 * To move to AWS KMS in production, replace wrapKey/unwrapKey with
 * kms.GenerateDataKey / kms.Decrypt — the chunk format stays identical.
 *
 * Master key: env RECORDING_MASTER_KEY, base64 of exactly 32 bytes. In dev,
 * if unset, we derive a deterministic key from a fixed dev string and log a
 * loud warning — fine for local testing, unacceptable in prod (recordings
 * would be readable by anyone who knows the dev string).
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // GCM standard nonce length
const TAG_LEN = 16;  // GCM auth tag length
const KEY_LEN = 32;  // 256-bit keys

let warnedDevKey = false;

function masterKey(): Buffer {
  const env = process.env.RECORDING_MASTER_KEY;
  if (env) {
    const buf = Buffer.from(env, 'base64');
    if (buf.length !== KEY_LEN) {
      throw new Error(`RECORDING_MASTER_KEY must be base64 of ${KEY_LEN} bytes (got ${buf.length})`);
    }
    return buf;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RECORDING_MASTER_KEY is required in production for session recording');
  }
  if (!warnedDevKey) {
    console.warn(
      '[recordingCrypto] RECORDING_MASTER_KEY unset — using an INSECURE dev key. ' +
      'Set RECORDING_MASTER_KEY (base64, 32 bytes) before enabling recording in prod.',
    );
    warnedDevKey = true;
  }
  // Deterministic dev key so recordings survive a server restart in dev.
  return createHash('sha256').update('remotely-dev-recording-master-key').digest();
}

/** A fresh per-recording data key. */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_LEN);
}

/** GCM-encrypt `plaintext` under `key`. Returns iv|tag|ciphertext. */
function seal(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Reverse of seal(). Throws if the auth tag fails (tamper / wrong key). */
function open(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Wrap a DEK under the master key. Returns base64 of iv|tag|ciphertext. */
export function wrapKey(dek: Buffer): string {
  return seal(masterKey(), dek).toString('base64');
}

/** Unwrap a previously wrapped DEK. */
export function unwrapKey(wrapped: string): Buffer {
  return open(masterKey(), Buffer.from(wrapped, 'base64'));
}

/** Encrypt one media chunk under the DEK. Output is iv|tag|ciphertext. */
export function encryptChunk(dek: Buffer, chunk: Buffer): Buffer {
  return seal(dek, chunk);
}

/** Decrypt one media chunk. */
export function decryptChunk(dek: Buffer, blob: Buffer): Buffer {
  return open(dek, blob);
}
