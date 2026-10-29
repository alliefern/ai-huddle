'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('huddle', {
  getState: () => ipcRenderer.invoke('huddle:state'),
  getRoom: (roomId) => ipcRenderer.invoke('huddle:room', roomId),
  send: (roomId, text, files) => ipcRenderer.invoke('huddle:send', roomId, text, files),
  skills: () => ipcRenderer.invoke('huddle:skills'),
  importSkillFolder: () => ipcRenderer.invoke('huddle:skills-import-folder'),
  importSkillFile: () => ipcRenderer.invoke('huddle:skills-import-file'),
  importSkillSource: (p) => ipcRenderer.invoke('huddle:skills-import-source', p),
  removeSkill: (slug) => ipcRenderer.invoke('huddle:skills-remove', slug),
  openSkillsFolder: () => ipcRenderer.invoke('huddle:skills-open'),
  fileData: (p) => ipcRenderer.invoke('huddle:file-data', p),
  openFile: (p) => ipcRenderer.invoke('huddle:file-open', p),
  revealFile: (p) => ipcRenderer.invoke('huddle:file-reveal', p),
  relay: (roomId, agentId, msgId) => ipcRenderer.invoke('huddle:relay', roomId, agentId, msgId),
  stop: (roomId) => ipcRenderer.invoke('huddle:stop', roomId),
  clear: (roomId) => ipcRenderer.invoke('huddle:clear', roomId),
  createRoom: (p) => ipcRenderer.invoke('huddle:create-room', p),
  updateRoom: (id, p) => ipcRenderer.invoke('huddle:update-room', id, p),
  deleteRoom: (id) => ipcRenderer.invoke('huddle:delete-room', id),
  saveConfig: (patch) => ipcRenderer.invoke('huddle:config', patch),
  checkAgents: (overrides) => ipcRenderer.invoke('huddle:check', overrides),
  chooseFolder: () => ipcRenderer.invoke('huddle:choose-folder'),
  openWorkDir: (roomId) => ipcRenderer.invoke('huddle:open-workdir', roomId),
  workDir: (roomId) => ipcRenderer.invoke('huddle:workdir', roomId),
  exportChat: (roomId) => ipcRenderer.invoke('huddle:export', roomId),
  updateState: () => ipcRenderer.invoke('huddle:update-state'),
  checkUpdate: () => ipcRenderer.invoke('huddle:update-check'),
  installUpdate: () => ipcRenderer.invoke('huddle:update-install'),
  onUpdate: (cb) => on('huddle:update', cb),
  onMessage: (cb) => on('huddle:message', cb),
  onMessageUpdated: (cb) => on('huddle:message-updated', cb),
  onStatus: (cb) => on('huddle:status', cb),
  onConfig: (cb) => on('huddle:config', cb),
  onSkills: (cb) => on('huddle:skills', cb),
  onRooms: (cb) => on('huddle:rooms', cb),
  onCleared: (cb) => on('huddle:cleared', cb),
  onNote: (cb) => on('huddle:note', cb),
});
