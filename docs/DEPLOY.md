# Deploying Remotely to the public web

Three services need a home: the **web app**, the **signaling server**, and (optional but strongly recommended) a **TURN server**. Plus a build of the **Windows client** that points at the right URLs.

## 1. Web app (Next.js)

The simplest free path is **Vercel**:

```bash
cd web
# 1. Switch Prisma from SQLite to Postgres.
sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma
# 2. Push to GitHub, click "Import Project" on vercel.com, pick the web/ subdir.
# 3. Set env vars in Vercel:
#       DATABASE_URL          = postgres://... (Vercel Postgres free tier works)
#       JWT_SECRET            = openssl rand -hex 32
#       SIGNALING_SECRET      = openssl rand -hex 32  (must match signaling server)
#       NEXT_PUBLIC_SIGNALING_URL = wss://signaling.yourdomain.com
#       NEXT_PUBLIC_ICE_SERVERS   = stun:stun.l.google.com:19302,turn:turn.yourdomain.com:3478|user|pass
# 4. Run a one-shot migration: npx prisma migrate deploy (in Vercel's "Build Command" override or a CI job).
```

Cost: free tier covers light traffic. For sustained use plan ~$20/mo (Vercel Hobby + Vercel Postgres).

Alternative: **Fly.io** with `fly launch` — also free tier, you supply your own Postgres.

## 2. Signaling server

Anywhere that lets you keep a WebSocket open. **Fly.io** is a good fit:

```bash
cd signaling
fly launch --no-deploy        # accept defaults, name "remotely-signal"
# Edit fly.toml: ensure [services] internal_port = 8787 and [[services.ports]] handlers = ["tls","http"] for WSS.
fly secrets set SIGNALING_SECRET=$(openssl rand -hex 32)
fly deploy
```

Then point the web app's `NEXT_PUBLIC_SIGNALING_URL` at `wss://remotely-signal.fly.dev` (or your custom domain).

Free tier: 3 shared-CPU-1x machines × 256 MB. Plenty for thousands of idle hosts.

## 3. TURN server (coturn)

Without TURN, ~20% of users behind symmetric NAT (corporate networks, some mobile carriers) will fail to connect. coturn is the canonical free implementation.

Smallest viable VPS: **Hetzner CX11 (€4.51/mo)** or **DigitalOcean $4 droplet**. Ubuntu 22.04.

```bash
sudo apt update && sudo apt install -y coturn
sudo nano /etc/turnserver.conf
```

Minimum config:

```
listening-port=3478
tls-listening-port=5349
external-ip=YOUR.PUBLIC.IP
realm=yourdomain.com
fingerprint
lt-cred-mech
user=remotely:CHANGE_ME_LONG_PASSWORD
no-stdout-log
log-file=/var/log/coturn.log
cert=/etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.yourdomain.com/privkey.pem
```

Open ports `3478/udp+tcp` and `5349/tcp` in the firewall. Get a TLS cert via certbot.

Then in your web app:

```
NEXT_PUBLIC_ICE_SERVERS=stun:stun.l.google.com:19302,turn:turn.yourdomain.com:3478|remotely|CHANGE_ME_LONG_PASSWORD
```

For sharing with the public, **rotate credentials** with TURN REST (time-limited usernames). The current code does not do this; production-grade work would add a `/api/turn-credentials` endpoint that mints short-lived TURN credentials.

## 4. Windows client installer

Building locally on Windows:

```powershell
cd client
# Set the URLs so the installed app talks to your prod servers:
$env:REMOTELY_API_BASE       = "https://app.yourdomain.com"
$env:REMOTELY_SIGNALING_URL  = "wss://signaling.yourdomain.com"
$env:REMOTELY_ICE_SERVERS    = "stun:stun.l.google.com:19302,turn:turn.yourdomain.com:3478|user|pass"
npm run dist
```

Output: `client/dist/Remotely-Setup-*.exe`.

To bake those URLs into the installer instead of relying on env vars at runtime, edit `client/main.js` and replace `DEFAULT_API_BASE` / `DEFAULT_SIGNALING_URL` with your production hostnames before building. (The env vars are an escape hatch for dev.)

### Code signing

Without a code-signing cert, Windows SmartScreen will warn users that "Windows protected your PC" and require an extra click. You'll lose ~70% of users at that screen.

Options:
- **Standard cert** (Sectigo, DigiCert): ~$70-120/yr. Works, but takes ~30 days of "reputation building" before SmartScreen stops flagging it.
- **EV cert**: ~$300/yr, instant SmartScreen reputation, requires a hardware token. Worth it if this is more than a hobby.

Once you have a `.pfx`, electron-builder picks it up automatically:

```powershell
$env:CSC_LINK     = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "..."
npm run dist
```

