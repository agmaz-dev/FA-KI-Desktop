'use strict';
const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const ollama = require('./lib/ollama');
const { SpeechManager } = require('./lib/speech');
const { downloadFile } = require('./lib/downloader');
const { Procs } = require('./lib/procs');
const { renderPdf, buildDocx } = require('./lib/export');
const { VoiceInstaller } = require('./lib/voiceinstall');

let win = null;
let store = null;
let speech = null;
const chatControllers = new Map();
let pullController = null;
let ocrWorker = null;
let voiceInst = null;
const procs = new Procs();

const send = (ch, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#262624',
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

    voiceInst = new VoiceInstaller(dataDir, path.join(__dirname, 'voice-server', 'voice_server.py'), (p) => send('voice:progress', p));
    registerIpc();
    createWindow();
    const st = store.getSettings();
    if (st.autoStartOllama && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(st.ollamaUrl)) {
      procs.ensureOllama(st.ollamaUrl).then((r) => send('app:ollamaStart', r)).catch(() => {});
    }
    if (st.ttsServerAuto && st.ttsEngine === 'server') procs.ensureTtsServer(st).then((r) => send('app:ttsStart', r)).catch(() => {});
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
  ipcMain.handle('chats:clear', () => store.clearChats());
  ipcMain.handle('chats:export', async (_e, { title, markdown, format }) => {
    const safe = (title || 'Dokument').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const all = {
      pdf: { name: 'PDF-Dokument', extensions: ['pdf'] },
      docx: { name: 'Word-Dokument', extensions: ['docx'] },
      md: { name: 'Markdown', extensions: ['md'] },
    };
    const first = all[format] ? format : 'pdf';
    const order = [first, ...Object.keys(all).filter((k) => k !== first)];
    const r = await dialog.showSaveDialog(win, {
      defaultPath: safe + '.' + first,
      filters: order.map((k) => all[k]),
    });
    if (r.canceled || !r.filePath) return false;
    const ext = path.extname(r.filePath).slice(1).toLowerCase();
    if (ext === 'pdf') fs.writeFileSync(r.filePath, await renderPdf(BrowserWindow, markdown, title));
    else if (ext === 'docx') fs.writeFileSync(r.filePath, buildDocx(markdown, title));
    else fs.writeFileSync(r.filePath, markdown, 'utf8');
    return r.filePath;
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
  ipcMain.handle('speech:synthesize', (_e, { text, voice, speed }) => {
    const s = store.getSettings();
    if (s.ttsEngine === 'server' && !(s.ttsServerLangs === 'de' && voice === 'tr')) return speech.synthesizeServer(text, voice, s, speed);
    return speech.synthesize(text, voice, speed);
  });
  ipcMain.handle('speech:serverVoices', (_e, url) => speech.serverVoices(url));
  ipcMain.handle('speech:cancelSynth', () => speech.cancelServer(store.getSettings().ttsServerUrl));
  ipcMain.handle('speech:startServer', () => procs.ensureTtsServer(store.getSettings()));
  ipcMain.handle('speech:pickSample', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Sprachaufnahme', extensions: ['wav', 'mp3', 'flac', 'ogg'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const s = store.getSettings();
    const name = path.basename(r.filePaths[0]).replace(/[^A-Za-z0-9._-]/g, '_');
    const keep = path.join(app.getPath('userData'), 'voices');
    fs.mkdirSync(keep, { recursive: true });
    fs.copyFileSync(r.filePaths[0], path.join(keep, name));
    const notes = ['Gespeichert in den App-Daten.'];
    // In den Ordner des Stimmen-Servers kopieren, damit er die Probe findet.
    if (s.ttsServerDir && fs.existsSync(s.ttsServerDir)) {
      try {
        const refDir = path.join(s.ttsServerDir, 'reference_audio');
        fs.mkdirSync(refDir, { recursive: true });
        fs.copyFileSync(r.filePaths[0], path.join(refDir, name));
        notes.push('In den Ordner reference_audio des Stimmen-Servers kopiert.');
      } catch (e) { notes.push('Kopieren in den Server-Ordner fehlgeschlagen: ' + e.message); }
    }
    store.setSettings({ ttsSampleFile: name });
    return { name, notes };
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('voice:status', () => voiceInst.status());
  ipcMain.handle('voice:cancel', () => { voiceInst.cancel(); return true; });
  ipcMain.handle('voice:setup', async (_e, opts) => {
    const mode = opts && opts.mode ? String(opts.mode) : (opts && opts.gpu ? 'gpu' : 'cpu');
    const before = store.getSettings();
    try {
      const r = await voiceInst.install(mode);
      const sample = before.ttsSampleFile || '';
      const apply = (cmd, langs) => store.setSettings({
        ttsEngine: 'server', ttsServerUrl: voiceInst.url(), ttsServerDir: r.dir, ttsServerCmd: cmd,
        ttsServerAuto: true, ttsServerModel: 'chatterbox', ttsServerVoice: '', ttsServerVoiceTr: '', ttsServerLangs: langs,
      });
      const oldCmd = before.ttsServerCmd;
      const oldLangs = before.ttsServerLangs || 'all';
      await speech.cancelServer(voiceInst.url());
      await procs.stop('tts');
      await procs.freePort(voiceInst.url());
      apply(r.cmd, mode === 'oute' ? 'de' : 'all');
      let st = await procs.ensureTtsServer(store.getSettings());
      try {
        if (!st.ok) throw new Error(st.error);
        const ready = await voiceInst.waitReady();
        const want = mode === 'oute' ? 'oute' : 'chatterbox';
        if ((ready.engine || 'chatterbox') !== want) {
          throw new Error('Auf Port 8004 läuft noch ein alter Stimmen-Server und hat den neuen verdrängt. Beende die App, im Task-Manager alle „python.exe“ (Details) und starte sie neu.');
        }
        send('voice:progress', { text: 'Testsatz wird erzeugt (1/2) …', pct: 92 });
        const cold = await voiceInst.benchmark(sample);
        send('voice:progress', { text: 'Testsatz wird erzeugt (2/2) …', pct: 96 });
        const warm = await voiceInst.benchmark(sample);
        send('voice:progress', { text: 'Fertig.', pct: 100 });
        return { ok: true, seconds: warm.seconds, cold: cold.seconds, device: ready.detail, mode, settings: store.getSettings() };
      } catch (e) {
        // Neue Einrichtung läuft nicht: alten Stand wiederherstellen
        await procs.stop('tts');
        if (oldCmd) { apply(oldCmd, oldLangs); procs.ensureTtsServer(store.getSettings()).catch(() => {}); }
        throw e;
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e), settings: store.getSettings() };
    }
  });
  ipcMain.handle('ollama:ensure', () => procs.ensureOllama(base()));
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
  procs.killAll();
  if (ocrWorker) { ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
});
