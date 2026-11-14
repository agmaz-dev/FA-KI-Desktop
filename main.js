'use strict';
const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const ollama = require('./lib/ollama');
const { SpeechManager } = require('./lib/speech');
const { downloadFile } = require('./lib/downloader');

let win = null;
let store = null;
let speech = null;
const chatControllers = new Map();
let pullController = null;
let ocrWorker = null;

const send = (ch, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'FA KI Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'build', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    store = new Store(dataDir);
    speech = new SpeechManager(dataDir, (p) => send('speech:progress', p), app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build-bundled'));

    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media' || permission === 'clipboard-sanitized-write');
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

const base = () => store.getSettings().ollamaUrl;

function registerIpc() {
  // ---------- Einstellungen & Chats ----------
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));
  ipcMain.handle('chats:list', () => store.listChats());
  ipcMain.handle('chats:load', (_e, id) => store.loadChat(id));
  ipcMain.handle('chats:save', (_e, chat) => store.saveChat(chat));
  ipcMain.handle('chats:delete', (_e, id) => store.deleteChat(id));
  ipcMain.handle('chats:export', async (_e, { title, markdown }) => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: (title || 'Chat').replace(/[\\/:*?"<>|]/g, '_') + '.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, markdown, 'utf8');
    return true;
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataDir: app.getPath('userData') }));
  ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));

  // ---------- Dateien wählen ----------
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF und Bilder', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        { name: 'Textdateien', extensions: ['txt', 'md', 'csv', 'json', 'eml', 'log'] },
      ],
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => {
      const buf = fs.readFileSync(p);
      return { name: path.basename(p), data: buf };
    });
  });

  // ---------- Ollama ----------
  ipcMain.handle('ollama:status', async () => {
    try {
      const v = await ollama.version(base());
      return { ok: true, version: v };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('ollama:models', async () => {
    const list = await ollama.tags(base());
    return list.map((m) => ({
      name: m.name,
      size: m.size,
      remote: !!(m.remote_host || m.remote_model || /:cloud$|-cloud$/i.test(m.name)),
      details: m.details || {},
    }));
  });
  ipcMain.handle('ollama:show', async (_e, name) => {
    const d = await ollama.show(base(), name);
    return { capabilities: d.capabilities || [], details: d.details || {} };
  });
  ipcMain.handle('ollama:delete', (_e, name) => ollama.deleteModel(base(), name));
  ipcMain.handle('ollama:pull', async (_e, name) => {
    if (pullController) throw new Error('Es läuft schon ein Download.');
    pullController = new AbortController();
    try {
      await ollama.pullStream(base(), name, (o) => {
        send('ollama:pullProgress', {
          name, status: o.status, total: o.total || 0, completed: o.completed || 0,
        });
      }, pullController.signal);
      return true;
    } finally {
      pullController = null;
    }
  });
  ipcMain.handle('ollama:pullCancel', () => { if (pullController) pullController.abort(); return true; });

  ipcMain.handle('chat:start', async (_e, { id, body }) => {
    const ctrl = new AbortController();
    chatControllers.set(id, ctrl);
    let stats = null;
    try {
      await ollama.chatStream(base(), body, (o) => {
        const m = o.message || {};
        if (m.content || m.thinking) send('chat:delta', { id, content: m.content || '', thinking: m.thinking || '' });
        if (o.done) stats = { evalCount: o.eval_count, evalDuration: o.eval_duration, doneReason: o.done_reason };
      }, ctrl.signal);
      send('chat:done', { id, stats });
    } catch (e) {
      if (ctrl.signal.aborted) send('chat:done', { id, stats, aborted: true });
      else send('chat:error', { id, error: String(e.message || e) });
    } finally {
      chatControllers.delete(id);
    }
    return true;
  });
  ipcMain.handle('chat:stop', (_e, id) => { const c = chatControllers.get(id); if (c) c.abort(); return true; });

  // ---------- Texterkennung (OCR) ----------
  ipcMain.handle('ocr:run', async (_e, { image }) => {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(Buffer.from(image));
    return (data && data.text) || '';
  });

  // ---------- Sprache ----------
  ipcMain.handle('speech:status', () => speech.status());
  ipcMain.handle('speech:prepareStt', (_e, model) => speech.prepareStt(model));
  ipcMain.handle('speech:prepareTts', (_e, voice) => speech.prepareTts(voice));
  ipcMain.handle('speech:abort', (_e, task) => { speech.abort(task); return true; });
  ipcMain.handle('speech:transcribe', (_e, { wav, lang, model }) => speech.transcribe(wav, lang, model));
  ipcMain.handle('speech:synthesize', (_e, { text, voice }) => speech.synthesize(text, voice));
}

async function ensureTessData() {
  const dir = path.join(app.getPath('userData'), 'tessdata');
  fs.mkdirSync(dir, { recursive: true });
  for (const l of ['deu', 'tur']) {
    const f = path.join(dir, l + '.traineddata');
    if (fs.existsSync(f)) continue;
    const label = 'OCR-Sprachdaten ' + l;
    send('speech:progress', { task: 'ocr', label, pct: null });
    const urls = [
      `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/${l}.traineddata`,
      `https://github.com/tesseract-ocr/tessdata_fast/raw/main/${l}.traineddata`,
      `https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/${l}.traineddata`,
    ];
    let lastErr;
    for (const u of urls) {
      try {
        await downloadFile(u, f, ({ received, total }) => send('speech:progress', { task: 'ocr', label, received, total, pct: total ? Math.round((received / total) * 100) : null }));
        lastErr = null;
        break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw new Error('OCR-Sprachdaten konnten nicht geladen werden: ' + lastErr.message);
  }
  return dir;
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const langPath = await ensureTessData();
  const { createWorker } = require('tesseract.js');
  ocrWorker = await createWorker('deu+tur', 1, {
    langPath,
    cachePath: langPath,
    gzip: false,
  });
  return ocrWorker;
}

app.on('before-quit', () => {
  if (ocrWorker) { ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
});
