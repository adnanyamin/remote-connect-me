-- Wave 2: Session approval workflow.
--
-- Default true is the safer choice: legacy devices upgrade to "ask before
-- letting a viewer in" rather than silently accepting incoming sessions.
-- Owners can opt out per-device (PATCH /api/devices/[id]).

ALTER TABLE "Device" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT true;
