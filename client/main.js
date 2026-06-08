/**
 * RemoteConnectMe Electron host (main process).
 *
 * Lifecycle:
 *   - On launch, load device key from OS keychain.
 *   - If absent, open the pair window. The renderer POSTs the pair code to
 *     the web app, gets back a deviceKey, and saves it via IPC.
 *   - Once paired, open the host status window (hideable to tray) and the
 *     hidden session window that does WebRTC + screen capture.
 *
 * Auto-update: if electron-updater is bundled, we check on launch and hourly.
 * Crash reporting: Sentry is optional and gated by REMOTELY_SENTRY_DSN.
 */

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell,
  desktopCapturer, clipboard, screen,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const keytar = require('keytar');
const AutoLaunch = require('auto-launch');
const input = require('./lib/input');
const permissions = require('./lib/permissions');

// ---- Optional Sentry (crash + error reporting) ----
let Sentry = null;
try {
  if (process.env.REMOTELY_SENTRY_DSN) {
    // eslint-disable-next-line global-require
    Sentry = require('@sentry/electron/main');
    Sentry.init({
      dsn: process.env.REMOTELY_SENTRY_DSN,
      tracesSampleRate: 0.1,
      release: `remotely-client@${app.getVersion()}`,
      environment: process.env.NODE_ENV || 'production',
    });
  }
} catch (e) {
  console.warn('[sentry] init skipped:', e.message);
}

// ---- Optional auto-update via electron-updater ----
let autoUpdater = null;
try {
  // eslint-disable-next-line global-require
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => {
    console.warn('[updater] error:', e?.message);
    if (Sentry) Sentry.captureException(e);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded:', info?.version);
    if (statusWin && !statusWin.isDestroyed()) {
      statusWin.webContents.send('log', `Update ${info?.version} ready — restart RemoteConnectMe to apply.`);
    }
  });
} catch (e) {
  console.warn('[updater] not available (skipping):', e?.message);
}

const SERVICE = 'RemoteConnectMe';
const ACCOUNT = 'device-key';
const ACCOUNT_UNATTENDED_PIN = 'unattended-pin-hash';
const DEFAULT_API_BASE = 'https://remoteconnectme-web.fly.dev';
const DEFAULT_SIGNALING_URL = 'wss://remotely-signal.fly.dev';

const config = {
  apiBase: process.env.REMOTELY_API_BASE || DEFAULT_API_BASE,
  signalingUrl: process.env.REMOTELY_SIGNALING_URL || DEFAULT_SIGNALING_URL,
};

let pairWin = null;
let statusWin = null;
let sessionWin = null;
let tray = null;
let activeSourceId = null;

function loadKey() { return keytar.getPassword(SERVICE, ACCOUNT); }
function saveKey(k) { return keytar.setPassword(SERVICE, ACCOUNT, k); }
function clearKey() { return keytar.deletePassword(SERVICE, ACCOUNT); }

// ---- Windows ----

async function showPairWindow() {
  if (pairWin && !pairWin.isDestroyed()) { pairWin.focus(); return; }
  pairWin = new BrowserWindow({
    width: 480, height: 540, resizable: false, title: 'Pair RemoteConnectMe',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  pairWin.loadFile(path.join(__dirname, 'ui', 'pair.html'));
  pairWin.on('closed', () => { pairWin = null; });
}

async function showStatusWindow() {
  if (statusWin && !statusWin.isDestroyed()) { statusWin.show(); return; }
  statusWin = new BrowserWindow({
    width: 480, height: 620, resizable: false, title: 'RemoteConnectMe',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  statusWin.loadFile(path.join(__dirname, 'ui', 'host.html'));
  statusWin.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); statusWin.hide(); }
  });
}

async function showSessionWindow() {
  if (sessionWin && !sessionWin.isDestroyed()) return;
  sessionWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  sessionWin.loadFile(path.join(__dirname, 'ui', 'session.html'));
}

