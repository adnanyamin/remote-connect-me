import { prisma } from './db';
import { getChunkStore } from './storage';
import { writeAudit } from './audit';

/**
 * Recording retention enforcement.
 *
 * Finds recordings whose retention window has elapsed (expiresAt < now) and
 * purges their media from object storage. The SessionRecording ROW is kept but
 * downgraded to status="purged" with its wrapped data key cleared — so the
 * audit trail (who recorded what device, when, how long) survives while the
 * actual screen content and its decryption key are destroyed.
 *
 * Idempotent and safe to run repeatedly (e.g. a daily cron). Only touches rows
 * that finished recording (completed/aborted); never an in-progress one.
 */
export async function purgeExpiredRecordings(now: Date = new Date()): Promise<{
  scanned: number;
  purged: number;
  errors: number;
}> {
  const due = await prisma.sessionRecording.findMany({
    where: {
      status: { in: ['completed', 'aborted'] },
      expiresAt: { not: null, lt: now },
    },
    select: { id: true, orgId: true, deviceId: true, storageKey: true, bytes: true },
  });

  const store = getChunkStore();
  let purged = 0;
  let errors = 0;

  for (const r of due) {
    try {
      await store.remove(r.storageKey);
      await prisma.sessionRecording.update({
        where: { id: r.id },
        data: { status: 'purged', wrappedKey: null },
      });
      await writeAudit({
        action: 'session.recording.purge',
        orgId: r.orgId,
        targetType: 'recording',
        targetId: r.id,
        metadata: { deviceId: r.deviceId, bytes: r.bytes },
      });
      purged += 1;
    } catch (e) {
      // Leave the row as-is so the next run retries it.
      console.error('[retention] failed to purge recording', r.id, e);
      errors += 1;
    }
  }

  return { scanned: due.length, purged, errors };
}