## 4a. Releasing & signing (CI/CD)

A tagged release is built, signed, SBOM'd, and published automatically by
`.github/workflows/release.yml`. Push a version tag and the matrix builds all
three platforms:

```bash
npm version patch        # or: git tag v0.2.0
git push --follow-tags
```

**What the pipeline does per platform (Windows / macOS / Linux):**

1. `npm ci` from the root lockfile (workspaces), then `electron-builder` for
   that OS.
2. Generates a CycloneDX SBOM (`sbom.<platform>.cdx.json`).
3. Signs every installer + the SBOM with **Sigstore cosign** (keyless OIDC) —
   this happens on every release with no secrets required, so you get
   verifiable provenance immediately.
4. Real OS code-signing + notarization run **only if the matching secrets are
   set** (see below). When absent, the build is unsigned but still succeeds and
   is still cosign-signed.
5. Uploads installers, SBOMs, and `.sigstore` bundles to the GitHub Release.

**Secret-gated signing.** Configure these as GitHub Actions repository secrets
to turn on real signing — until then the pipeline stays green and unsigned:

| Platform | Secrets | Effect when set |
| --- | --- | --- |
| Windows | `CSC_LINK` (base64 of your `.pfx`), `CSC_KEY_PASSWORD` | electron-builder signs the NSIS installer |
| macOS | `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID cert) + `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | signs **and** notarizes (via `client/build/notarize.js`) |
| Linux | none required | AppImage/deb/rpm build; add GPG `.deb`/`.rpm` signing later if desired |

`CSC_IDENTITY_AUTO_DISCOVERY` is forced off when `CSC_LINK` is empty so macOS
runners don't error trying to find a keychain identity.

**Cert procurement checklist** (the long-lead items — start early, they gate
nothing in the pipeline):

- Windows EV cert (Sectigo/DigiCert): ~$300/yr, hardware token, ~1–2 weeks
  vetting, instant SmartScreen reputation. Base64-encode the exported `.pfx`
  into `CSC_LINK`. (EV on a hardware token may need a custom signtool hook
  rather than `CSC_LINK` — check your CA's HSM docs.)
- Apple Developer Program: $99/yr → Developer ID Application cert + an
  app-specific password for notarization.
- Linux: generate a GPG key and sign `.deb`/`.rpm` (not yet wired; add a
  `DEBSIGN_*`/`rpm --addsign` step when you need repo distribution).

**Verifying a release (what your users / a CISO can run):**

```bash
# Verify the cosign signature + provenance of an installer:
cosign verify-blob \
  --bundle Remotely-Setup-0.2.0.exe.sigstore \
  --certificate-identity-regexp 'https://github.com/<owner>/<repo>/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  Remotely-Setup-0.2.0.exe

# Inspect the SBOM for known-vulnerable deps:
cat sbom.win.cdx.json | jq '.components[] | {name, version}'
```

Reproducibility aids in place: Node pinned via `.nvmrc` (20) + `engines`,
electron/electron-builder pinned to exact versions, `npm ci` (lockfile-only),
and `SOURCE_DATE_EPOCH` derived from the commit timestamp.

## 5. Domain + HTTPS

- Buy any domain.
- Put **Cloudflare** in front of `app.yourdomain.com` and `signaling.yourdomain.com`. Free TLS, DDoS protection, and WSS support out of the box.
- Use a separate subdomain `turn.yourdomain.com` pointed at your coturn IP (Cloudflare proxy MUST be off for this — coturn needs raw UDP).

## 6. Operating costs (rough)

| Component       | Free tier?  | Paid (light load)   |
| --------------- | ----------- | ------------------- |
| Web (Vercel)    | yes         | $20/mo at scale     |
| Postgres        | yes (Vercel)| included            |
| Signaling (Fly) | yes         | ~$2/mo              |
| coturn VPS      | no          | $5/mo               |
| Domain          | no          | $10–15/yr           |
| Code-signing    | no          | $70–300/yr          |
| **Minimum**     |             | **≈ $5/mo + domain**|

You can run this for the price of one coffee a month and a domain name.

## 7. Things this MVP doesn't do — add before going public

- **Email verification** at signup (right now anyone with an email syntactically valid can register).
- **Rate limiting** on auth and pair endpoints (use Vercel middleware or Upstash).
- **Audit log** of remote sessions (who connected to what, when).
- **Multi-monitor** picking on the host (we currently grab the primary display).
- **Adaptive bitrate** — the offer is fixed at 1080p30; on a poor link you'll want WebRTC's native simulcast/SVC.
- **TURN credential rotation** (see §3).
- **Auto-update** for the Windows client — `electron-updater` + a hosted feed.
- **Crash reporting** — Sentry's free tier covers Electron + Next.
- **A privacy policy and ToS** if you take signups from real users.
