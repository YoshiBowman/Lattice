'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledwall', {
  getVersion: () => ipcRenderer.invoke('get-version'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),
  startOutput: (displayId, virtualSpec) => ipcRenderer.invoke('start-output', displayId, virtualSpec),
  stopOutput: (displayId) => ipcRenderer.invoke('stop-output', displayId),
  setOutputTitle: (displayId, title) => ipcRenderer.invoke('set-output-title', displayId, title),
  nudgeOutput: (displayId, dx, dy) => ipcRenderer.invoke('nudge-output', displayId, dx, dy),
  saveLogo: (dataUrl) => ipcRenderer.invoke('save-logo', dataUrl),
  loadLogo: () => ipcRenderer.invoke('load-logo'),
  onNudgeOutput: (cb) => ipcRenderer.on('nudge-output', (e, info) => cb(info)),
  stopAll: () => ipcRenderer.invoke('stop-all'),
  identify: () => ipcRenderer.invoke('identify'),
  closeSelf: () => ipcRenderer.invoke('close-self'),
  getMyOutput: () => ipcRenderer.invoke('my-output'),

  installUpdate: () => ipcRenderer.invoke('install-update'),

  onConfig: (cb) => ipcRenderer.on('config', (e, cfg) => cb(cfg)),
  onIdentify: (cb) => ipcRenderer.on('identify', (e, info) => cb(info)),
  onDisplaysChanged: (cb) => ipcRenderer.on('displays-changed', (e, list) => cb(list)),
  onActiveOutputs: (cb) => ipcRenderer.on('active-outputs', (e, list) => cb(list)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (e, info) => cb(info)),
});
