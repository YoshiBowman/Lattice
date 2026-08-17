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
  exportCapabilities: () => ipcRenderer.invoke('export-capabilities'),
  exportChoose: (suggested) => ipcRenderer.invoke('export-choose', suggested),
  exportBegin: (basePath) => ipcRenderer.invoke('export-begin', basePath),
  exportFrame: (dir, index, dataUrl) => ipcRenderer.invoke('export-frame', dir, index, dataUrl),
  exportWriteFile: (filePath, dataUrl) => ipcRenderer.invoke('export-write-file', filePath, dataUrl),
  exportEncode: (dir, outPath, fps) => ipcRenderer.invoke('export-encode', dir, outPath, fps),
  exportCleanup: (dir, keep) => ipcRenderer.invoke('export-cleanup', dir, keep),
  exportReveal: (target) => ipcRenderer.invoke('export-reveal', target),

  saveShow: (json) => ipcRenderer.invoke('save-show', json),
  loadShow: () => ipcRenderer.invoke('load-show'),
  onNudgeOutput: (cb) => ipcRenderer.on('nudge-output', (e, info) => cb(info)),
  stopAll: () => ipcRenderer.invoke('stop-all'),
  identify: () => ipcRenderer.invoke('identify'),
  closeSelf: () => ipcRenderer.invoke('close-self'),
  getMyOutput: () => ipcRenderer.invoke('my-output'),

  getDeckLink: () => ipcRenderer.invoke('get-decklink'),
  startDeckLinkOutput: (id, deviceIndex, mode, range, level) =>
    ipcRenderer.invoke('start-decklink-output', id, deviceIndex, mode, range, level),
  stopDeckLinkOutput: (id) => ipcRenderer.invoke('stop-decklink-output', id),
  onDeckLinkStatus: (cb) => ipcRenderer.on('decklink-status', (e, s) => cb(s)),

  installUpdate: () => ipcRenderer.invoke('install-update'),
  openReleases: () => ipcRenderer.invoke('open-releases'),

  onConfig: (cb) => ipcRenderer.on('config', (e, cfg) => cb(cfg)),
  onIdentify: (cb) => ipcRenderer.on('identify', (e, info) => cb(info)),
  onDisplaysChanged: (cb) => ipcRenderer.on('displays-changed', (e, list) => cb(list)),
  onActiveOutputs: (cb) => ipcRenderer.on('active-outputs', (e, list) => cb(list)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (e, info) => cb(info)),
});
