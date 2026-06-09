const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remotely', {
  // ---- Config + pairing ----
  config: () => ipcRenderer.invoke('config'),
  pair: (code, machineName) => ipcRenderer.invoke('pair', code, machineName),
  browserPair: () => ipcRenderer.invoke('browserPair'),
  browserSignup: () => ipcRenderer.invoke('browserSignup'),
  isPaired: () => ipcRenderer.invoke('isPaired'),
  // In-app login pairing (email + password + OTP)
  appLogin: (email, password) => ipcRenderer.invoke('appLogin', email, password),
  appVerifyOtp: (token, code) => ipcRenderer.invoke('appVerifyOtp', token, code),
  appPair: (token, code, name) => ipcRenderer.invoke('appPair', token, code, name),
  getHostname: () => ipcRenderer.invoke('getHostname'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),

  // ---- Auth tokens ----
  getConnectToken: () => ipcRenderer.invoke('getConnectToken'),
  getTurnCredentials: () => ipcRenderer.invoke('getTurnCredentials'),

  // ---- Session approval + disconnect ----
  requestSessionApproval: (info) => ipcRenderer.invoke('requestSessionApproval', info),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  onDisconnect: (cb) => ipcRenderer.on('disconnect', cb),

  // ---- Unattended access ----
  setUnattended: (b) => ipcRenderer.invoke('setUnattended', b),
  getUnattended: () => ipcRenderer.invoke('getUnattended'),
  setUnattendedPin: (pin) => ipcRenderer.invoke('setUnattendedPin', pin),
  getUnattendedPinSet: () => ipcRenderer.invoke('getUnattendedPinSet'),
  verifyUnattendedPin: (pin) => ipcRenderer.invoke('verifyUnattendedPin', pin),

  // ---- Input injection ----
  inject: (evt) => ipcRenderer.invoke('inject', evt),

  // ---- Logging ----
  log: (line) => ipcRenderer.send('log', line),
  onLog: (cb) => ipcRenderer.on('log', (_e, l) => cb(l)),

  // ---- Screen sources ----
  getScreenSources: () => ipcRenderer.invoke('getScreenSources'),
  setActiveSource: (sourceId) => ipcRenderer.invoke('setActiveSource', sourceId),

  // ---- Clipboard ----
  clipboardRead: () => ipcRenderer.invoke('clipboard.read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard.write', text),

  // ---- File transfer ----
  saveDownload: (name, bytes) => ipcRenderer.invoke('saveDownload', name, bytes),

  // ---- Updater ----
  checkForUpdates: () => ipcRenderer.invoke('checkForUpdates'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),

  // ---- Platform permissions ----
  getPermissions: () => ipcRenderer.invoke('getPermissions'),
});
