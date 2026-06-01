# Remotely — Roadmap to a complete, security-certified platform

Goal: turn the current MVP into a full LogMeIn-class product with code-signed clients, verifiable security properties, and a path to SOC 2 / ISO 27001 attestation. Built in five waves so we ship usable improvements every 1–4 weeks rather than disappearing into a six-month compliance project.

Each wave is roughly self-contained — you can stop after Wave 2 and have a solid product, after Wave 4 and have something defensibly secure, or push through Wave 5 for formal certification.

## Current state (as of 2026-05-12)

What exists in this repo:

- `web/` — Next.js app, Prisma (SQLite for dev), JWT auth, device pairing, connect tokens, viewer page
- `signaling/` — Node WS server relaying SDP/ICE, JWT-authed
- `client/` — Electron Windows client with `keytar`-backed device key storage
- WebRTC P2P with DTLS-SRTP for the actual screen / input / file traffic

What it doesn't have yet (from `docs/DEPLOY.md §7` + a security pass):

email verification, rate limiting, audit log, MFA, multi-monitor, adaptive bitrate, TURN credential rotation, auto-update, crash reporting, code signing, macOS/Linux clients, RBAC/teams, session recording, formal policies. Wave plan below addresses all of these.

---

## Wave 0 — Hardening sprint (1–2 weeks)

Stop the bleeding before adding features. Everything here is table-stakes for exposing the service to the public web.

| Task | Why | Effort |
| --- | --- | --- |
| Rate limiting on `/api/auth/*` and `/api/client/pair` | Brute-force resistance | 1d (Upstash + middleware) |
| Email verification at signup | Prevent throwaway accounts; required for any future compliance | 1d (Resend or SES) |
| Audit log model + write-path | Foundation for both ops visibility and SOC 2 evidence | 2d (Prisma model + helper) |
| TURN credential rotation endpoint | Stop shipping a static TURN password in the client bundle | 1d (HMAC time-limited creds) |
| Secrets rotation runbook | `JWT_SECRET`, `SIGNALING_SECRET`, TURN secret | 0.5d |
| Dependency audit + Renovate/Dependabot | Catch CVEs in `ws`, `jsonwebtoken`, Electron, etc. | 0.5d |

Exit criteria: a fresh hostile user cannot DOS auth, cannot enumerate emails, cannot pair without seeing a verification mail; every session start/stop produces an audit row.

## Wave 1 — Platform completeness (3–5 weeks)

Now make it feel like a real product, not an MVP demo.

| Task | Notes | Effort |
| --- | --- | --- |
| File transfer over data channel | Bidirectional, chunked, resumable | 4–5d |
| Clipboard sync (text first, then images) | Already plumbed via input channel; needs throttle + size cap | 2d |
| Multi-monitor picking | Host enumerates displays, viewer picks; switch mid-session | 2d |
| Adaptive bitrate (simulcast or SVC) | Replace fixed 1080p30 offer with `addTransceiver` + degradation prefs | 3d |
| Unattended access UX | Explicit opt-in toggle, PIN, idle re-auth | 2d |
| Auto-update for client | `electron-updater` + GitHub Releases or S3 feed | 2d |
| Crash reporting | Sentry free tier across web + Electron + signaling | 1d |
| macOS client | Same Electron base, ScreenCaptureKit + AVFAudio for capture | 5–7d |
| Linux client | X11 + Wayland (pipewire) capture; AppImage build | 5–7d |
| Mobile viewer (PWA) | Touch-to-mouse mapping, on-screen keyboard | 5d |

Exit criteria: feature parity with TeamViewer/LogMeIn "free tier" on Win/macOS/Linux + a browser viewer that works on phones.

## Wave 2 — Account & access controls (2–3 weeks)

Required before any B2B customer can adopt this; also unblocks several Wave 4/5 controls.

| Task | Notes | Effort |
| --- | --- | --- |
| MFA (TOTP) | RFC 6238, `otplib`; recovery codes; require before connect | 2d |
| Organizations / teams | New `Organization` + `Membership` Prisma models; tenant scoping on every query | 4d |
| RBAC | Owner / admin / technician / viewer roles; per-device ACLs | 3d |
| Session approval workflow | Optional: host user must approve incoming attended session | 2d |
| Session recording (opt-in) | Record DTLS-decrypted track on viewer side, upload to S3 with KMS encryption | 4d |
| Admin dashboard | Members, devices, audit log viewer, session history | 3d |

Exit criteria: an IT admin at a 50-person company could deploy this and provision per-technician access without editing a database.

## Wave 3 — Code-signing wave (1–2 weeks elapsed; mostly waiting on certs)

This is the "security-certified" piece most users actually see.

| Task | Notes | Cost / time |
| --- | --- | --- |
| Windows EV code-signing cert | Sectigo/DigiCert, hardware token, instant SmartScreen reputation | ~$300/yr + 1–2 weeks vetting |
| macOS Developer ID + notarization | Apple Developer Program; `electron-notarize` in build pipeline | $99/yr + 1d setup |
| Linux package signing | GPG-signed `.deb` + `.rpm`; AppImage signature | 1d |
| CI/CD pipeline | GitHub Actions: matrix build win/mac/linux → signed artifacts → release | 2–3d |
| SBOM generation | CycloneDX or SPDX from `npm sbom` for every release | 0.5d |
| Reproducible builds | Pin Node/Electron versions, lockfile-only installs, deterministic timestamps | 1d |

Exit criteria: a user double-clicks any installer on any OS and sees zero scary warnings. Every release has an attached SBOM.

