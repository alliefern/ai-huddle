'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Engine, MEMORY_MAX_CHARS } = require('./engine');
const { Updater } = require('./updater');

let win = null;
let engine = null;
let updater = null;

// Keep saving to the same folder the app has always used, so a rename never loses your chats.
app.setPath('userData', path.join(app.getPath('appData'), 'huddle'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#fff8f0',
    title: 'AI Huddle',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => (win = null));
}

function wireUpdater() {
  let autoUpdater = null;
  try {
    autoUpdater = require('electron-updater').autoUpdater; // missing in a plain source checkout: updates just stay off
  } catch (_) {}
  updater = new Updater({
    autoUpdater,
    app,
    send: (s) => send('huddle:update', s),
    isEnabled: () => engine && engine.config.settings.checkUpdates !== false,
  });
  ipcMain.handle('huddle:update-state', () => updater.getState());
  ipcMain.handle('huddle:update-check', () => updater.check(true));
  ipcMain.handle('huddle:update-install', () => updater.install());
  // a few seconds after launch, so startup stays quick
  setTimeout(() => updater.check(false), 8000).unref();
}

function wireEngine() {
  engine = new Engine(path.join(app.getPath('userData'), 'huddle'));
  engine.on('message', (m) => send('huddle:message', m));
  engine.on('message-updated', (m) => send('huddle:message-updated', m));
  engine.on('status', (s) => send('huddle:status', s));
  engine.on('config', (c) => send('huddle:config', c));
  engine.on('rooms', (r) => send('huddle:rooms', r));
  engine.on('skills', (s) => send('huddle:skills', s));
  engine.on('tools', (c) => send('huddle:tools', c));
  engine.on('cleared', (roomId) => send('huddle:cleared', roomId));
  engine.on('error-note', (t) => send('huddle:note', t));

  const str = (v) => String(v == null ? '' : v);

  ipcMain.handle('huddle:state', () => engine.getState());
  ipcMain.handle('huddle:room', (_e, roomId) => engine.getRoom(str(roomId)));
  ipcMain.handle('huddle:send', (_e, roomId, text, files) => {
    const clean = (Array.isArray(files) ? files : [])
      .filter((f) => f && f.data)
      .map((f) => ({ name: str(f.name), mime: str(f.mime), data: Buffer.from(f.data) }));
    engine.send(str(roomId), str(text), clean);
  });

  // what each agent can actually do (checked, never assumed)
  ipcMain.handle('huddle:tools-get', () => engine.getCapabilities());
  ipcMain.handle('huddle:tools-refresh', (_e, id) => (id ? engine.probeAgent(str(id)).then(() => engine.getCapabilities()) : engine.probeAll()));
  ipcMain.handle('huddle:tools-test', (_e, id, kind) => engine.testAgent(str(id), str(kind)));

  // shared memory
  ipcMain.handle('huddle:memory-get', () => ({ text: engine.getMemory(), max: MEMORY_MAX_CHARS }));
  ipcMain.handle('huddle:memory-set', (_e, text) => engine.setMemory(typeof text === 'string' ? text : ''));
  ipcMain.handle('huddle:memory-import-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'pick .md or .txt files to add to the shared memory',
      filters: [{ name: 'text', extensions: ['md', 'txt', 'markdown'] }],
    });
    if (r.canceled) return null;
    let text = engine.getMemory().replace(/\s+$/, '');
    const added = [];
    for (const p of r.filePaths.slice(0, 20)) {
      try {
        const body = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
        if (!body) continue;
        text += (text ? '\n\n' : '') + '## From ' + path.basename(p) + '\n\n' + body;
        added.push(path.basename(p));
      } catch (_) {}
    }
    const saved = engine.setMemory(text);
    return { ...saved, added };
  });
  ipcMain.handle('huddle:clone-repo', (_e, roomId, input) => engine.cloneRepo(str(roomId), str(input)));

  // shared skills
  ipcMain.handle('huddle:skills', () => engine.listSkills());
  ipcMain.handle('huddle:skills-import-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'pick a skill folder, or a folder of skills' });
    return r.canceled ? null : engine.importSkills(r.filePaths);
  });
  ipcMain.handle('huddle:skills-import-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'pick .skill or .zip files',
      filters: [{ name: 'skill bundles', extensions: ['skill', 'zip'] }],
    });
    return r.canceled ? null : engine.importSkills(r.filePaths);
  });
  ipcMain.handle('huddle:skills-import-source', (_e, p) => {
    const ok = engine.listSkills().sources.some((s) => s.path === str(p));
    return ok ? engine.importSkills([str(p)]) : null;
  });
  ipcMain.handle('huddle:skills-remove', (_e, slug) => engine.removeSkill(str(slug)));
  ipcMain.handle('huddle:skills-open', () => shell.openPath(engine.skills.dir));

  // attachments (only files Huddle itself saved or was handed by an agent)
  ipcMain.handle('huddle:file-data', (_e, p) => engine.fileDataUrl(str(p)));
  ipcMain.handle('huddle:file-open', (_e, p) => (engine.isKnownFile(str(p)) ? shell.openPath(str(p)) : 'unknown file'));
  ipcMain.handle('huddle:file-reveal', (_e, p) => {
    if (engine.isKnownFile(str(p))) shell.showItemInFolder(str(p));
  });
  ipcMain.handle('huddle:relay', (_e, roomId, agentId, msgId) => engine.relay(str(roomId), str(agentId), Number(msgId)));
  ipcMain.handle('huddle:stop', (_e, roomId) => engine.stop(roomId ? str(roomId) : null));
  ipcMain.handle('huddle:clear', (_e, roomId) => engine.clear(str(roomId)));
  ipcMain.handle('huddle:create-room', (_e, p) => engine.createRoom(p || {}));
  ipcMain.handle('huddle:update-room', (_e, id, p) => engine.updateRoom(str(id), p || {}));
  ipcMain.handle('huddle:delete-room', (_e, id) => engine.deleteRoom(str(id)));
  ipcMain.handle('huddle:config', (_e, patch) => engine.updateConfig(patch));
  ipcMain.handle('huddle:check', (_e, overrides) => engine.checkAgents(overrides));
  ipcMain.handle('huddle:choose-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('huddle:open-workdir', (_e, roomId) => shell.openPath(engine.workDir(roomId ? str(roomId) : undefined)));
  ipcMain.handle('huddle:workdir', (_e, roomId) => engine.workDir(roomId ? str(roomId) : undefined));
  ipcMain.handle('huddle:export', async (_e, roomId) => {
    const room = engine.getRoom(str(roomId));
    const safe = ((room && room.room.name) || 'chat').replace(/[^\w-]+/g, '-');
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `ai-huddle-${safe}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, engine.exportMarkdown(str(roomId)), 'utf8');
    return r.filePath;
  });
}

app.whenReady().then(() => {
  wireEngine();
  wireUpdater();
  createWindow();
  // quiet health check a few seconds after launch, so the tools panel already has answers when you open it
  setTimeout(() => engine && engine.probeAll().catch(() => {}), 4000).unref();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('before-quit', () => {
  if (engine) {
    engine.stop(null, true); // don't leave agent processes running after you close the window
    engine.flush();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
