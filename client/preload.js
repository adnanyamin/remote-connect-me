'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remotely', {
  // Auth / pairing
  browserPair:    ()                    => ipcRenderer.invoke('browserPair'),
  browserSignup:  ()                    => ipcRenderer.invoke('browserSignup'),
  appLogin:       (email, password)     => ipcRenderer.invoke('appLogin', email, password),
  appVerifyOtp:   (token, code)         => ipcRenderer.invoke('appVerifyOtp', token, code),
  appPair:        (token, code, name)   => ipcRenderer.invoke('appPair', token, code, name),
  getHostname:    ()                    => ipcRenderer.invoke('getHostname'),
  openExternal:   (url)                 => ipcRenderer.invoke('openExternal', url),

  // Session worker
  config:              ()          => ipcRenderer.invoke('config'),
  getConnectToken:     ()          => ipcRenderer.invoke('getConnectToken'),
  getTurnCredentials:  ()          => ipcRenderer.invoke('getTurnCredentials'),
  log:                 (msg)       => ipcRenderer.invoke('log', msg),
  getScreenSources:    ()          => ipcRenderer.invoke('getScreenSources'),
  setActiveSource:     (id)        => ipcRenderer.invoke('setActiveSource', id),
  inject:              (msg)       => ipcRenderer.invoke('inject', msg),
  saveDownload:        (name, buf) => ipcRenderer.invoke('saveDownload', name, buf),
  clipboardRead:       ()          => ipcRenderer.invoke('clipboardRead'),
  clipboardWrite:      (text)      => ipcRenderer.invoke('clipboardWrite', text),

  // Viewer window
  getDevices:   ()                    => ipcRenderer.invoke('getDevices'),
  getViewToken: (targetDeviceId)      => ipcRenderer.invoke('getViewToken', targetDeviceId),

  onDisconnect: (cb) => {
    ipcRenderer.on('disconnect', () => cb());
  },
});
