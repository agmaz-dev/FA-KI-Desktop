'use strict';
const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store, DEFAULT_SETTINGS } = require('./lib/store');
const ollama = require('./lib/ollama');
const { SpeechManager, VOICES } = require('./lib/speech');
const { downloadFile } = require('./lib/downloader');
const { Procs } = require('./lib/procs');
const { renderPdf, buildDocx } = require('./lib/export');
const { VoiceInstaller } = require('./lib/voiceinstall');
const { Supertonic } = require('./lib/supertonic');
const tools = require('./lib/tools');
const github = require('./lib/github');
const agent = require('./lib/agent');
const hf = require('./lib/hf');

let win = null;
let store = null;
let speech = null;
const chatControllers = new Map();
let pullController = null;
let ocrWorker = null;
let voiceInst = null;
let supertonic = null;
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
  // Menüleiste bleibt versteckt, aber Bearbeiten-Tastenkürzel (Einfügen, Kopieren …) funktionieren.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Bearbeiten', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  win.setMenuBarVisibility(false);
  win.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.isEditable) {
      items.push({ label: 'Ausschneiden', role: 'cut', enabled: params.editFlags.canCut }, { label: 'Kopieren', role: 'copy', enabled: params.editFlags.canCopy }, { label: 'Einfügen', role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { label: 'Alles auswählen', role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ label: 'Kopieren', role: 'copy' }, { label: 'Alles auswählen', role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
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
    supertonic = new Supertonic(dataDir, (p) => send('speech:progress', p));
    speech = new SpeechManager(dataDir, (p) => send('speech:progress', p), app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build-bundled'));

    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media' || permission === 'clipboard-sanitized-write');
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

    voiceInst = new VoiceInstaller(dataDir, path.join(__dirname, 'voice-server', 'oute_server.py'), (p) => send('voice:progress', p));
    registerIpc();
    createWindow();
    // Bevorzugte Piper-Stimme (Kerstin, dfki) still nachladen, falls sie fehlt oder nicht lesbar war
    setTimeout(async () => {
      try {
        if (!speech.piperBin()) return;
        // Nur wenn Piper wirklich spricht (Motor Piper, oder OuteTTS mit Piper für Türkisch/Rückfall).
        // Bei Supertonic wird nichts im Hintergrund geladen.
        const eng = store.getSettings().ttsEngine;
        if (eng !== 'piper' && eng !== 'server') return;
        for (const k of ['de', 'tr']) {
          const iv = speech.installedVoice(k);
          const want = VOICES[k].names[0];
          if (!iv || !iv.id.split('-').includes(want)) await speech.prepareTts(k);
        }
      } catch { /* egal, dann bleibt die vorhandene Stimme */ }
    }, 5000);
    // Spracherkennung vorwärmen: whisper-server lädt das Modell einmal und behält es im Speicher.
    setTimeout(() => { speech.warmStt(store.getSettings().sttModel); }, 3000);
    let st = store.getSettings();
    // Frühere Versionen: alter Chatterbox-Server ist abgeschafft -> zurück auf Piper
    if (/voice_server\.py/.test(st.ttsServerCmd || '')) {
      store.setSettings({ ttsEngine: 'piper', ttsServerAuto: false, ttsServerCmd: '', ttsServerLangs: 'all' });
      st = store.getSettings();
    }
    if (st.autoStartOllama && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(st.ollamaUrl)) {
      procs.ensureOllama(st.ollamaUrl).then((r) => send('app:ollamaStart', r)).catch(() => {});
    }
    voiceInst.syncServer();
    if (st.ttsServerAuto && st.ttsEngine === 'server') {
      procs.ensureTtsServer(st).then(async (r) => {
        send('app:ttsStart', r);
        // Vorwärmen: Modell und Stimmprofil laden, damit der erste echte Satz sofort kommt
        if (r && r.ok) {
          try { await voiceInst.waitReady(); await speech.synthesizeServer('Hallo.', 'de', store.getSettings(), 1); } catch { /* egal */ }
        }
      }).catch(() => {});
    }
  });
  app.on('window-all-closed', () => app.quit());
}

const base = () => store.getSettings().ollamaUrl;

// Diese Felder setzt nur der Hauptprozess (sie werden als Befehl ausgeführt bzw. als Arbeitsordner benutzt).
const MAIN_ONLY_SETTINGS = new Set(['ttsServerCmd', 'ttsServerDir', 'githubTokenEnc', 'agentDir']);

// GitHub-Token: verschlüsselt (Windows-Anmeldedaten) im Hauptprozess; die Oberfläche sieht ihn nie.
function getGithubToken() {
  const enc = store.getSettings().githubTokenEnc || '';
  if (!enc) return '';
  try {
    if (enc.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(enc.slice(4), 'base64'));
    if (enc.startsWith('raw:')) return enc.slice(4);
  } catch { /* nicht lesbar */ }
  return '';
}
function setGithubToken(token) {
  let enc = '';
  if (token) enc = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(token).toString('base64') : 'raw:' + token;
  store.setSettings({ githubTokenEnc: enc });
}
// Bestätigungen für Agent-Aktionen. „Immer erlauben“ gilt nur je Chat und Art, nie für Löschen und Zusammenführen.
const autoAllow = new Map();
const NEVER_AUTO = new Set(['datei-loeschen', 'github-merge']);
async function confirmAction(chatId, req) {
  const set = autoAllow.get(chatId) || new Set();
  const canAuto = !NEVER_AUTO.has(req.kategorie);
  if (canAuto && set.has(req.kategorie)) return true;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Erlauben', 'Ablehnen'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'FA KI Desktop – Bestätigung', message: req.titel, detail: req.detail || '',
    ...(canAuto ? { checkboxLabel: 'Weitere Aktionen dieser Art in diesem Chat ohne Nachfrage erlauben', checkboxChecked: false } : {}),
  });
  if (r.response !== 0) return false;
  if (canAuto && r.checkboxChecked) { set.add(req.kategorie); autoAllow.set(chatId, set); }
  return true;
}

