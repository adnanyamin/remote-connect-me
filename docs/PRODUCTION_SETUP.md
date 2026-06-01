# Remotely — Production Setup Checklist

Work through these steps in order. Each section tells you exactly what to do and what to paste where.

---

## Step 1 — Generate your secrets (5 min)

Run these commands and save the output somewhere safe (a password manager). You'll paste them into your host's environment variables.

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "SIGNALING_SECRET=$(openssl rand -hex 32)"
echo "TURN_SECRET=$(openssl rand -hex 32)"
echo "RECORDING_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
```

**Never commit these to git.** They go into your hosting platform's environment variable UI, not into any file.

---

## Step 2 — Database: PostgreSQL (10 min)

SQLite is for local dev only. Production needs PostgreSQL.

**Easiest free option: [Neon](https://neon.tech)** (or Vercel Postgres / Supabase)

1. Sign up at neon.tech → create a project → copy the connection string. It looks like:
   `postgresql://user:password@host/dbname?sslmode=require`

2. In `web/prisma/schema.prisma`, change `provider = "sqlite"` to `provider = "postgresql"`.

3. Run the migrations against your new database (one-time, before first deploy):
   ```bash
   cd web
   DATABASE_URL="postgresql://..." npx prisma migrate deploy
   ```

4. Set `DATABASE_URL` as an environment variable on your host.

---

## Step 3 — Web app hosting: Vercel (10 min)

1. Push your repo to GitHub.
2. Go to [vercel.com](https://vercel.com) → Add New Project → import your repo → set the **Root Directory** to `web`.
3. Set these environment variables in Vercel's dashboard (Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Your PostgreSQL connection string from Step 2 |
   | `JWT_SECRET` | From Step 1 |
   | `SIGNALING_SECRET` | From Step 1 (must match signaling server) |
   | `TURN_SECRET` | From Step 1 |
   | `APP_BASE_URL` | `https://yourdomain.com` (no trailing slash) |
   | `RESEND_API_KEY` | From Step 5 below |
   | `EMAIL_FROM` | `Remotely <no-reply@yourdomain.com>` |
   | `NEXT_PUBLIC_SIGNALING_URL` | `wss://signaling.yourdomain.com` (from Step 4) |
   | `NEXT_PUBLIC_STUN_URIS` | `stun:stun.l.google.com:19302` |
   | `NEXT_PUBLIC_TURN_URIS` | `turn:turn.yourdomain.com:3478` (from Step 6) |
   | `UPSTASH_REDIS_REST_URL` | From Step 7 below |
   | `UPSTASH_REDIS_REST_TOKEN` | From Step 7 below |
   | `NEXT_PUBLIC_SENTRY_DSN` | From Step 8 (optional) |
   | `SENTRY_DSN` | From Step 8 (optional) |
   | `RECORDING_MASTER_KEY` | From Step 1 (only needed if recording is enabled) |

4. Deploy. Vercel will run `npm run build` automatically.

**Alternative: Fly.io**
```bash
cd web
fly launch
fly secrets set JWT_SECRET=... SIGNALING_SECRET=... # etc.
fly deploy
```

---

## Step 4 — Signaling server: Fly.io (10 min)

The signaling server needs to hold long-lived WebSocket connections — Fly.io is the best free fit.

```bash
cd signaling
fly launch --no-deploy    # accept defaults, name it e.g. "remotely-signal"
fly secrets set SIGNALING_SECRET=<same value from Step 1> NODE_ENV=production
fly deploy
```

Your signaling server will be at `wss://remotely-signal.fly.dev`. Use that (or a custom domain) for `NEXT_PUBLIC_SIGNALING_URL` in Step 3.

**Verify it's running:**
```bash
curl https://remotely-signal.fly.dev/healthz
# should return: ok
```

---

## Step 5 — Email: Resend (5 min)

Without this, email verification links are never sent to users.

1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails/month).
2. Add and verify your domain (takes ~5 min with DNS records).
3. Create an API key → copy it.
4. Set `RESEND_API_KEY` and `EMAIL_FROM` in your hosting environment (Step 3 table).

---

## Step 6 — TURN server: coturn (15 min, ~$5/mo)

Without TURN, ~20% of users on corporate or strict-NAT networks can't connect at all.

**Cheapest option: Hetzner CX11 (€4.51/mo) or DigitalOcean $4 droplet — Ubuntu 22.04**

```bash
sudo apt update && sudo apt install -y coturn certbot

# Get a TLS cert for turn.yourdomain.com
sudo certbot certonly --standalone -d turn.yourdomain.com

sudo nano /etc/turnserver.conf
```

Paste this config (replace placeholders):

