# Remotely — open-source LogMeIn-style remote desktop

A self-hostable remote-desktop service. Three pieces:

| Folder        | What it is                                                                    |
| ------------- | ----------------------------------------------------------------------------- |
| `web/`        | Next.js web app — sign up, register devices, connect to them in the browser   |
| `signaling/`  | Node WebSocket server that relays WebRTC signaling between viewer and host    |
| `client/`     | Electron Windows client — installed on the machine you want to control        |

The actual screen stream + input + file transfer travels **peer-to-peer over WebRTC**. The signaling server only carries the SDP handshake; once the connection is established, traffic goes direct (or via a TURN relay if both peers are behind strict NAT). WebRTC is end-to-end encrypted by design.

## Architecture

```
┌──────────────┐  HTTPS   ┌────────────────┐  HTTPS   ┌──────────────┐
│   Browser    │ ───────► │   Next.js web  │ ◄─────── │  Electron    │
│   (viewer)   │          │  (auth, DB)    │          │   client     │
└──────┬───────┘          └────────────────┘          └──────┬───────┘
       │                                                     │
       │            WebSocket (signaling, JWT auth)          │
       └─────────────────► signaling/ ◄─────────────────────┘
       │                                                     │
       │            WebRTC P2P (screen + input + files)      │
       └─────────────────────────────────────────────────────┘
                                                ↑
                                       coturn (TURN/STUN)
                                       used only when P2P fails
```

## Quick start (local dev)

Requires Node 20+, npm, Windows build tools (`npm i -g windows-build-tools` or VS 2022 with C++ workload — needed by the client's native input module).

```powershell
# 1. signaling server (terminal 1)
cd signaling
npm install
npm start                           # listens on ws://localhost:8787

# 2. web app (terminal 2)
cd web
cp .env.example .env.local
npm install
npx prisma migrate dev --name init
npm run dev                         # http://localhost:3000

# 3. Electron client (terminal 3)
cd client
npm install
npm start
```

Then in the browser:
1. Open http://localhost:3000 → sign up
2. Click **Add device** → copy the pairing code
3. In the Electron client, paste the pairing code and click **Pair**
4. Back in the browser, the device shows as **Online** → click **Connect**

## Going to production

To put this on the public web for free use:

1. **Web + DB**: deploy `web/` to Vercel or Fly.io. Switch Prisma from SQLite to Postgres (already supported via `DATABASE_URL`).
2. **Signaling**: deploy `signaling/` to Fly.io or Render. It needs a stable WebSocket endpoint.
3. **TURN server**: install [coturn](https://github.com/coturn/coturn) on a small VPS (DigitalOcean droplet, $6/mo). Required for users behind symmetric NAT. Without TURN, ~80% of connections will work; with TURN, ~99%.
4. **Windows installer signing**: get an EV code-signing cert (~$300/yr) so SmartScreen doesn't block your installer. Without one, users will see a scary "unrecognized app" warning.
5. **Domain + HTTPS**: any registrar + Cloudflare for free TLS in front of everything.

See `docs/DEPLOY.md` for step-by-step.

## Security notes (read before shipping)

- All client⇄server auth is JWT. Rotate `JWT_SECRET` and `SIGNALING_SECRET` per environment.
- Device pairing codes are single-use, expire in 10 minutes.
- WebRTC traffic is DTLS-encrypted end-to-end. The signaling server **cannot** see screen/input/file traffic.
- The Electron client stores its long-lived device key in the OS keychain via `keytar`.
- Unattended access requires the user to explicitly enable it after first pair.
- Wave 0 hardening is wired in: per-IP/email rate limiting on auth + pair endpoints, email verification at signup (blocks pairing & connecting until verified), append-only audit log of every auth + device event, and short-lived per-user TURN credentials minted by `/api/turn-credentials`. See `docs/RUNBOOK.md` for secret rotation, `docs/ROADMAP.md` for what's still queued (MFA, RBAC, session recording, code-signing, external security review).

## License

MIT — do whatever you want with it.
