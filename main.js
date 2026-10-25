'use strict';

const {
  app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, shell, dialog,
  Tray, Menu, nativeImage, screen, systemPreferences, session, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// Test hooks (used only during development; ignored in normal use)
const SHOT_PATH = process.env.PROCORRECTOR_SHOT || '';
const SELFTEST = process.env.PROCORRECTOR_SELFTEST === '1';

let mainWindow = null;
let indicatorWindow = null;
let tray = null;
let quitting = false;
let isRecording = false;
let pendingSource = null;
let registeredHotkey = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- paths & persistence ----------
const userDir = () => app.getPath('userData');
const settingsFile = () => path.join(userDir(), 'settings.json');
const libraryFile = () => path.join(userDir(), 'library.json');
const thumbsDir = () => path.join(userDir(), 'thumbs');

function defaultSettings() {
  const locale = (app.getLocale() || 'en').toLowerCase();
  return {
    language: locale.startsWith('ar') ? 'ar' : 'en',
    hotkey: 'F8',
    saveDir: path.join(app.getPath('videos'), 'ProCorrector'),
    micId: 'default',
    screenId: 'auto',
    showAfterRecording: true,
    hideWhileRecording: true,
    quality: '1080',
    theme: 'system',
    onboarded: false
  };
}

let settings = null;
function loadSettings() {
  try {
    settings = { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = defaultSettings();
  }
  return settings;
}
function saveSettings() {
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function readLibrary() {
  try {
    const list = JSON.parse(fs.readFileSync(libraryFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeLibrary(list) {
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(libraryFile(), JSON.stringify(list, null, 2));
}

function toClientClip(c) {
  return {
    ...c,
    fileUrl: pathToFileURL(c.file).href,
    thumbUrl: c.thumb && fs.existsSync(c.thumb) ? pathToFileURL(c.thumb).href : null,
    fileName: path.basename(c.file)
  };
}

// Make a string safe to use as a file name on Windows and macOS
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

// ---------- windows ----------
function iconPath(name) {
  return path.join(__dirname, 'assets', name);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 860,
    minHeight: 580,
    show: false,
    title: 'ProCorrector',
    icon: isMac ? undefined : iconPath('icon-256.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#10142B' : '#F2F5FA',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!SELFTEST) mainWindow.show();
    if (SHOT_PATH) {
      if (process.env.PROCORRECTOR_SHOT_SETTINGS) {
        mainWindow.webContents.executeJavaScript("document.getElementById('settingsBtn').click()");
      }
      setTimeout(takeScreenshot, 1800);
    }
  });

  // Closing the window keeps the app alive in the tray so the hotkey keeps working.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function takeScreenshot() {
  const img = await mainWindow.webContents.capturePage();
  fs.writeFileSync(SHOT_PATH, img.toPNG());
  if (process.env.PROCORRECTOR_SHOT_INDICATOR) {
    showIndicator(Date.now() - 83000);
    setTimeout(async () => {
      const ind = await indicatorWindow.webContents.capturePage();
      fs.writeFileSync(process.env.PROCORRECTOR_SHOT_INDICATOR, ind.toPNG());
      quitting = true;
      app.quit();
    }, 1200);
    return;
  }
  quitting = true;
  app.quit();
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createIndicator() {
  indicatorWindow = new BrowserWindow({
    width: 320,
    height: 64,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  indicatorWindow.setAlwaysOnTop(true, 'screen-saver');
  indicatorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the indicator itself out of the recording.
  indicatorWindow.setContentProtection(true);
  indicatorWindow.loadFile(path.join(__dirname, 'src', 'indicator.html'));
  indicatorWindow.on('closed', () => { indicatorWindow = null; });
}

function showIndicator(startedAt, displayId) {
  if (!indicatorWindow) createIndicator();
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => String(d.id) === String(displayId)) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = target.workArea;
  const [w] = indicatorWindow.getSize();
  indicatorWindow.setPosition(Math.round(x + (width - w) / 2), Math.round(y + 18));
  const send = () => {
    indicatorWindow.webContents.send('indicator:start', { startedAt, language: settings.language });
    indicatorWindow.showInactive();
  };
  if (indicatorWindow.webContents.isLoading()) {
    indicatorWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function hideIndicator() {
  if (indicatorWindow) indicatorWindow.hide();
}

// ---------- tray ----------
function trayImage(recording) {
  if (isMac) {
    const img = nativeImage.createFromPath(iconPath(recording ? 'trayRecTemplate.png' : 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(iconPath(recording ? 'tray-rec.png' : 'tray.png'));
}

const trayText = {
  ar: { open: 'فتح ProCorrector', start: 'ابدأ التسجيل', stop: 'أوقف واحفظ', folder: 'فتح مجلد التسجيلات', quit: 'خروج', tip: 'ProCorrector — اضغط {k} للتسجيل' },
  en: { open: 'Open ProCorrector', start: 'Start recording', stop: 'Stop and save', folder: 'Open recordings folder', quit: 'Quit', tip: 'ProCorrector — press {k} to record' }
};

function updateTray() {
  if (!tray) return;
  const t = trayText[settings.language] || trayText.en;
  tray.setImage(trayImage(isRecording));
  tray.setToolTip(t.tip.replace('{k}', settings.hotkey));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t.open, click: showMain },
    { label: isRecording ? t.stop : t.start, accelerator: settings.hotkey, click: () => sendCommand('toggle') },
    { label: t.folder, click: () => openSaveDir() },
    { type: 'separator' },
    { label: t.quit, click: () => { quitting = true; app.quit(); } }
  ]));
}

function createTray() {
  tray = new Tray(trayImage(false));
  if (!isMac) tray.on('click', showMain);
  updateTray();
}

// ---------- hotkey ----------
function sendCommand(cmd) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recorder:command', cmd);
}

function registerHotkey(accel) {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }
  try {
    const ok = globalShortcut.register(accel, () => sendCommand('toggle'));
    if (ok) registeredHotkey = accel;
    return ok;
  } catch {
    return false;
  }
}

// ---------- folders ----------
async function ensureSaveDir() {
  await fsp.mkdir(settings.saveDir, { recursive: true });
  return settings.saveDir;
}
async function openSaveDir() {
  await ensureSaveDir();
  shell.openPath(settings.saveDir);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('settings:get', () => ({
    settings,
    platform: process.platform,
    version: app.getVersion(),
    hotkeyOk: registeredHotkey === settings.hotkey
  }));

  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['language', 'hotkey', 'saveDir', 'micId', 'screenId', 'showAfterRecording', 'hideWhileRecording', 'quality', 'theme', 'onboarded'];
    const prevHotkey = settings.hotkey;
    for (const k of allowed) if (k in patch) settings[k] = patch[k];
    let hotkeyOk = true;
    if (settings.hotkey !== prevHotkey) {
      hotkeyOk = registerHotkey(settings.hotkey);
      if (!hotkeyOk) {
        settings.hotkey = prevHotkey;
        registerHotkey(prevHotkey);
      }
    }
    saveSettings();
    updateTray();
    return { settings, hotkeyOk };
  });

  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s, i) => ({
      id: s.id,
      name: s.name || `Screen ${i + 1}`,
      displayId: s.display_id,
      thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL()
    }));
  });

  // Picks which screen the next recording will capture.
  ipcMain.handle('recorder:prepare', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.length) return { ok: false, error: 'no-screen' };
    let chosen = null;
    if (settings.screenId && settings.screenId !== 'auto') {
      chosen = sources.find((s) => s.id === settings.screenId || s.display_id === settings.screenId);
    }
    if (!chosen) {
      const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      chosen = sources.find((s) => String(s.display_id) === String(cursorDisplay.id)) || sources[0];
    }
    pendingSource = chosen;
    return { ok: true, displayId: chosen.display_id, name: chosen.name };
  });

  ipcMain.on('recorder:state', (_e, payload) => {
    const { state, startedAt } = payload || {};
    if (state === 'recording') {
      isRecording = true;
      if (settings.hideWhileRecording && mainWindow && mainWindow.isVisible() && !SELFTEST) {
        if (isMac) mainWindow.hide(); else mainWindow.minimize();
      }
      showIndicator(startedAt, pendingSource && pendingSource.display_id);
    } else {
      isRecording = false;
      hideIndicator();
    }
    updateTray();
  });

  ipcMain.on('recorder:level', (_e, level) => {
    if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.webContents.send('indicator:level', level);
  });

  ipcMain.on('indicator:action', (_e, action) => {
    if (action === 'stop' || action === 'discard') sendCommand(action);
  });

  ipcMain.handle('clip:save', async (_e, data) => {
    const dir = await ensureSaveDir();
    const now = new Date();
    const title = safeName(data.title) || (settings.language === 'ar' ? 'تعليق' : 'Comment');
    const ext = data.ext === '.webm' ? '.webm' : '.mp4';
    const file = uniquePath(dir, `${title} - ${stamp(now)}`, ext);
    await fsp.writeFile(file, Buffer.from(data.buffer));

    const id = `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    let thumb = null;
    if (data.thumb && data.thumb.startsWith('data:image/')) {
      await fsp.mkdir(thumbsDir(), { recursive: true });
      thumb = path.join(thumbsDir(), `${id}.jpg`);
      await fsp.writeFile(thumb, Buffer.from(data.thumb.split(',')[1], 'base64'));
    }
    const entry = {
      id,
      title: safeName(data.title),
      file,
      thumb,
      duration: Number(data.duration) || 0,
      size: data.buffer.byteLength,
      createdAt: now.toISOString()
    };
    const list = readLibrary();
    list.unshift(entry);
    writeLibrary(list);

    if (settings.showAfterRecording && !SELFTEST) showMain();
    if (SELFTEST) {
      console.log(`SELFTEST_SAVED ${file} ${entry.size} bytes, ${entry.duration}s, thumb=${!!thumb}`);
      setTimeout(() => { quitting = true; app.quit(); }, 300);
    }
    return toClientClip(entry);
  });

  ipcMain.handle('clips:list', () => {
    const list = readLibrary();
    const alive = list.filter((c) => fs.existsSync(c.file));
    if (alive.length !== list.length) writeLibrary(alive);
    return alive.map(toClientClip);
  });

  ipcMain.handle('clip:rename', async (_e, { id, title }) => {
    const list = readLibrary();
    const c = list.find((x) => x.id === id);
    if (!c) return null;
    const clean = safeName(title);
    const ext = path.extname(c.file);
    const created = new Date(c.createdAt);
    const base = `${clean || (settings.language === 'ar' ? 'تعليق' : 'Comment')} - ${stamp(created)}`;
    const target = path.join(path.dirname(c.file), base + ext);
    if (target !== c.file) {
      const finalPath = fs.existsSync(target) ? uniquePath(path.dirname(c.file), base, ext) : target;
      try {
        await fsp.rename(c.file, finalPath);
        c.file = finalPath;
      } catch {
        // file is open elsewhere; keep the old name on disk but update the title
      }
    }
    c.title = clean;
    writeLibrary(list);
    return toClientClip(c);
  });

  ipcMain.handle('clip:delete', async (_e, id) => {
    const list = readLibrary();
    const c = list.find((x) => x.id === id);
    if (!c) return false;
    try { await shell.trashItem(c.file); } catch { /* already gone */ }
    if (c.thumb) { try { await fsp.unlink(c.thumb); } catch { /* ignore */ } }
    writeLibrary(list.filter((x) => x.id !== id));
    return true;
  });

  ipcMain.handle('clip:reveal', (_e, id) => {
    const c = readLibrary().find((x) => x.id === id);
    if (c) shell.showItemInFolder(c.file);
  });

  ipcMain.handle('clip:open', (_e, id) => {
    const c = readLibrary().find((x) => x.id === id);
    if (c) shell.openPath(c.file);
  });

  // Drag a clip out of the app straight into WhatsApp, Telegram, email, etc.
  ipcMain.on('clip:drag', (e, id) => {
    const c = readLibrary().find((x) => x.id === id);
    if (!c || !fs.existsSync(c.file)) return;
    let icon = c.thumb && fs.existsSync(c.thumb) ? nativeImage.createFromPath(c.thumb) : nativeImage.createFromPath(iconPath('icon-256.png'));
    if (!icon.isEmpty()) icon = icon.resize({ width: 96 });
    e.sender.startDrag({ file: c.file, icon });
  });

  ipcMain.handle('folder:choose', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      defaultPath: settings.saveDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.saveDir = r.filePaths[0];
    saveSettings();
    return settings.saveDir;
  });

  ipcMain.handle('folder:open', () => openSaveDir());

  ipcMain.handle('perm:status', () => {
    if (!isMac) return { screen: 'granted', microphone: 'granted' };
    return {
      screen: systemPreferences.getMediaAccessStatus('screen'),
      microphone: systemPreferences.getMediaAccessStatus('microphone')
    };
  });

  ipcMain.handle('perm:requestMic', async () => {
    if (!isMac) return true;
    return systemPreferences.askForMediaAccess('microphone');
  });

  ipcMain.handle('perm:openSettings', (_e, which) => {
    if (isMac) {
      const pane = which === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
      shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    } else if (isWin) {
      shell.openExternal(which === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy');
    }
  });

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    quitting = true;
    app.exit(0);
  });

  ipcMain.on('app:selftest-failed', (_e, msg) => {
    if (SELFTEST) {
      console.log(`SELFTEST_FAILED ${msg}`);
      quitting = true;
      app.quit();
    }
  });
}

// ---------- app lifecycle ----------
app.on('second-instance', showMain);

app.whenReady().then(() => {
  loadSettings();
  if (isWin) app.setAppUserModelId('com.procorrector.app');

  // Allow camera/mic/screen access for our own windows only.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ['media', 'display-capture'].includes(permission));

  // getDisplayMedia() in the renderer is answered with the screen chosen in recorder:prepare,
  // so the teacher never sees a picker in the middle of a correction.
  ses.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      let source = pendingSource;
      if (!source) {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        source = sources[0];
      }
      callback(source ? { video: source } : {});
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });

  registerIpc();
  createMainWindow();
  createIndicator();
  createTray();

  if (!registerHotkey(settings.hotkey)) {
    // Fall back to a combination that is rarely taken.
    const fallback = isMac ? 'Alt+Command+R' : 'Ctrl+Alt+R';
    if (registerHotkey(fallback)) {
      settings.hotkey = fallback;
      saveSettings();
      updateTray();
    }
  }

  if (SELFTEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => sendCommand('selftest'), 800);
    });
  }

  app.on('activate', showMain);
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => {
  // Stay alive in the tray / menu bar.
  if (!quitting) e.preventDefault?.();
});
