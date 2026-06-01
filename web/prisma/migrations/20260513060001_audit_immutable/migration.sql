-- Wave 4: make AuditLog rows immutable.
--
-- Drops the FK constraints on AuditLog.userId / AuditLog.orgId. They were
-- ON DELETE SET NULL, which would MUTATE a sealed audit row when the referenced
-- user/org is deleted — silently breaking the hash chain and falsely flagging
-- tampering. An audit log should preserve who-did-what-where even after the
-- referenced records are gone, so userId/orgId become plain (un-enforced)
-- string columns. Standard SQLite table rebuild.

PRAGMA foreign_keys = OFF;

CREATE TABLE "AuditLog_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "orgId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" TEXT,
    "chainSeq" INTEGER,
    "prevHash" TEXT,
    "rowHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "AuditLog_new" (id, userId, orgId, action, targetType, targetId, ip, userAgent, metadata, chainSeq, prevHash, rowHash, createdAt)
SELECT id, userId, orgId, action, targetType, targetId, ip, userAgent, metadata, chainSeq, prevHash, rowHash, createdAt
FROM "AuditLog";

DROP TABLE "AuditLog";
ALTER TABLE "AuditLog_new" RENAME TO "AuditLog";

CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
CREATE INDEX "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_orgId_chainSeq_idx" ON "AuditLog"("orgId", "chainSeq");

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
