import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

/**
 * POST /api/recordings/[id]/finalize  { durationMs?, aborted? }
 *
 * Marks a recording complete (or aborted). Sets endedAt + expiresAt from the
 * org's retention policy. Idempotent: finalizing an already-finalized
 * recording is a no-op success.
 */
const Body = z.object({
  durationMs: z.number().int().nonnegative().optional(),
  aborted: z.boolean().optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });

  const id = String(req.query.id);
  const recording = await prisma.sessionRecording.findUnique({
    where: { id },
    include: { org: true },
  });
  if (!recording) return res.status(404).json({ error: 'not found' });
  if (recording.viewerUserId !== user.id) return res.status(404).json({ error: 'not found' });

  // Idempotent.
  if (recording.status !== 'recording') {
    return res.status(200).json({ ok: true, status: recording.status });
  }

  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  const retentionDays = recording.org.recordingRetentionDays || 90;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  const status = parsed.data.aborted ? 'aborted' : 'completed';

  const updated = await prisma.sessionRecording.update({
    where: { id: recording.id },
    data: {
      status,
      endedAt: now,
      durationMs: parsed.data.durationMs ?? recording.durationMs,
      expiresAt,
    },
  });

  await writeAudit({
    action: 'session.recording.stop',
    userId: user.id,
    orgId: recording.orgId,
    targetType: 'recording',
    targetId: recording.id,
    req,
    metadata: {
      status,
      bytes: updated.bytes,
      chunkCount: updated.chunkCount,
      durationMs: updated.durationMs,
    },
  });

  return res.status(200).json({
    ok: true,
    status,
    bytes: updated.bytes,
    chunkCount: updated.chunkCount,
    expiresAt,
  });
}