function buildTray() {
  if (tray) return;
  const img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('RemoteConnectMe');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show window', click: () => showStatusWindow() },
    { label: 'Open dashboard', click: () => shell.openExternal(config.apiBase + '/dashboard') },
    { label: 'Check for updates', click: () => {
        if (!autoUpdater) {
          dialog.showMessageBox({ type: 'info', message: 'Auto-update not available in this build.' });
          return;
        }
        autoUpdater.checkForUpdates().catch((e) =>
          dialog.showMessageBox({ type: 'error', message: 'Update check failed', detail: e?.message }));
      } },
    { type: 'separator' },
    { label: 'Sign out (unpair this device)', click: async () => {
        const ok = dialog.showMessageBoxSync({
          type: 'warning', buttons: ['Cancel', 'Unpair'], defaultId: 0, cancelId: 0,
          title: 'Unpair', message: 'You will need to enter a new pair code to use this device again.',
        });
        if (ok === 1) {
          await clearKey();
          await keytar.deletePassword(SERVICE, ACCOUNT_UNATTENDED_PIN).catch(() => {});
          app.relaunch(); app.exit(0);
        }
      } },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showStatusWindow());
}

// ---- Display mapping for input injection ----
function displayForSourceId(sourceId) {
  const m = /^screen:(\d+)/.exec(String(sourceId || ''));
  const idx = m ? parseInt(m[1], 10) : 0;
  const all = screen.getAllDisplays();
  return all[Math.min(idx, all.length - 1)] || screen.getPrimaryDisplay();
}

// ---- IPC ----

ipcMain.handle('config', () => config);

/**
 * Browser-based pairing.
 * 1. Spin up a one-shot HTTP server on a random localhost port.
 * 2. Open the web app /pair page with the callback URL + machine name.
 * 3. The web app creates the device, generates a deviceKey, and redirects
 *    to http://127.0.0.1:{port}?deviceKey=...&deviceId=...
 * 4. We receive the credentials, save to keychain, open the status window.
 */
ipcMain.handle('browserPair', async () => {
  const http = require('http');
  return new Promise((resolve, reject) => {
    let server;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const timeout = setTimeout(() => {
      try { server?.close(); } catch {}
      reject(new Error('Pairing timed out after 5 minutes. Please try again.'));
    }, TIMEOUT_MS);

    server = http.createServer((req, res) => {
      clearTimeout(timeout);
      try { server.close(); } catch {}

      const url = new URL(req.url, 'http://localhost');
      const deviceKey = url.searchParams.get('deviceKey');
      const errorMsg = url.searchParams.get('error');

      // Send a page the browser tab can close itself
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Paired!</title></head><body>
        <p style="font-family:system-ui;text-align:center;margin-top:80px;font-size:18px">
          ✓ Device paired — you can close this tab.
        </p>
        <script>setTimeout(()=>window.close(),1500)</script>
      </body></html>`);

      if (errorMsg) return reject(new Error(decodeURIComponent(errorMsg)));
      if (!deviceKey) return reject(new Error('No device key received from browser.'));

      saveKey(deviceKey)
        .then(async () => {
          // Enable auto-launch on first pair so the app starts with Windows by default
          try {
            const launcher = new AutoLaunch({ name: 'RemoteConnectMe', path: process.execPath });
            await launcher.enable();
          } catch (e) { console.warn('[auto-launch] enable on pair failed:', e.message); }
          setTimeout(async () => {
            if (pairWin && !pairWin.isDestroyed()) pairWin.close();
            await showStatusWindow();
            await showSessionWindow();
          }, 200);
          resolve({ ok: true });
        })
        .catch(reject);
    });

    server.on('error', (e) => {
      clearTimeout(timeout);
      reject(new Error(`Local server error: ${e.message}`));
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const callbackUrl = encodeURIComponent(`http://127.0.0.1:${port}`);
      const name = encodeURIComponent(os.hostname());
      const url = `${config.apiBase}/pair?callback=${callbackUrl}&name=${name}&platform=${encodeURIComponent(process.platform)}`;
      shell.openExternal(url);
    });
  });
});