```
listening-port=3478
tls-listening-port=5349
external-ip=YOUR.PUBLIC.IP
realm=yourdomain.com
fingerprint
use-auth-secret
static-auth-secret=TURN_SECRET_FROM_STEP_1
no-stdout-log
log-file=/var/log/coturn.log
cert=/etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.yourdomain.com/privkey.pem
```

```bash
sudo systemctl enable coturn && sudo systemctl start coturn
# Open ports in your firewall:
sudo ufw allow 3478/udp && sudo ufw allow 3478/tcp && sudo ufw allow 5349/tcp
```

Set `NEXT_PUBLIC_TURN_URIS=turn:turn.yourdomain.com:3478,turns:turn.yourdomain.com:5349` and `TURN_SECRET` in your web app environment.

> Note: In `fly.toml` or your DNS, point `turn.yourdomain.com` directly at the VPS IP — **do not proxy through Cloudflare** (coturn needs raw UDP).

---

## Step 7 — Rate limiting: Upstash Redis (5 min)

Without this, the in-memory rate limiter is per-instance and useless on serverless/multi-instance hosts.

1. Sign up at [upstash.com](https://upstash.com) → Create Database → choose Redis → pick a region close to your web host.
2. Copy the **REST URL** and **REST Token** from the database details page.
3. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in your web app environment.

Free tier: 10,000 requests/day — more than enough for most workloads.

---

## Step 8 — Error tracking: Sentry (5 min, optional but recommended)

1. Sign up at [sentry.io](https://sentry.io) → Create Project → choose Next.js.
2. Copy the DSN from the project settings.
3. Set `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` in your web app environment.
4. For the signaling server, set `SENTRY_DSN` as a Fly secret:
   ```bash
   fly secrets set SENTRY_DSN=https://... --app remotely-signal
   ```

---

## Step 9 — Domain + HTTPS (10 min)

1. Buy a domain (Namecheap, Cloudflare Registrar, etc.)
2. Add it to [Cloudflare](https://cloudflare.com) for free TLS + DDoS protection.
3. DNS records to create:

   | Subdomain | Type | Points to | Proxy |
   |---|---|---|---|
   | `app` | CNAME | your Vercel/Fly deployment | ✅ Proxied |
   | `signaling` | CNAME | your Fly signaling app | ✅ Proxied |
   | `turn` | A | your coturn VPS IP | ❌ DNS only (required for UDP) |

4. In Vercel, add `app.yourdomain.com` as a custom domain.
5. Update `APP_BASE_URL` and `NEXT_PUBLIC_SIGNALING_URL` to use your real domain.

---

## Step 10 — Build and sign the Electron client (variable time)

The client installer needs to point at your production URLs before building.

```powershell
cd client
$env:REMOTELY_API_BASE      = "https://app.yourdomain.com"
$env:REMOTELY_SIGNALING_URL = "wss://signaling.yourdomain.com"
$env:REMOTELY_ICE_SERVERS   = "stun:stun.l.google.com:19302"
npm run dist
```

**Code signing** (strongly recommended — without it Windows SmartScreen blocks the installer):

- Standard cert (Sectigo/DigiCert): ~$70–120/yr. Works but takes ~30 days to build SmartScreen reputation.
- EV cert: ~$300/yr. Instant reputation. Worth it for public distribution.

Once you have a `.pfx`:
```powershell
$env:CSC_LINK          = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD  = "your-pfx-password"
npm run dist
```

Or for CI releases: add `CSC_LINK` (base64-encoded pfx) and `CSC_KEY_PASSWORD` as GitHub Actions secrets — the release workflow picks them up automatically.

---

## Pre-launch checklist

- [ ] All 4 secrets generated and set (JWT_SECRET, SIGNALING_SECRET, TURN_SECRET, RECORDING_MASTER_KEY)
- [ ] PostgreSQL provisioned, `prisma/schema.prisma` provider changed to `"postgresql"`, `migrate deploy` run
- [ ] Web app deployed and environment variables set
- [ ] Signaling server deployed to Fly.io, `/healthz` returns `ok`
- [ ] `NEXT_PUBLIC_SIGNALING_URL` uses `wss://` (not `ws://`)
- [ ] Resend configured, a test signup email arrives in inbox
- [ ] Upstash Redis connected (check logs — no "in-memory limiter" warning)
- [ ] TURN server running, ports 3478/5349 open
- [ ] Sentry DSN set, a test error appears in your Sentry dashboard
- [ ] Domain live on HTTPS, `turn.` subdomain on DNS-only
- [ ] Electron installer built with production URLs, SmartScreen test passed
- [ ] Privacy policy and Terms of Service pages added (required for public signups)
