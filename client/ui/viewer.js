'use strict';
// RemoteConnectMe — built-in viewer
// Runs inside Electron with contextIsolation; uses window.remotely bridge.

const listView   = document.getElementById('list-view');
const viewerView = document.getElementById('viewer-view');
const devicesEl  = document.getElementById('devices');
const statusMsg  = document.getElementById('status-msg');
const viewerStatus = document.getElementById('viewer-status');
const overlayMsg   = document.getElementById('overlay-msg');
const remoteVideo  = document.getElementById('remote-video');
const disconnectBtn = document.getElementById('disconnect-btn');

let ws     = null;
let pc     = null;
let dc     = null;   // data channel for input
let currentDeviceId = null;

// ── Device List ──────────────────────────────────────────────────────────────

async function loadDevices() {
  devicesEl.innerHTML = '<div id="status-msg" style="color:rgba(255,255,255,.4);font-size:13px">Loading devices…</div>';
  try {
    const result = await window.remotely.getDevices();
    if (!result.ok) {
      devicesEl.innerHTML = `<div style="color:#f87171;font-size:13px">Error: ${result.error}</div>`;
      return;
    }
    const devices = result.devices;
    if (!devices.length) {
      devicesEl.innerHTML = '<div style="color:rgba(255,255,255,.4);font-size:13px">No devices found. Open the dashboard to check your devices.</div>';
      return;
    }
    devicesEl.innerHTML = '';
    devices.forEach((d) => {
      const card = document.createElement('div');
      card.className = 'device-card';
      const isOnline = d.status === 'online';
      card.innerHTML = `
        <div class="device-info">
          <div class="device-name">
            <span class="${isOnline ? 'online-dot' : 'offline-dot'}"></span>
            ${escHtml(d.name || d.deviceId)}
          </div>
          <div class="device-meta">${isOnline ? 'Online' : 'Offline'} &middot; ${escHtml(d.deviceId.slice(0, 8))}…</div>
        </div>
        <button class="connect-btn" ${isOnline ? '' : 'disabled'} data-id="${escHtml(d.deviceId)}">
          ${isOnline ? 'Connect' : 'Offline'}
        </button>`;
      devicesEl.appendChild(card);
    });
    devicesEl.querySelectorAll('.connect-btn:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => startViewer(btn.dataset.id));
    });
  } catch (e) {
    devicesEl.innerHTML = `<div style="color:#f87171;font-size:13px">Failed to load devices: ${e.message}</div>`;
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Viewer ───────────────────────────────────────────────────────────────────

async function startViewer(deviceId) {
  currentDeviceId = deviceId;
  listView.style.display  = 'none';
  viewerView.style.display = 'flex';
  overlayMsg.textContent = 'Fetching credentials…';
  viewerStatus.textContent = 'Connecting…';
  disconnectBtn.style.display = 'none';

  let iceServers;
  try {
    const turnResult = await window.remotely.getTurnCredentials();
    iceServers = turnResult.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
  } catch {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  let viewToken;
  try {
    const tokenResult = await window.remotely.getViewToken(deviceId);
    if (!tokenResult.ok) throw new Error(tokenResult.error);
    viewToken = tokenResult.token;
  } catch (e) {
    overlayMsg.textContent = `Error: ${e.message}`;
    viewerStatus.textContent = 'Failed';
    return;
  }

  const cfg = await window.remotely.config();
  const SIGNALING_URL = cfg.signalingUrl;

  overlayMsg.textContent = 'Connecting to host…';
  viewerStatus.textContent = 'Connecting…';

  // Create PeerConnection before WebSocket so it's never null when offer arrives
  pc = new RTCPeerConnection({ iceServers });

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0] || new MediaStream([e.track]);
    overlayMsg.style.display = 'none';
    viewerStatus.textContent = `Streaming · ${currentDeviceId.slice(0,8)}…`;
    disconnectBtn.style.display = '';
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      overlayMsg.textContent = 'Connection lost. Go back and reconnect.';
      overlayMsg.style.display = '';
      viewerStatus.textContent = 'Disconnected';
    }
  };

  pc.ondatachannel = (e) => { dc = e.channel; };

  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'viewer', deviceId, token: viewToken }));
  };

  ws.onmessage = async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'ready') {
      // Host is online — create offer
      viewerStatus.textContent = 'Negotiating…';
      pc.onicecandidate = (e) => {
        if (e.candidate) ws.send(JSON.stringify({ type: 'signal', payload: { type: 'candidate', candidate: e.candidate } }));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'signal', payload: { type: 'offer', sdp: offer.sdp } }));
    } else if (msg.type === 'signal') {
      const p = msg.payload;
      if (p.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
      } else if (p.type === 'candidate' && p.candidate) {
        try { await pc.addIceCandidate(p.candidate); } catch {}
      }
    } else if (msg.type === 'bye' || msg.type === 'reject') {
      overlayMsg.textContent = msg.type === 'reject' ? 'Host declined the connection.' : 'Host disconnected.';
      overlayMsg.style.display = '';
      viewerStatus.textContent = 'Disconnected';
    } else if (msg.type === 'host-offline') {
      overlayMsg.textContent = 'Host is offline.';
      overlayMsg.style.display = '';
      viewerStatus.textContent = 'Host offline';
    }
  };

  ws.onclose = () => {
    if (viewerStatus.textContent === 'Connecting…' || viewerStatus.textContent === 'Negotiating…') {
      overlayMsg.textContent = 'Signaling server disconnected. Try again.';
      overlayMsg.style.display = '';
      viewerStatus.textContent = 'Disconnected';
    }
  };

  // Input forwarding
  remoteVideo.addEventListener('mousemove',  onMouseMove);
  remoteVideo.addEventListener('mousedown',  onMouseDown);
  remoteVideo.addEventListener('mouseup',    onMouseUp);
  remoteVideo.addEventListener('contextmenu',(e) => e.preventDefault());
  remoteVideo.addEventListener('wheel',      onWheel, { passive: true });
  remoteVideo.addEventListener('keydown',    onKeyDown);
  remoteVideo.setAttribute('tabindex', '0');
}

