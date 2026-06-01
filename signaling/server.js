/**
 * RemoteConnectMe signaling server.
 *
 * Responsibilities:
 *  - Accept WebSocket connections from web viewers and Electron hosts
 *  - Authenticate them with a short-lived JWT minted by the web app
 *  - Track which devices are online (so /api/devices can show status)
 *  - Relay SDP offers/answers and ICE candidates between viewer and host
 *
 * It does NOT see the screen stream, input events, or file transfers — those
 * travel peer-to-peer over WebRTC once the handshake completes.
 *
 * Optional Sentry: set SENTRY_DSN to enable error reporting. Gracefully
 * no-ops if @sentry/node isn't installed.
 *
 * Protocol (all messages are JSON over a single WebSocket):
 *
 *  Client -> Server, sent first:
 *    { type: "hello", token: "<JWT>" }
 *      JWT payload must contain: { sub: userId, role: "host"|"viewer", deviceId }
 *
 *  Server -> Client:
 *    { type: "ready" }                  // hello accepted
 *    { type: "error", message: string } // anything went wrong
 *    { type: "peer-online" | "peer-offline" }
 *
 *  Viewer -> Server:
 *    { type: "signal", payload: <RTCSessionDescription | RTCIceCandidate> }
 *      Server forwards to the host registered for the same deviceId.
 *
 *  Host -> Server:
 *    { type: "signal", payload: ... }
 *      Server forwards to the viewer for that deviceId.
 *
 *  Host -> Server (status pings, optional):
 *    { type: "ping" }  -> server responds { type: "pong" }
 *
 *  Either -> Server:
 *    { type: "bye" }   -> server closes both sides of the session
 *
 *  Host -> Server:
 *    { type: "reject", reason?: string }
 *      Sent when the host's local user declined an attended-mode session.
 *      Server forwards { type: "error", message: reason } to the viewer
 *      (which already knows how to render an error state) and closes the
 *      viewer socket; the host socket stays open so the next viewer attempt
 *      can be approved without re-pairing.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

// ---- Optional Sentry ----
let Sentry = null;
try {
  if (process.env.SENTRY_DSN) {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      environment: process.env.NODE_ENV || 'production',
    });
    console.log('[signaling] sentry enabled');
  }
} catch (e) {
  console.warn('[signaling] sentry init skipped:', e.message);
}
function captureError(e) { try { if (Sentry) Sentry.captureException(e); } catch {} }

const PORT = parseInt(process.env.PORT || '8787', 10);

const DEV_SIGNALING_SECRET = 'dev-signaling-secret-change-me';
const _rawSignalingSecret = process.env.SIGNALING_SECRET;
if (!_rawSignalingSecret || _rawSignalingSecret === DEV_SIGNALING_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[signaling] FATAL: SIGNALING_SECRET is missing or still set to the dev placeholder.');
    console.error('[signaling] Generate one with: openssl rand -hex 32');
    process.exit(1);
  }
  console.warn('[signaling] WARNING: SIGNALING_SECRET not set — using insecure dev value. Never do this in production.');
}
const SIGNALING_SECRET = _rawSignalingSecret || DEV_SIGNALING_SECRET;
const HEARTBEAT_MS = 30000;

// Maps deviceId -> { host: ws | null, viewer: ws | null }
const sessions = new Map();

function getSession(deviceId) {
  if (!sessions.has(deviceId)) sessions.set(deviceId, { host: null, viewer: null });
  return sessions.get(deviceId);
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function disconnectPeer(deviceId, role) {
  const s = sessions.get(deviceId);
  if (!s) return;
  s[role] = null;
  const other = role === 'host' ? s.viewer : s.host;
  if (other) send(other, { type: 'peer-offline' });
  if (!s.host && !s.viewer) sessions.delete(deviceId);
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, _req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let authed = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: 'error', message: 'invalid json' }); }

    if (!authed) {
      if (msg.type !== 'hello' || !msg.token) {
        send(ws, { type: 'error', message: 'expected hello with token' });
        return ws.close(4001, 'unauthenticated');
      }
      let payload;
      try { payload = jwt.verify(msg.token, SIGNALING_SECRET); }
      catch (e) {
        send(ws, { type: 'error', message: 'invalid token' });
        return ws.close(4001, 'invalid token');
      }
      const { sub: userId, role, deviceId } = payload;
      if (!userId || !deviceId || !['host', 'viewer'].includes(role)) {
        send(ws, { type: 'error', message: 'malformed token payload' });
        return ws.close(4001, 'bad payload');
      }
      authed = { userId, role, deviceId };

      const s = getSession(deviceId);
      if (s[role]) {
        try { s[role].close(4002, 'replaced'); } catch {}
      }
      s[role] = ws;
      send(ws, { type: 'ready' });

      const other = role === 'host' ? s.viewer : s.host;
      if (other) {
        send(other, { type: 'peer-online' });
        send(ws, { type: 'peer-online' });
      }
      console.log('[signaling] ' + role + ' connected for device ' + deviceId + ' (user ' + userId + ')');
      return;
    }

    if (msg.type === 'ping') return send(ws, { type: 'pong' });

    if (msg.type === 'signal') {
      const s = sessions.get(authed.deviceId);
      if (!s) return;
      const target = authed.role === 'host' ? s.viewer : s.host;
      if (!target) return send(ws, { type: 'peer-offline' });
      send(target, { type: 'signal', payload: msg.payload });
      return;
    }

    if (msg.type === 'reject') {
      // Host-only: declines the current viewer's connection attempt.
      if (authed.role !== 'host') {
        return send(ws, { type: 'error', message: 'only the host can reject' });
      }
      const s = sessions.get(authed.deviceId);
      const reason = (typeof msg.reason === 'string' && msg.reason) || 'host declined the connection';
      if (s && s.viewer) {
        send(s.viewer, { type: 'error', message: reason });
        try { s.viewer.close(4003, 'rejected'); } catch {}
        s.viewer = null;
      }
      console.log('[signaling] host rejected viewer for device ' + authed.deviceId);
      return;
    }

    if (msg.type === 'bye') {
      const s = sessions.get(authed.deviceId);
      if (s) {
        const other = authed.role === 'host' ? s.viewer : s.host;
        if (other) { send(other, { type: 'peer-offline' }); try { other.close(); } catch {} }
      }
      try { ws.close(); } catch {}
      return;
    }

    send(ws, { type: 'error', message: 'unknown message type' });
  });

  ws.on('close', () => {
    if (authed) {
      console.log('[signaling] ' + authed.role + ' disconnected for device ' + authed.deviceId);
      disconnectPeer(authed.deviceId, authed.role);
    }
  });

  ws.on('error', (err) => {
    console.warn('[signaling] ws error', err.message);
    captureError(err);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

process.on('uncaughtException', (e) => { console.error('[signaling] uncaught', e); captureError(e); });
process.on('unhandledRejection', (e) => { console.error('[signaling] unhandled', e); captureError(e); });

server.listen(PORT, () => {
  console.log('[signaling] listening on ws://0.0.0.0:' + PORT);
});
