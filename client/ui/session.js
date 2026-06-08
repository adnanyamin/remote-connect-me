/**
 * Session worker (offscreen renderer):
 *   - capture screen via desktopCapturer (proxied through preload)
 *   - keep a WebSocket open to the signaling server as the host
 *   - on peer-online, fetch fresh TURN creds, build an RTCPeerConnection,
 *     attach the screen track, create an offer, send it to the viewer
 *   - relay ICE candidates via signaling
 *   - data channel:
 *       <- input events    (forwarded to main via IPC -> nut-js injection)
 *       <- select-source   (replaceTrack to a different display)
 *       <- file-meta/eof + binary chunks (saved to %USERPROFILE%/Downloads)
 *       <- clipboard.get / clipboard.set (sync host OS clipboard with viewer)
 *       -> sources         (sent on dc open so viewer can render a monitor picker)
 *       -> file-ack        (after a file lands on disk)
 *       -> clipboard.value (in response to clipboard.get)
 *   - adaptive bitrate: every 5s, watch remote-inbound-rtp packetsLost trend
 *     and halve/restore RTCRtpSender maxBitrate
 */

const log = (m) => window.remotely.log(m);
const setState = (s) => window.remotely.log('STATE: ' + s);

const HOST_MAX_BITRATE = 6_000_000;   // 6 Mbps cap by default
const HOST_MIN_BITRATE = 500_000;     // floor at 500 kbps
const CLIPBOARD_MAX_BYTES = 256 * 1024;

let stream = null;
let pc = null;
let dc = null;
let ws = null;
let cfg = null;
let backoff = 1000;
let videoSender = null;
let currentSourceId = null;
let adaptiveTimer = null;
let adaptiveTarget = HOST_MAX_BITRATE;
// Cached per (re)connect from /api/client/connect-token. Tells us whether to
// prompt the local user before starting the WebRTC offer on peer-online.
let requireApproval = true;
let deviceId = null;

// ---- Screen capture ----

async function captureStream(sourceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30,
        maxWidth: 1920, maxHeight: 1080,
      },
    },
  });
}

async function ensureStream() {
  if (stream) return stream;
  const sources = await window.remotely.getScreenSources();
  if (!sources.length) throw new Error('No screen sources');
  currentSourceId = sources[0].id;
  await window.remotely.setActiveSource(currentSourceId);
  stream = await captureStream(currentSourceId);
  document.getElementById('local').srcObject = stream;
  return stream;
}

async function switchSource(sourceId) {
  if (sourceId === currentSourceId) return;
  log('switching capture to ' + sourceId);
  const next = await captureStream(sourceId);
  const newTrack = next.getVideoTracks()[0];
  if (videoSender) await videoSender.replaceTrack(newTrack);
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = next;
  currentSourceId = sourceId;
  await window.remotely.setActiveSource(sourceId);
  document.getElementById('local').srcObject = stream;
  await applySendParams(adaptiveTarget);
}

// ---- Adaptive bitrate ----

async function applySendParams(maxBitrate) {
  if (!videoSender) return;
  const params = videoSender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  params.degradationPreference = 'maintain-resolution';
  try { await videoSender.setParameters(params); }
  catch (e) { log('setParameters failed: ' + e.message); }
}

function startAdaptiveLoop() {
  if (adaptiveTimer) clearInterval(adaptiveTimer);
  let lastLost = 0;
  let healingTicks = 0;
  adaptiveTimer = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let lost = 0; let present = false;
      stats.forEach((r) => {
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
          lost = r.packetsLost || 0; present = true;
        }
      });
      if (!present) return;
      const delta = lost - lastLost;
      lastLost = lost;
      if (delta > 10) {
        adaptiveTarget = Math.max(HOST_MIN_BITRATE, Math.floor(adaptiveTarget / 2));
        await applySendParams(adaptiveTarget);
        healingTicks = 0;
        log(`adaptive: loss climbing (+${delta}) -> ${adaptiveTarget}`);
      } else if (delta === 0) {
        healingTicks++;
        if (healingTicks >= 6 && adaptiveTarget < HOST_MAX_BITRATE) {
          adaptiveTarget = Math.min(HOST_MAX_BITRATE, Math.floor(adaptiveTarget * 1.25));
          await applySendParams(adaptiveTarget);
          healingTicks = 0;
          log(`adaptive: healthy -> ${adaptiveTarget}`);
        }
      }
    } catch {}
  }, 5000);
}

function stopAdaptiveLoop() {
  if (adaptiveTimer) clearInterval(adaptiveTimer);
  adaptiveTimer = null;
}

// ---- Peer connection ----

async function newPC() {
  const { iceServers } = await window.remotely.getTurnCredentials();
  const c = new RTCPeerConnection({ iceServers });
  c.addEventListener('icecandidate', (e) => {
    if (e.candidate) ws?.send(JSON.stringify({ type: 'signal', payload: { candidate: e.candidate } }));
  });
  c.addEventListener('iceconnectionstatechange', () => {
    log('ice: ' + c.iceConnectionState);
    if (c.iceConnectionState === 'failed') setState('error: ice failed');
    if (c.iceConnectionState === 'connected') setState('streaming');
    if (c.iceConnectionState === 'closed' || c.iceConnectionState === 'disconnected') {
      stopAdaptiveLoop();
    }
  });
  return c;
}