function sendInput(msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', payload: { type: 'input', ...msg } }));
  }
}

function onMouseMove(e) {
  const r = e.target.getBoundingClientRect();
  sendInput({ kind: 'mouse', op: 'move', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
}
function onMouseDown(e) {
  e.target.focus();
  sendInput({ kind: 'mouse', op: 'down', button: e.button });
}
function onMouseUp(e) {
  sendInput({ kind: 'mouse', op: 'up', button: e.button });
}
function onWheel(e) {
  sendInput({ kind: 'wheel', dx: e.deltaX, dy: e.deltaY });
}
function onKeyDown(e) {
  e.preventDefault();
  sendInput({ kind: 'key', op: 'down', code: e.code, key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
}

function disconnect() {
  try { ws && ws.close(); } catch {}
  try { pc && pc.close(); } catch {}
  ws = null; pc = null; dc = null;
  remoteVideo.srcObject = null;
  viewerStatus.textContent = 'Disconnected';
  overlayMsg.textContent = 'Disconnected.';
  overlayMsg.style.display = '';
  disconnectBtn.style.display = 'none';
  // remove input listeners
  ['mousemove','mousedown','mouseup','contextmenu','wheel','keydown'].forEach((ev) => {
    remoteVideo.removeEventListener(ev, window[`on${ev.charAt(0).toUpperCase()}${ev.slice(1)}`]);
  });
}

function backToList() {
  disconnect();
  viewerView.style.display = 'none';
  listView.style.display   = 'flex';
  overlayMsg.style.display = '';
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.getElementById('video-wrap').requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

// Init
loadDevices();
