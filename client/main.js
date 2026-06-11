'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session } = require('electron');
const path = require('path');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');

// ---- Config ----
const WEB_BASE   = process.env.REMOTELY_WEB_URL  || 'https://remoteconnectme-web.fly.dev';
const API_BASE   = WEB_BASE;
const PAIR_FILE  = path.join(app.getPath('userData'), 'pair.json');

// ---- Tray icon (embedded as base64 PNG so it always works) ----
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAC30lEQVR4nG2TTWhcZRSGn3Pud2fu' +
  'nUlCSaI16qKQNG3dlYJFBRORYl0IbgqVWLUNBKUdqFDdVnEnWQixWAPShXah4EY3ohDaQBfFVqxQ' +
  'lCRWMKaTxOkkaZvOTO79vuNijIbSd3UW5+c55/AKAJiAGMDg6NIzrpiOBR+GfJ4/FimougWN9KL5' +
  'bPL6pz2XttbIZjBwcKaojz80bqJv3m3FTq1JqeC50zAMh7iEciHLnYaz/s+/T819N9gCE+GQRQOP' +
  '4LRR/5Zi94Gir9l7r3aEhVtex7++J68MJ+ztd/bHkg/np5ralF6J8voPPul+aW6RHICBY8sTT1TM' +
  'dry+1NpXqZmZ2cxfuX0x1bCt+mluwwZHl1u7T5gNHlueANCdR6v7Rd3xvHHLi0gMsHrXeLRHGXku' +
  '4cpMxtC7db6cbrK3P+aFfcV4pV7zGsfHdx6t7lc0rqhLBQIgIgIIlBMB4Nf5nOkrLX6cyTCD3q5I' +
  'vPeoSwWNK84Iw+abYChAMEgLcGPRE0dw5PmU/j7Hk7tizGD6+galoqrPmhhhWMXos5BDezYYuEhY' +
  'WzdGP7rN71XPU3ti5mueyie3+W0+Jy2KBJ8hRp/jAQoByglcnc14bXyNsRdT3j+/TiszOktCCP/n' +
  'qglVUQdmtrWJD9Ddqczd9Fy7kXN6pEzm4V9ME3WYUFVBL0iUgBC4T5k3erqEz6cabN+mfHCkg8WV' +
  'gIsIEiUIekEJ2UTIGwYKtCl84D/MYNBVUt6evMPhoYSTL5dsoSZIaBohm9DZc32XLeRnXNoTmVkm' +
  'QFKAztImLBRjWF033vp4jdMjHdnJw71RbbV1ZvZc32XHIYsocypv1HcVOh4+sOFr9v3VVrhZ96rS' +
  'XjnPzbaVCVPXsmj8GwpvPOt/fnpH14cH95g+0Ez3sthJaJLGHgBRh0QJ2Ea+vJKfXfnql3fMhlsi' +
  'm0e9385xOhasbef2r9yCoBcJjcnZz7ZfEoFg7Zp/ABbpd09uLMPoAAAAAElFTkSuQmCC';

// ---- State ----
let tray        = null;
let pairWin     = null;
let sessionWin  = null;
let viewerWin   = null;
let paired      = false;
let pairData    = null;

function loadPair() {
  try {
    pairData = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8'));
    paired = !!(pairData.deviceKey && pairData.deviceId);
  } catch { paired = false; }
}

function savePair(data) {
  pairData = data;
  fs.writeFileSync(PAIR_FILE, JSON.stringify(data), 'utf8');
  paired = true;
}

// ---- API helpers ----
function apiGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + urlPath);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}


function apiPost(path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(API_BASE + path);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Authenticated POST using the paired device key as a Bearer token
function apiPostAuth(path, body = {}) {
  if (!pairData) return Promise.reject(new Error('Not paired'));
  return apiPost(path, body, { Authorization: `Bearer ${pairData.deviceKey}` });
}

// ---- Windows ----
function createPairWindow() {
  if (pairWin) { pairWin.focus(); return pairWin; }
  pairWin = new BrowserWindow({
    width: 500, height: 560,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Pair Device – RemoteConnectMe',
    autoHideMenuBar: true,
  });
  pairWin.loadFile(path.join(__dirname, 'ui', 'pair.html'));
  pairWin.on('closed', () => { pairWin = null; });
  return pairWin;
}

function createViewerWindow() {
  if (viewerWin) { viewerWin.focus(); return viewerWin; }
  viewerWin = new BrowserWindow({
    width: 1024, height: 700,
    minWidth: 640, minHeight: 420,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'RemoteConnectMe — Viewer',
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
  });
  viewerWin.loadFile(path.join(__dirname, 'ui', 'viewer.html'));
  viewerWin.on('closed', () => { viewerWin = null; });
  return viewerWin;
}

function createSessionWindow() {
  if (sessionWin) return sessionWin;
  sessionWin = new BrowserWindow({
    width: 400, height: 300,
    show: false,   // stays hidden — lives in tray only
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'RemoteConnectMe Session',
    autoHideMenuBar: true,
  });
  sessionWin.loadFile(path.join(__dirname, 'ui', 'session.html'));
  sessionWin.on('closed', () => { sessionWin = null; });
  return sessionWin;
}

// ---- Tray ----
function buildTray() {
  const img = nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_ICON_B64);
  tray = new Tray(img);
  tray.setToolTip('RemoteConnectMe');
  rebuildMenu();
}

function rebuildMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'RemoteConnectMe', enabled: false },
    { type: 'separator' },
    paired
      ? { label: 'Connect to a device…', click: () => createViewerWindow() }
      : { label: 'Pair device…', click: () => createPairWindow() },
    { type: 'separator' },
    paired
      ? { label: 'Unpair this device', click: () => { fs.unlinkSync(PAIR_FILE); app.relaunch(); app.exit(0); } }
      : { label: 'Open dashboard', click: () => shell.openExternal(WEB_BASE + '/dashboard') },
    { label: 'Open dashboard', click: () => shell.openExternal(WEB_BASE + '/dashboard') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ---- App lifecycle ----
app.whenReady().then(async () => {
  app.setLoginItemSettings({ openAtLogin: true });
  loadPair();
  buildTray();

  if (!paired) {
    createPairWindow();
  } else {
    createSessionWindow(); // silent background worker
  }
});

app.on('window-all-closed', (e) => {
  // Keep running in tray even when all windows close
  e.preventDefault();
});

// ---- IPC: Pair window ----

// Open browser to sign up, then auto-redirect back to /pair?callback=...
ipcMain.handle('browserSignup', async () => {
  let callbackServer = null;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/pair-callback') {
        const dk = u.searchParams.get('deviceKey');
        const di = u.searchParams.get('deviceId');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><script>window.close()</script><p>Device paired! You can close this tab.</p></body></html>');
        srv.close();
        if (dk && di) {
          savePair({ deviceKey: dk, deviceId: di });
          rebuildMenu();
          resolve({ ok: true });
          if (pairWin) pairWin.close();
          createSessionWindow();
        } else {
          resolve({ ok: false, error: 'Missing credentials in callback' });
        }
      } else {
        res.writeHead(404).end();
      }
    });
    const port = 47821;
    srv.listen(port, '127.0.0.1', () => {
      const callbackUrl = encodeURIComponent(`http://localhost:${port}/pair-callback`);
      const signupUrl = `${WEB_BASE}/signup?returnTo=${encodeURIComponent('/pair?callback=' + callbackUrl)}`;
      shell.openExternal(signupUrl);
    });
    callbackServer = srv;
    setTimeout(() => { try { srv.close(); } catch {} resolve({ ok: false, error: 'Timed out' }); }, 15 * 60 * 1000);
  });
});

// Browser-based login (already have account) — opens dashboard pair page
ipcMain.handle('browserPair', async () => {
  let srv = null;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/pair-callback') {
        const dk = u.searchParams.get('deviceKey');
        const di = u.searchParams.get('deviceId');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><script>window.close()</script><p>Paired! You may close this tab.</p></body></html>');
        server.close();
        if (dk && di) {
          savePair({ deviceKey: dk, deviceId: di });
          rebuildMenu();
          resolve({ ok: true });
          if (pairWin) pairWin.close();
          createSessionWindow();
        } else {
          resolve({ ok: false, error: 'Missing credentials' });
        }
      } else { res.writeHead(404).end(); }
    });
    const port = 47821;
    server.listen(port, '127.0.0.1', () => {
      const cb = encodeURIComponent(`http://localhost:${port}/pair-callback`);
      shell.openExternal(`${WEB_BASE}/pair?callback=${cb}`);
    });
    srv = server;
    setTimeout(() => { try { server.close(); } catch {} resolve({ ok: false, error: 'Timed out' }); }, 15 * 60 * 1000);
  });
});

