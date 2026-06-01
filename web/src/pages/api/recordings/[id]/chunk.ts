import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { getChunkStore } from '@/lib/storage';
import { unwrapKey, encryptChunk } from '@/lib/recordingCrypto';

/**
 * PUT /api/recordings/[id]/chunk?seq=N
 *
 * Body: raw binary (one MediaRecorder blob). The viewer that owns the
 * recording streams chunks here while the session runs. Each chunk is
 * encrypted under the recording's data key and written to object storage.
 *
 * We disable Next's body parser and read the raw stream ourselves.
 */
export const config = { api: { bodyParser: false } };

const MAX_CHUNK_BYTES = 25 * 1024 * 1024; // 25 MB hard cap per chunk

function readRawBody(req: NextApiRequest, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error('chunk too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });

  const id = String(req.query.id);
  const seq = parseInt(String(req.query.seq ?? ''), 10);
  if (!Number.isInteger(seq) || seq < 0) {
    return res.status(400).json({ error: 'missing or invalid seq' });
  }

  const recording = await prisma.sessionRecording.findUnique({ where: { id } });
  if (!recording) return res.status(404).json({ error: 'not found' });
  // Only the viewer who started the recording can push its chunks.
  if (recording.viewerUserId !== user.id) return res.status(404).json({ error: 'not found' });
  if (recording.status !== 'recording') {
    return res.status(409).json({ error: 'recording is not active' });
  }
  if (!recording.wrappedKey) {
    return res.status(500).json({ error: 'recording has no data key' });
  }

  let body: Buffer;
  try {
    body = await readRawBody(req, MAX_CHUNK_BYTES);
  } catch (e: any) {
    if (e?.code === 'TOO_LARGE') return res.status(413).json({ error: 'chunk too large' });
    return res.status(400).json({ error: 'failed to read body' });
  }
  if (body.length === 0) return res.status(400).json({ error: 'empty chunk' });

  const dek = unwrapKey(recording.wrappedKey);
  const sealed = encryptChunk(dek, body);
  await getChunkStore().putChunk(recording.storageKey, seq, sealed);

  // Track running totals (plaintext bytes). Atomic increments tolerate the
  // chunks arriving slightly out of order.
  await prisma.sessionRecording.update({
    where: { id: recording.id },
    data: {
      bytes: { increment: body.length },
      chunkCount: { increment: 1 },
    },
  });

  return res.status(200).json({ ok: true, seq });
}
