-- Wave 4: tamper-evident audit log.
--
-- Adds the hash-chain sequence column to AuditLog and the AuditAnchor table
-- for signed checkpoints. Existing rows have chainSeq=NULL (unsealed) and get
-- sealed on the next sealing pass.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "chainSeq" INTEGER;

-- CreateIndex
CREATE INDEX "AuditLog_orgId_chainSeq_idx" ON "AuditLog"("orgId", "chainSeq");

-- CreateTable
CREATE TABLE "AuditAnchor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "rowHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AuditAnchor_scope_createdAt_idx" ON "AuditAnchor"("scope", "createdAt");
