import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRole } from '@/lib/org';
import { generateDataKey, wrapKey } from '@/lib/recordingCrypto';

/**
 * POST /api/devices/[id]/recordings
 *
 * Starts a session recording. Called by the viewer right before it begins
 * pushing chunks. Requires technician+ (same bar as connecting). Refuses if
 * the org's recordingPolicy is "off".
 *
 * Generates the per-recording data key here and stores it WRAPPED. The
 * unwrapped key never leaves this function — chunk encryption happens on the
 * chunk-upload path, which re-unwraps as needed.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = await requireOrgRole(req, res, 'technician');
  if (!auth.ok) return;
  const { ctx } = auth;

  if (ctx.org.recordingPolicy === 'off') {
    return res.status(403).json({ error: 'recording is disabled for this organization' });
  }

  const deviceId = String(req.query.id);
  const device = await prisma.device.findFirst({ where: { id: deviceId, orgId: ctx.org.id } });
  if (!device) return res.status(404).json({ error: 'not found' });

  // Create the row first so we can derive a storage key from its id.
  const recording = await prisma.sessionRecording.create({
    data: {
      orgId: ctx.org.id,
      deviceId: device.id,
      viewerUserId: ctx.user.id,
      status: 'recording',
      storageKey: 'pending', // replaced below now that we know the id
    },
  });

  const storageKey = `recordings/${ctx.org.id}/${recording.id}`;
  const dek = generateDataKey();
  const updated = await prisma.sessionRecording.update({
    where: { id: recording.id },
    data: { storageKey, wrappedKey: wrapKey(dek) },
  });

  await writeAudit({
    action: 'session.recording.start',
    userId: ctx.user.id,
    orgId: ctx.org.id,
    targetType: 'recording',
    targetId: recording.id,
    req,
    metadata: { deviceId: device.id, policy: ctx.org.recordingPolicy },
  });

  return res.status(200).json({
    recordingId: updated.id,
    // The viewer uploads chunks to /api/recordings/<id>/chunk?seq=N
    chunkUrl: `/api/recordings/${updated.id}/chunk`,
  });
}
