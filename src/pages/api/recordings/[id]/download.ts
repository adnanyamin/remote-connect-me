import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRoleByPath } from '@/lib/org';
import { getChunkStore } from '@/lib/storage';
import { unwrapKey, decryptChunk } from '@/lib/recordingCrypto';

/**
 * GET /api/recordings/[id]/download
 *
 * Streams the decrypted WebM back to an admin+ of the recording's org. We
 * unwrap the data key, then decrypt each stored chunk and write it to the
 * response in order — the concatenation of decrypted MediaRecorder blobs is a
 * playable WebM file.
 *
 * Auth is scoped to the recording's OWN org (not the caller's active org), so
 * an admin can only download recordings from orgs they administer.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const id = String(req.query.id);
  const recording = await prisma.sessionRecording.findUnique({ where: { id } });
  if (!recording) return res.status(404).json({ error: 'not found' });

  const auth = await requireOrgRoleByPath(req, res, recording.orgId, 'admin');
  if (!auth.ok) return;
  const { ctx } = auth;

  if (!recording.wrappedKey) {
    return res.status(409).json({ error: 'recording has no data (never received chunks)' });
  }
  if (recording.status === 'recording') {
    return res.status(409).json({ error: 'recording still in progress' });
  }

  const dek = unwrapKey(recording.wrappedKey);

  await writeAudit({
    action: 'session.recording.download',
    userId: ctx.user.id,
    orgId: recording.orgId,
    targetType: 'recording',
    targetId: recording.id,
    req,
  });

  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Disposition', `attachment; filename="recording-${recording.id}.webm"`);
  // We don't know the exact decrypted length up-front (per-chunk overhead), so
  // we stream without Content-Length. Chunked transfer handles it.

  try {
    for await (const sealed of getChunkStore().readChunks(recording.storageKey)) {
      // If a chunk fails to decrypt (tamper / corruption), abort rather than
      // emit garbage into the playable stream.
      const plain = decryptChunk(dek, sealed);
      res.write(plain);
    }
    res.end();
  } catch (e: any) {
    // Headers may already be sent; if so we can only destroy the socket.
    if (!res.headersSent) {
      res.status(500).json({ error: 'failed to read recording' });
    } else {
      res.end();
    }
  }
}