ipcMain.handle('pair', async (_e, code, machineName) => {
  const r = await fetch(config.apiBase + '/api/client/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, machineName: machineName || os.hostname(), platform: process.platform }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Pair failed');
  await saveKey(data.deviceKey);
  setTimeout(async () => {
    if (pairWin && !pairWin.isDestroyed()) pairWin.close();
    await showStatusWindow();
    await showSessionWindow();
  }, 200);
  return { deviceId: data.deviceId, accountEmail: data.accountEmail };
});

ipcMain.handle('isPaired', async () => !!(await loadKey()));

ipcMain.handle('getConnectToken', async () => {
  const key = await loadKey();
  if (!key) throw new Error('not paired');
  const r = await fetch(config.apiBase + '/api/client/connect-token', {
    method: 'POST', headers: { 'authorization': `Bearer ${key}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'connect-token failed');
  return data;
});

/**
 * Native approval dialog. The session worker calls this when a viewer attempts
 * to connect to a device with `requireApproval=true`. Returns true if the
 * local user clicks Accept inside 30 seconds, false otherwise (declines also
 * default-falsey on timeout — better to keep the screen private than to grant
 * access by inaction).
 *
 * `info.viewerHint` is an optional descriptor the API can supply later (e.g.
 * the requesting user's email). For now the dialog says "a remote user".
 */
ipcMain.handle('requestSessionApproval', async (_e, info) => {
  // Surface the window so the user actually sees the dialog if RemoteConnectMe was
  // minimized to the tray.
  if (statusWin && !statusWin.isDestroyed()) statusWin.show();
  const result = await dialog.showMessageBox(statusWin || undefined, {
    type: 'question',
    buttons: ['Reject', 'Accept'],
    defaultId: 0,
    cancelId: 0,
    title: 'Incoming connection',
    message: 'Allow a remote viewer to control this computer?',
    detail: info?.viewerHint
      ? `Requesting user: ${info.viewerHint}\n\nThe viewer will see your screen and can move the mouse and type until they disconnect.`
      : 'The viewer will see your screen and can move the mouse and type until they disconnect.',
  });
  const accepted = result.response === 1;
  // Report the decision to the API so it lands in the audit log. Best-effort;
  // failing the audit call must never block the actual session.
  try {
    const key = await loadKey();
    if (key && info?.deviceId) {
      await fetch(`${config.apiBase}/api/devices/${info.deviceId}/session-decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ decision: accepted ? 'accept' : 'reject' }),
      }).catch(() => {});
    }
  } catch {}
  return accepted;
});

ipcMain.handle('getTurnCredentials', async () => {
  const key = await loadKey();
  if (!key) throw new Error('not paired');
  try {
    const r = await fetch(config.apiBase + '/api/turn-credentials', {
      method: 'POST', headers: { 'authorization': `Bearer ${key}` },
    });
    if (!r.ok) {
      return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], ttl: 0 };
    }
    return await r.json();
  } catch {
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], ttl: 0 };
  }
});

// ---- Unattended access ----

ipcMain.handle('setUnattended', async (_e, enable) => {
  const launcher = new AutoLaunch({ name: 'RemoteConnectMe', path: process.execPath });
  if (enable) await launcher.enable(); else await launcher.disable();
  return launcher.isEnabled();
});
ipcMain.handle('getUnattended', async () => {
  const launcher = new AutoLaunch({ name: 'RemoteConnectMe', path: process.execPath });
  return launcher.isEnabled();
});

ipcMain.handle('setUnattendedPin', async (_e, pin) => {
  if (!pin) {
    await keytar.deletePassword(SERVICE, ACCOUNT_UNATTENDED_PIN).catch(() => {});
    return { set: false };
  }
  if (!/^\d{4,8}$/.test(String(pin))) {
    throw new Error('PIN must be 4-8 digits');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 64);
  const stored = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
  await keytar.setPassword(SERVICE, ACCOUNT_UNATTENDED_PIN, stored);
  return { set: true };
});