## Wave 4 — Verifiable security & transparency (2–4 weeks)

This is the wave that lets you defensibly say "we are a secure product" without yet having a SOC 2 stamp. Useful to procurement teams asking security questions.

| Task | Notes | Effort |
| --- | --- | --- |
| Threat model document | STRIDE pass on data flow; published in `/docs/SECURITY.md` | 2d |
| E2EE properties writeup | Explain DTLS-SRTP guarantees; what the signaling server can and cannot see | 1d |
| Tamper-evident audit log | Hash-chained rows (each row contains hash of previous); signed daily roots | 2d |
| Append-only session recordings | Encrypt-at-rest with per-tenant KMS key; immutable S3 bucket | 2d |
| Public bug bounty | huntr.dev (free) or HackerOne ($) | 1d setup |
| Third-party crypto/code review | Engage an independent reviewer for the auth + WebRTC integration paths | $5–15k, 2–4 wks |
| security.txt + disclosure policy | `/.well-known/security.txt`, PGP key, 90-day disclosure | 0.5d |
| Penetration test (light) | One-week engagement on web + signaling | $8–15k |

Exit criteria: you can hand a CISO a one-page security FAQ + threat model + recent pen-test letter and they sign off.

## Wave 5 — Formal compliance (3–6 months)

Only do this if a customer specifically requires it, or if you want enterprise sales.

| Task | Notes | Effort / cost |
| --- | --- | --- |
| Pick framework | SOC 2 Type I (point-in-time) first, Type II (3–12mo observation) after | — |
| Compliance automation vendor | Vanta, Drata, or Secureframe — auto-collects evidence from AWS/GitHub/etc. | $7–15k/yr |
| Policy authoring | Access control, change management, incident response, BC/DR, vendor management, secure SDLC — 10–15 documents | 2–3 wks (heavily templated by vendor) |
| Control implementation | MFA enforcement, log retention, background checks for staff, annual training, vulnerability scans | ongoing |
| Penetration test (full) | Cure53, Trail of Bits, NCC Group | $15–35k |
| Auditor engagement | A CPA firm — Prescient, Johanson, A-LIGN | $15–25k (Type I), $25–60k (Type II) |
| ISO 27001 (optional, after SOC 2) | Same evidence base, different auditor and statement-of-applicability work | $20–40k |
| HIPAA BAA path (optional) | If healthcare customers — add encryption controls, BAA template, sign BAAs with sub-processors | 1–2 wks |

Exit criteria: signed SOC 2 Type II report you can hand to enterprise procurement under NDA.

---

## Dependencies between waves

```
Wave 0 ─┬─► Wave 1 (audit log used by session recording)
        ├─► Wave 2 (MFA needs email verification from Wave 0)
        └─► Wave 4 (audit log → tamper-evident audit log)
Wave 2 ─┬─► Wave 4 (RBAC + audit needed for security writeup)
        └─► Wave 5 (org/RBAC required for SOC 2 access-control controls)
Wave 3 ──► Wave 5 (signed builds are a SOC 2 change-management control)
```

You can run Wave 3 (cert procurement) in parallel with Waves 0–2 because most of the elapsed time is vendor vetting, not coding.

## Recommended starting order

1. Wave 0 in full (1–2 weeks) — non-negotiable before public exposure.
2. **Order the Windows EV cert on day one of Wave 0** — the 1–2 week vetting runs while you build.
3. Wave 1, picking the 3 features your users will notice first (suggest: file transfer, multi-monitor, macOS client).
4. Wave 2 if you want to sell to teams; skip to Wave 4 if this stays a prosumer tool.
5. Wave 4 once you have a story worth telling.
6. Wave 5 only when a real customer asks for it.

## What this costs (rough, one year)

| Category | Cost |
| --- | --- |
| Infra (Vercel + Fly + coturn VPS + Postgres) | $300–600/yr |
| Code-signing certs (Win EV + macOS + Linux) | ~$400/yr |
| Sentry, Upstash, Resend, S3 | $0–300/yr (free tiers go far) |
| Independent crypto review (Wave 4) | $5–15k one-time |
| Pen test (Wave 4 light) | $8–15k |
| Pen test (Wave 5 full) | $15–35k |
| Compliance vendor (Vanta/Drata) | $7–15k/yr |
| SOC 2 Type II auditor | $25–60k one-time |
| **Just Waves 0–3 (sellable product, signed clients)** | **~$1k/yr + 6–8 weeks engineering** |
| **Add Wave 4 (defensibly secure)** | **+ ~$15–25k one-time + 3–4 weeks** |
| **Add Wave 5 (SOC 2 Type II)** | **+ ~$40–80k year one + 3–6 months** |

## Open decisions I need from you before coding

1. **Customer profile**: prosumer/SMB or B2B/enterprise? Drives whether Wave 2 + 5 are mandatory or optional.
2. **Self-host story**: do you want this to also run fully self-hosted (docker-compose), or only as a SaaS you operate? Affects how secrets, audit logs, and updates are designed.
3. **Cloud preference**: AWS, GCP, or Cloudflare-only? Influences KMS / S3 / object-lock choices in Waves 2 and 4.
4. **Recording legality**: session recording is regulated in some jurisdictions (NY, IL, EU). If we ship it, who owns the legal review?
5. **Trademark**: "Remotely" is taken by an existing OSS project — do we rename before code-signing? Cheaper to rename now than after the EV cert is issued in the wrong name.

Once those are settled I can start on Wave 0 — my suggested first PR is rate limiting + audit-log Prisma model + email verification, which together unblock everything else.
