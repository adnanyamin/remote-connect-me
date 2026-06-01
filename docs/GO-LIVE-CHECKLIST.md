# Go-live checklist

Prioritized path from the current codebase to a production deployment you can
expose to real users. Ordered by severity — do the **Blockers** in order before
anything else. Boxes are unchecked on purpose; tick them as you go.

The state this list assumes: Waves 0–4 of `docs/ROADMAP.md` are written and the
security-sensitive logic is unit-verified, but the web app has not been compiled
or run, and the Prisma migrations were authored against SQLite for dev. Most of
what's below is integration + configuration, not new feature work.

---

## 0. Blockers — the app will not run correctly until these are done

- [ ] **Install + generate the Prisma client.** The committed client predates the
      Wave 2–4 schema. From the repo root:
      ```bash
      npm install
      npm --workspace web exec prisma generate
      ```
- [ ] **Type-check and build the web app.** None of the Wave 2–4 TypeScript has
      been compiled. Fix anything that surfaces.
      ```bash
      npm --workspace web exec tsc --noEmit
      npm --workspace web run build
      ```
- [ ] **Port migrations to Postgres and apply them.** The six dev migrations use
      SQLite-specific table rebuilds and will not run on Postgres as-is.
      1. In `web/prisma/schema.prisma`, set `datasource.provider = "postgresql"`.
      2. Point `DATABASE_URL` at a fresh Postgres database.
      3. Regenerate a clean migration history for Postgres
         (`prisma migrate dev` locally against Postgres), or hand-port each
         migration and run `prisma migrate deploy` in your deploy pipeline.
      4. Verify all 10 tables + indexes exist and `AuditLog` has no FKs.
- [ ] **Confirm CI is green.** Push to GitHub; the `ci` workflow runs the
      typecheck/build + signaling test. This is the first time `.github/workflows`
      execute — fix any drift.

## 1. Secrets — production refuses to start / silently weakens without these

Generate strong values (`openssl rand -hex 32`) and set them in every
environment that runs the web app and the signaling server.

- [ ] `JWT_SECRET` — signs the session cookie. **auth.ts throws in prod if unset/placeholder.**
- [ ] `SIGNALING_SECRET` — must be **identical** on the web app and the signaling
      server. **Both processes exit in prod if unset/placeholder.**
- [ ] `RECORDING_MASTER_KEY` — base64 of 32 bytes; wraps recording data keys.
      **recordingCrypto throws in prod if unset.** Losing it makes all existing
      recordings permanently unreadable — back it up in a secrets manager. There
      is no key-rotation path yet; rotating it orphans old recordings.
- [ ] `AUDIT_ANCHOR_SECRET` — HMAC key for signed audit anchors. **auditChain
      throws in prod if unset.** Treat like the others.
- [ ] `CRON_SECRET` — bearer token the scheduled jobs require. Set it, or the
      cron endpoints refuse to run.
- [ ] `DATABASE_URL` — production Postgres connection string.

## 2. Stateful infra — required for correct multi-instance behavior

- [ ] **Upstash Redis** (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`).
      Without it, rate limiting falls back to in-memory and is **per-instance**,
      i.e. ineffective on Vercel/serverless. Brute-force protection depends on this.
- [ ] **Email** (`RESEND_API_KEY` + `EMAIL_FROM`). Without it, verification and
      invitation emails only print to stderr. Signup/invite flows won't deliver mail.
- [ ] **Object storage for recordings** (only if recording is enabled):
      set `STORAGE_DRIVER=s3` + `S3_BUCKET`, `S3_REGION`, `S3_KMS_KEY_ID`, AWS creds.
      The default `local` driver only works on a single persistent box.
- [ ] **TURN server** (`NEXT_PUBLIC_ICE_SERVERS` with a `turn:` entry). Without
      TURN ~20% of users behind symmetric NAT can't connect. See `docs/DEPLOY.md §3`.

## 3. Scheduled jobs — set up after secrets

- [ ] Confirm `web/vercel.json` crons are deployed (Vercel reads it automatically),
      or wire an equivalent scheduler that hits, with the `CRON_SECRET` bearer:
      - `POST /api/internal/cron/purge-recordings` (daily) — enforces recording retention.
      - `POST /api/internal/cron/seal-audit` (daily) — seals + signs the audit chain.
- [ ] After first run, hit **Verify integrity** on `/settings/audit` for an org and
      confirm it reports "chain intact" with a recent anchor.

## 4. Client distribution + signing (see docs/DEPLOY.md §4a)

- [ ] Replace `REPLACE_ME_GITHUB_OWNER` / `REPLACE_ME_GITHUB_REPO` / the
      `maintainer` email in `client/package.json`.
- [ ] Point the client at prod (`REMOTELY_API_BASE`, `REMOTELY_SIGNALING_URL`,
      `REMOTELY_ICE_SERVERS`) — bake into `client/main.js` defaults or set at build.
- [ ] Tag a release (`git tag v0.2.0 && git push --follow-tags`) and confirm the
      `release` workflow builds all three platforms, generates SBOMs, and
      cosign-signs every artifact.
- [ ] (Optional, paid, long-lead) Windows EV cert + Apple Developer ID. The
      pipeline signs automatically once `CSC_*` / `APPLE_*` secrets are set;
      until then builds are unsigned but still cosign-attested.

## 5. Pre-launch security pass (Wave 4/5 of the roadmap)

- [ ] Update `web/public/.well-known/security.txt` placeholders (contact, policy
      URL, `Expires` date) and publish the policy page.
- [ ] Write the threat model (`docs/SECURITY.md`, STRIDE over the data flow) and
      the E2EE-properties note — what the signaling server can and cannot see.
- [ ] Independent review of the auth + WebRTC + crypto paths, then a light
      penetration test of the web app + signaling server before public exposure.
- [ ] Privacy policy + ToS if you take real signups; recording is legally
      regulated in some jurisdictions (NY, IL, EU) — get the recording-consent
      story reviewed.

## 6. Smoke test the golden path on staging

- [ ] Sign up → verify email → personal org auto-created.
- [ ] Enroll MFA → sign out → sign in with TOTP and with a recovery code.
- [ ] Add device → pair the Electron client → device shows Online.
- [ ] Connect from the browser; with approval required, confirm the host prompt
      and that rejecting routes an error back to the viewer.
- [ ] Invite a teammate → accept → confirm role-gated access (viewer can't
      connect, technician can't manage, admin can, owner can transfer).
- [ ] If recording is enabled: record a session → confirm it appears under
      `/settings/recordings` and downloads as a playable WebM.
- [ ] Run the retention + seal crons manually and re-verify audit integrity.
