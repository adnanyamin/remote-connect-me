-- Wave 2: Organizations + RBAC.
--
-- Adds Organization and Membership tables, tenant-scopes Device by orgId,
-- adds AuditLog.orgId. Backfill creates a personal org + owner membership
-- for every pre-existing user so no rows are stranded.

PRAGMA foreign_keys = OFF;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_orgId_key" ON "Membership"("userId", "orgId");

-- CreateIndex
CREATE INDEX "Membership_orgId_role_idx" ON "Membership"("orgId", "role");

-- Backfill: every existing user gets a personal org + owner membership.
-- Stable, deterministic ids derived from User.id so this is idempotent and
-- preserves the FK target for Device.orgId in the rebuild below.
INSERT INTO "Organization" (id, name, slug, personal, createdAt)
SELECT
    'org_p_' || u.id,
    substr(u.email, 1, instr(u.email, '@') - 1) || '''s workspace',
    'p-' || lower(replace(substr(u.email, 1, instr(u.email, '@') - 1), '.', '-')) || '-' || substr(u.id, -6),
    1,
    u.createdAt
FROM "User" u
WHERE NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m.userId = u.id);

INSERT INTO "Membership" (id, userId, orgId, role, createdAt)
SELECT 'mb_p_' || u.id, u.id, 'org_p_' || u.id, 'owner', u.createdAt
FROM "User" u
WHERE NOT EXISTS (SELECT 1 FROM "Membership" m2 WHERE m2.userId = u.id);

-- AlterTable AuditLog: add nullable orgId + index.
ALTER TABLE "AuditLog" ADD COLUMN "orgId" TEXT REFERENCES "Organization" ("id") ON DELETE SET NULL;

-- CreateIndex
CREATE INDEX "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");

-- Recreate Device to add orgId NOT NULL with FK. Standard SQLite 12-step pattern.
CREATE TABLE "Device_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'windows',
    "deviceKeyHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME,
    CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Device_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "Device_new" (id, userId, orgId, name, platform, deviceKeyHash, createdAt, lastSeenAt)
SELECT
    d.id,
    d.userId,
    (SELECT m.orgId FROM "Membership" m WHERE m.userId = d.userId ORDER BY m.createdAt LIMIT 1),
    d.name,
    d.platform,
    d.deviceKeyHash,
    d.createdAt,
    d.lastSeenAt
FROM "Device" d;

DROP TABLE "Device";
ALTER TABLE "Device_new" RENAME TO "Device";

-- CreateIndex
CREATE INDEX "Device_orgId_idx" ON "Device"("orgId");

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
