-- Wave 2: Session recording (opt-in).
--
-- Org-level policy + retention, plus the SessionRecording table. Media lives
-- in object storage; only metadata + the wrapped data key live here.

-- AlterTable: org policy + retention.
ALTER TABLE "Organization" ADD COLUMN "recordingPolicy" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Organization" ADD COLUMN "recordingRetentionDays" INTEGER NOT NULL DEFAULT 90;

-- CreateTable
CREATE TABLE "SessionRecording" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "viewerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "wrappedKey" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionRecording_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionRecording_orgId_createdAt_idx" ON "SessionRecording"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionRecording_deviceId_createdAt_idx" ON "SessionRecording"("deviceId", "createdAt");