// In-app login with email/password
ipcMain.handle('appLogin', async (_e, email, password) => {
  try {
    const r = await apiPost('/api/auth/login', { email, password });
    if (r.status !== 200) return { ok: false, error: r.body?.error || 'Login failed' };
    return { ok: true, emailOtpToken: r.body.emailOtpToken };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('appVerifyOtp', async (_e, emailOtpToken, code) => {
  try {
    const r = await apiPost('/api/auth/verify-otp', { emailOtpToken, code });
    if (r.status !== 200) return { ok: false, error: r.body?.error || 'Invalid code' };
    return { ok: true, sessionToken: r.body.sessionToken };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('appPair', async (_e, emailOtpToken, code, deviceName) => {
  try {
    const r = await apiPost('/api/client/app-pair', { emailOtpToken, code, deviceName });
    if (r.status !== 200) return { ok: false, error: r.body?.error || 'Pairing failed' };
    savePair({ deviceKey: r.body.deviceKey, deviceId: r.body.deviceId });
    rebuildMenu();
    if (pairWin) pairWin.close();
    createSessionWindow();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('getHostname', () => os.hostname());
ipcMain.handle('openExternal', (_e, url) => shell.openExternal(url));

// ---- IPC: Session window ----

ipcMain.handle('config', () => ({
  signalingUrl: process.env.REMOTELY_SIGNAL_URL || 'wss://remotely-signal.fly.dev',
  webBase: WEB_BASE,
}));

ipcMain.handle('getConnectToken', async () => {
  if (!pairData) throw new Error('Not paired');
  const r = await apiPostAuth('/api/client/connect-token');
  if (r.status !== 200) throw new Error(r.body?.error || 'connect-token failed');
  return r.body;
});

ipcMain.handle('getTurnCredentials', async () => {
  if (!pairData) return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  try {
    const r = await apiPostAuth('/api/turn-credentials');
    if (r.status === 200) return r.body;
  } catch {}
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
});

ipcMain.handle('log', (_e, msg) => console.log('[session]', msg));

ipcMain.handle('getScreenSources', async () => {
  const { desktopCapturer } = require('electron');
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return srcs.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.handle('setActiveSource', (_e, sourceId) => { /* for future status display */ });

ipcMain.handle('inject', (_e, msg) => {
  // Input injection via nut-js
  try {
    const { mouse, keyboard, Button, Key } = require('@nut-tree-fork/nut-js');
    if (msg.kind === 'mouse') {
      if (msg.op === 'move') {
        const { screen } = require('@nut-tree-fork/nut-js');
        screen.width().then((w) => screen.height().then((h) => {
          mouse.setPosition({ x: Math.round(msg.x * w), y: Math.round(msg.y * h) });
        }));
      } else {
        const btn = msg.button === 2 ? Button.RIGHT : Button.LEFT;
        if (msg.op === 'down') mouse.pressButton(btn);
        else mouse.releaseButton(btn);
      }
    } else if (msg.kind === 'wheel') {
      mouse.scrollDown(Math.round(msg.dy / 100));
    } else if (msg.kind === 'key') {
      // Basic key mapping
    }
  } catch (e) { console.warn('inject error:', e.message); }
});

ipcMain.handle('saveDownload', async (_e, name, bufArray) => {
  const buf = Buffer.from(bufArray);
  const dest = path.join(os.homedir(), 'Downloads', name);
  fs.writeFileSync(dest, buf);
  return dest;
});

ipcMain.handle('clipboardRead', () => {
  const { clipboard } = require('electron');
  return clipboard.readText();
});

ipcMain.handle('clipboardWrite', (_e, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text);
});

ipcMain.on('disconnectSession', () => {
  if (sessionWin) sessionWin.webContents.send('disconnect');
});

// ---- IPC: Viewer window ----

// Returns list of devices paired to this account
ipcMain.handle('getDevices', async () => {
  if (!pairData) return { ok: false, error: 'Not paired' };
  try {
    const r = await apiPostAuth('/api/client/devices');
    if (r.status !== 200) return { ok: false, error: r.body?.error || 'Failed to load devices' };
    return { ok: true, devices: r.body.devices || r.body };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Returns a short-lived token that lets viewer connect to a specific device
ipcMain.handle('getViewToken', async (_e, targetDeviceId) => {
  if (!pairData) return { ok: false, error: 'Not paired' };
  try {
    const r = await apiPostAuth('/api/client/view-token', { targetDeviceId });
    if (r.status !== 200) return { ok: false, error: r.body?.error || 'Failed to get view token' };
    return { ok: true, token: r.body.token };
  } catch (e) { return { ok: false, error: e.message }; }
});
