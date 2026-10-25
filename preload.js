'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('pc', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listScreens: () => ipcRenderer.invoke('sources:list'),

  // recording
  prepareRecording: () => ipcRenderer.invoke('recorder:prepare'),
  setRecordingState: (payload) => ipcRenderer.send('recorder:state', payload),
  sendLevel: (level) => ipcRenderer.send('recorder:level', level),
  onCommand: on('recorder:command'),

  // clips
  saveClip: (data) => ipcRenderer.invoke('clip:save', data),
  listClips: () => ipcRenderer.invoke('clips:list'),
  renameClip: (id, title) => ipcRenderer.invoke('clip:rename', { id, title }),
  deleteClip: (id) => ipcRenderer.invoke('clip:delete', id),
  revealClip: (id) => ipcRenderer.invoke('clip:reveal', id),
  openClip: (id) => ipcRenderer.invoke('clip:open', id),
  dragClip: (id) => ipcRenderer.send('clip:drag', id),

  // folders & permissions
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  permissionStatus: () => ipcRenderer.invoke('perm:status'),
  requestMic: () => ipcRenderer.invoke('perm:requestMic'),
  openPermissionSettings: (which) => ipcRenderer.invoke('perm:openSettings', which),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  selftestFailed: (msg) => ipcRenderer.send('app:selftest-failed', msg),

  // floating indicator
  onIndicatorStart: on('indicator:start'),
  onIndicatorLevel: on('indicator:level'),
  indicatorAction: (action) => ipcRenderer.send('indicator:action', action)
});