async function startSession() {
  if (pc) { try { pc.close(); } catch {} pc = null; videoSender = null; }
  pc = await newPC();
  await ensureStream();
  const videoTrack = stream.getVideoTracks()[0];
  videoSender = pc.addTrack(videoTrack, stream);
  adaptiveTarget = HOST_MAX_BITRATE;
  await applySendParams(adaptiveTarget);

  dc = pc.createDataChannel('control', { ordered: true });
  dc.addEventListener('open', async () => {
    log('data channel open');
    const sources = await window.remotely.getScreenSources();
    dc.send(JSON.stringify({
      kind: 'sources', items: sources, activeId: currentSourceId,
    }));
  });
  dc.addEventListener('message', onDataMessage);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'signal', payload: { sdp: pc.localDescription } }));
  setState('offered, waiting for answer');
  startAdaptiveLoop();
}

// ---- Data channel messages ----

let incoming = null; // { name, size, received, chunks: Uint8Array[] }

async function onDataMessage(ev) {
  if (typeof ev.data === 'string') {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.kind === 'mouse' || msg.kind === 'wheel' || msg.kind === 'key') {
      return window.remotely.inject(msg);
    }
    if (msg.kind === 'select-source') {
      return switchSource(msg.sourceId).catch((e) => log('switchSource: ' + e.message));
    }
    if (msg.kind === 'file-meta') {
      incoming = { name: String(msg.name || 'file'), size: msg.size || 0, received: 0, chunks: [] };
      return;
    }
    if (msg.kind === 'file-eof') {
      if (!incoming) return;
      try {
        const total = new Uint8Array(incoming.received);
        let off = 0;
        for (const c of incoming.chunks) { total.set(c, off); off += c.byteLength; }
        const savedPath = await window.remotely.saveDownload(incoming.name, total);
        dc.send(JSON.stringify({ kind: 'file-ack', name: incoming.name, path: savedPath, size: incoming.received }));
        log(`saved file ${savedPath} (${incoming.received} bytes)`);
      } catch (e) {
        log('file save failed: ' + e.message);
        dc.send(JSON.stringify({ kind: 'file-ack', name: incoming?.name, error: e.message }));
      }
      incoming = null;
      return;
    }
    if (msg.kind === 'clipboard.get') {
      try {
        const text = await window.remotely.clipboardRead();
        const capped = (text || '').slice(0, CLIPBOARD_MAX_BYTES);
        dc.send(JSON.stringify({ kind: 'clipboard.value', text: capped }));
      } catch (e) { log('clipboard.read failed: ' + e.message); }
      return;
    }
    if (msg.kind === 'clipboard.set') {
      try {
        const text = String(msg.text || '').slice(0, CLIPBOARD_MAX_BYTES);
        await window.remotely.clipboardWrite(text);
      } catch (e) { log('clipboard.write failed: ' + e.message); }
      return;
    }
    return;
  }
  // Binary frame — part of an active file transfer.
  if (incoming) {
    const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(0);
    incoming.chunks.push(buf);
    incoming.received += buf.byteLength;
  }
}

// ---- Signaling ----

async function connectSignaling() {
  cfg = await window.remotely.config();
  setState('auth');
  let token;
  try {
    const ct = await window.remotely.getConnectToken();
    token = ct.token;
    deviceId = ct.deviceId;
    // requireApproval may legitimately be missing on older server builds;
    // default to true to be safe.
    requireApproval = ct.requireApproval !== false;
  }
  catch (e) { setState('error: ' + e.message); scheduleReconnect(); return; }

  setState('connecting');
  ws = new WebSocket(cfg.signalingUrl);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ready') { setState('connected'); backoff = 1000; }
    else if (msg.type === 'peer-online') {
      log('viewer connected');
      // Attended mode: prompt the local user before we publish a track or
      // open the data channel. The viewer sees its existing "waiting-host"
      // state while the dialog is open. On reject, signal the viewer via
      // the new 'reject' message; on accept, fall through to startSession.
      let approved = true;
      if (requireApproval) {
        setState('awaiting approval');
        try {
          approved = await window.remotely.requestSessionApproval({ deviceId });
        } catch (e) {
          log('approval prompt failed: ' + e.message);
          approved = false;
        }
        if (!approved) {
          log('session rejected by local user');
          try { ws?.send(JSON.stringify({ type: 'reject', reason: 'host declined the connection' })); } catch {}
          setState('rejected');
          return;
        }
      }
      log('starting session');
      try { await startSession(); }
      catch (e) { setState('error: ' + e.message); }
    }
    else if (msg.type === 'peer-offline') {
      setState('connected');
      stopAdaptiveLoop();
      try { pc?.close(); } catch {} pc = null; videoSender = null;
    }
    else if (msg.type === 'signal' && msg.payload?.sdp) {
      try { await pc.setRemoteDescription(msg.payload.sdp); }
      catch (e) { log('setRemoteDescription failed: ' + e.message); }
    }
    else if (msg.type === 'signal' && msg.payload?.candidate) {
      try { await pc?.addIceCandidate(msg.payload.candidate); }
      catch (e) { log('addIceCandidate failed: ' + e.message); }
    }
    else if (msg.type === 'error') {
      setState('error: ' + msg.message);
    }
  });
  ws.addEventListener('close', () => { setState('disconnected'); scheduleReconnect(); });
  ws.addEventListener('error', (e) => log('ws error: ' + (e.message || 'unknown')));
}

function scheduleReconnect() {
  setTimeout(() => { backoff = Math.min(backoff * 2, 30000); connectSignaling(); }, backoff);
}

// Disconnect command from the host UI
const { ipcRenderer } = require('electron');
ipcRenderer.on('disconnect', () => {
  log('Disconnected by local user.');
  if (pc) { try { pc.close(); } catch {} pc = null; videoSender = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  setState('connected'); // back to "waiting for viewer" state
  scheduleReconnect();
});

connectSignaling();