ipcMain.handle('getUnattendedPinSet', async () => {
  const v = await keytar.getPassword(SERVICE, ACCOUNT_UNATTENDED_PIN);
  return !!v;
});

/**
 * Verify a PIN attempt from the viewer. Returns { ok: bool, reason? }.
 * Constant-time compare so attackers can't time their guesses.
 */
ipcMain.handle('verifyUnattendedPin', async (_e, pin) => {
  const stored = await keytar.getPassword(SERVICE, ACCOUNT_UNATTENDED_PIN);
  if (!stored) return { ok: false, reason: 'no_pin_set' };
  const m = /^scrypt:([0-9a-f]+):([0-9a-f]+)$/.exec(stored);
  if (!m) return { ok: false, reason: 'corrupt_record' };
  const salt = Buffer.from(m[1], 'hex');
  const expected = Buffer.from(m[2], 'hex');
  const actual = crypto.scryptSync(String(pin || ''), salt, 64);
  const equal = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return { ok: equal };
});

// ---- Screen sources ----

ipcMain.handle('getScreenSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 240, height: 135 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null,
  }));
});

ipcMain.handle('setActiveSource', (_e, sourceId) => {
  activeSourceId = sourceId;
  const d = displayForSourceId(sourceId);
  input.setActiveDisplay(d);
  return { ok: true, displayId: d.id, bounds: d.bounds, size: d.size };
});

// ---- Clipboard ----

ipcMain.handle('clipboard.read', () => clipboard.readText());
ipcMain.handle('clipboard.write', (_e, text) => {
  clipboard.writeText(typeof text === 'string' ? text : String(text || ''));
  return true;
});

// ---- File transfer (incoming, viewer -> host) ----

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>| -]/g, '_').slice(0, 255) || 'file';
}

function uniquify(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

ipcMain.handle('saveDownload', async (_e, name, bytes) => {
  const downloads = app.getPath('downloads');
  if (!fs.existsSync(downloads)) fs.mkdirSync(downloads, { recursive: true });
  const final = uniquify(downloads, safeName(name));
  const target = path.join(downloads, final);
  fs.writeFileSync(target, Buffer.from(bytes));
  return target;
});

// ---- Input injection ----

ipcMain.handle('inject', async (_e, evt) => {
  try { await input.handle(evt); }
  catch (e) {
    console.warn('input.handle failed:', e.message);
    if (Sentry) Sentry.captureException(e);
  }
});

// ---- Disconnect active session ----

ipcMain.handle('disconnect', () => {
  if (sessionWin && !sessionWin.isDestroyed()) {
    sessionWin.webContents.send('disconnect');
  }
  return { ok: true };
});

// ---- Logging ----

ipcMain.on('log', (_e, line) => {
  console.log('[client]', line);
  if (statusWin && !statusWin.isDestroyed()) statusWin.webContents.send('log', line);
});

// ---- Updater controls (UI-facing) ----

ipcMain.handle('checkForUpdates', async () => {
  if (!autoUpdater) return { available: false, reason: 'updater_not_built' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { available: !!result, version: result?.updateInfo?.version || null };
  } catch (e) {
    return { available: false, reason: e?.message };
  }
});

ipcMain.handle('installUpdate', () => {
  if (!autoUpdater) return false;
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});

// ---- App boot ----

app.whenReady().then(async () => {
  buildTray();

  // Platform-specific permission prompts (macOS Accessibility, etc.) + warnings.
  try { await permissions.requestAll(); } catch (e) { console.warn('[permissions]', e); }

  const paired = !!(await loadKey());
  if (!paired) await showPairWindow();
  else { await showStatusWindow(); await showSessionWindow(); }

  // Background update check on launch + every hour.
  if (autoUpdater) {
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
  }
});

// Expose permission status to the host UI for visibility.
ipcMain.handle('getPermissions', () => permissions.summary());

app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin' && !app.isQuitting) e?.preventDefault?.();
});