/** Einstellungen für die Oberfläche: ohne Token, mit Hinweis, ob einer da ist. */
function publicSettings(s) {
  const { githubTokenEnc, ...rest } = s;
  return { ...rest, githubHasToken: !!githubTokenEnc };
}
/** Lässt aus der Oberfläche nur bekannte, unkritische Einstellungen durch. */
function filterRendererSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k) && !MAIN_ONLY_SETTINGS.has(k)) out[k] = v;
  }
  return out;
}

function registerIpc() {
  // ---------- Einstellungen & Chats ----------
  ipcMain.handle('settings:get', () => publicSettings(store.getSettings()));
  ipcMain.handle('settings:set', (_e, patch) => publicSettings(store.setSettings(filterRendererSettings(patch))));
  ipcMain.handle('github:setToken', async (_e, token) => {
    const t = String(token || '').trim();
    if (!t) { setGithubToken(''); return { ok: true, login: '' }; }
    try {
      const login = await github.whoami(t);
      setGithubToken(t);
      return { ok: true, login };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });
  ipcMain.handle('github:test', async () => {
    const t = getGithubToken();
    if (!t) return { ok: false, error: 'Kein Token gespeichert' };
    try { return { ok: true, login: await github.whoami(t) }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('agent:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Arbeitsordner für die KI wählen', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return publicSettings(store.getSettings());
    return publicSettings(store.setSettings({ agentDir: r.filePaths[0] }));
  });
  ipcMain.handle('agent:clearDir', () => publicSettings(store.setSettings({ agentDir: '' })));
  ipcMain.handle('agent:check', () => agent.checkTools());
  ipcMain.handle('agent:openDir', () => { const d = store.getSettings().agentDir; return d ? shell.openPath(d) : ''; });
  ipcMain.handle('hf:search', (_e, { query, sort }) => hf.search(query, { sort }));
  ipcMain.handle('hf:details', (_e, id) => hf.details(id, { vramGb: store.getSettings().vramGb, ramGb: store.getSettings().ramGb }));
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
      modified: m.modified_at || '',
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
    if (!hf.okPullName(name)) throw new Error('Ungültiger Modellname.');
    if (pullController) throw new Error('Es läuft schon ein Download.');
    pullController = new AbortController();
    try {
      await ollama.pullStream(base(), name, (o) => {
        send('ollama:pullProgress', {
          name, status: o.status, total: o.total || 0, completed: o.completed || 0,
        });
      }, pullController.signal);
      return true;
    } catch (e) {
      if (pullController && pullController.signal.aborted) return { aborted: true };
      throw e;
    } finally {
      pullController = null;
    }
  });
  ipcMain.handle('ollama:pullCancel', () => { if (pullController) pullController.abort(); return true; });

  ipcMain.handle('chat:start', async (_e, { id, chatId, body, useTools }) => {
    const ctrl = new AbortController();
    chatControllers.set(id, ctrl);
    let stats = null;
    try {
      const onObj = (o) => {
        const m = o.message || {};
        if (m.content || m.thinking) send('chat:delta', { id, content: m.content || '', thinking: m.thinking || '' });
        if (o.done) stats = { evalCount: o.eval_count, evalDuration: o.eval_duration, doneReason: o.done_reason, promptCount: o.prompt_eval_count };
      };
      const toolList = useTools ? tools.toolsFor(store.getSettings()) : [];
      if (toolList.length) {
        await tools.chatWithTools({
          chatStream: (b, cb, sig) => ollama.chatStream(base(), b, cb, sig),
          body, tools: toolList, signal: ctrl.signal, onObj,
          ctx: { getToken: getGithubToken, agentDir: store.getSettings().agentDir, confirm: (req) => confirmAction(String(chatId || id), req) },
          onTool: ({ label }) => send('chat:tool', { id, label }),
        });
      } else {
        await ollama.chatStream(base(), body, onObj, ctrl.signal);
      }
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
  ipcMain.handle('speech:status', () => ({ ...speech.status(), supertonic: supertonic.status() }));
  ipcMain.handle('speech:prepareStt', (_e, model) => speech.prepareStt(model));
  ipcMain.handle('speech:prepareTts', (_e, voice) => speech.prepareTts(voice));
  ipcMain.handle('speech:abort', (_e, task) => { speech.abort(task); return true; });
  ipcMain.handle('speech:transcribe', (_e, { wav, lang, model }) => speech.transcribe(wav, lang, model));
  ipcMain.handle('speech:warmStt', (_e, model) => speech.warmStt(model || store.getSettings().sttModel));
  ipcMain.handle('speech:synthesize', (_e, { text, voice, speed, piper }) => {
    const s = store.getSettings();
    if (!piper && s.ttsEngine === 'supertonic') return supertonic.synthesize(text, voice, s.ttsStVoice || 'elena', speed);
    if (!piper && s.ttsEngine === 'server' && !(s.ttsServerLangs === 'de' && voice === 'tr')) return speech.synthesizeServer(text, voice, s, speed);
    return speech.synthesize(text, voice, speed);
  });
  ipcMain.handle('supertonic:cancel', () => { supertonic.abort(); supertonic.cancel(); return true; });
  ipcMain.handle('supertonic:setup', async () => {
    try {
      await supertonic.prepare();
      const t0 = Date.now();
      await supertonic.synthesize('Hallo, das ist ein kurzer Test.', 'de', store.getSettings().ttsStVoice || 'elena', 1);
      const seconds = (Date.now() - t0) / 1000;
      const settings = store.setSettings({ ttsEngine: 'supertonic', ttsSpeed: 1, ttsStVoice: store.getSettings().ttsStVoice || 'elena' });
      return { ok: true, seconds, settings: { ttsEngine: 'supertonic', ttsSpeed: 1, ttsStVoice: (settings && settings.ttsStVoice) || 'elena' } };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('speech:serverVoices', (_e, url) => speech.serverVoices(url));
  ipcMain.handle('speech:cancelSynth', async () => {
    // Stopp gilt für alle Stimmen-Motoren: Supertonic (läuft in der App) und den OuteTTS-Server.
    supertonic.cancel();
    const s = store.getSettings();
    if (s.ttsEngine === 'server') await speech.cancelServer(s.ttsServerUrl);
    return true;
  });
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
  ipcMain.handle('voice:cleanOld', () => ({ removed: voiceInst.cleanOld() }));
  ipcMain.handle('voice:setup', async () => {
    const before = store.getSettings();
    const sampleName = path.basename(String(before.ttsSampleFile || ''));
    if (!sampleName || !fs.existsSync(path.join(app.getPath('userData'), 'voices', sampleName))) {
      return { ok: false, error: 'Keine Stimmprobe gefunden. Bitte zuerst „Aufnahme wählen …“ und eine 10–18 Sekunden lange WAV-Aufnahme auswählen – erst dann wird geladen.', settings: before };
    }
    try {
      const r = await voiceInst.install();
      const sample = before.ttsSampleFile || '';
      const apply = (cmd) => store.setSettings({
        ttsEngine: 'server', ttsServerUrl: voiceInst.url(), ttsServerDir: r.dir, ttsServerCmd: cmd,
        ttsServerAuto: true, ttsServerModel: 'oute', ttsServerVoice: '', ttsServerVoiceTr: '', ttsServerLangs: 'de',
      });
      await speech.cancelServer(voiceInst.url());
      await procs.stop('tts');
      await procs.freePort(voiceInst.url(), path.join(app.getPath('userData'), 'voice'));
      apply(r.cmd);
      const st = await procs.ensureTtsServer(store.getSettings());
      try {
        if (!st.ok) throw new Error(st.error);
        const ready = await voiceInst.waitReady();
        if (ready.engine !== 'oute') {
          throw new Error('Auf Port 8004 läuft noch ein alter Stimmen-Server und hat den neuen verdrängt. Beende die App, im Task-Manager alle „python.exe“ (Details) und starte sie neu.');
        }
        send('voice:progress', { text: 'Testsatz wird erzeugt (1/2) …', pct: 92 });
        const cold = await voiceInst.benchmark(sample);
        send('voice:progress', { text: 'Testsatz wird erzeugt (2/2) …', pct: 96 });
        const warm = await voiceInst.benchmark(sample);
        send('voice:progress', { text: 'Fertig.', pct: 100 });
        return { ok: true, seconds: warm.seconds, cold: cold.seconds, device: ready.detail, settings: publicSettings(store.getSettings()) };
      } catch (e) {
        await procs.stop('tts');
        await procs.freePort(voiceInst.url(), path.join(app.getPath('userData'), 'voice'));
        if (/oute_server\.py/.test(before.ttsServerCmd || '')) { apply(before.ttsServerCmd); procs.ensureTtsServer(store.getSettings()).catch(() => {}); }
        else store.setSettings({ ttsEngine: 'piper', ttsServerAuto: false });
        throw e;
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e), settings: publicSettings(store.getSettings()) };
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
  if (speech) speech.stopWhisperServer();
  if (ocrWorker) { ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
});
