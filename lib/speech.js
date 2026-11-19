'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const net = require('net');
const { downloadFile, findFile } = require('./downloader');
const { cleanTranscript } = require('./util');

const PIPER_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

const HF_VOICES = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const VOICES = {
  de: { region: 'de_DE', label: 'Deutsch', approx: '60–110 MB', names: ['kerstin'],
        guess: ['de/de_DE/kerstin/low/de_DE-kerstin-low'] },
  tr: { region: 'tr_TR', label: 'Türkisch', approx: '60 MB', names: ['dfki', 'fettah', 'fahrettin'],
        guess: ['tr/tr_TR/dfki/medium/tr_TR-dfki-medium', 'tr/tr_TR/fettah/medium/tr_TR-fettah-medium', 'tr/tr_TR/fahrettin/medium/tr_TR-fahrettin-medium'] },
};
const QUALITY = { high: 3, medium: 2, low: 1, x_low: 0 };

/** Das mitgelieferte Piper ist von 2023: neuere Stimmen mit Mehrzeichen-Lauten (z. B. „aɪ“) kann es nicht lesen. */
function voiceCompatible(jsonPath) {
  try {
    const d = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return !Object.keys(d.phoneme_id_map || {}).some((k) => Array.from(k).length > 1);
  } catch { return false; }
}

/** Je kleiner, desto besser: erst die bevorzugten Sprecher, dann die Qualität. */
function rankVoice(key, id) {
  const parts = String(id).split('-');
  const name = parts[1] || '';
  const q = QUALITY[parts[2]] ?? 0;
  const ni = VOICES[key].names.indexOf(name);
  return (ni < 0 ? 50 : ni) * 10 + (3 - q);
}

const WHISPER_MODELS = {
  base: { file: 'ggml-base.bin', approx: '150 MB' },
  small: { file: 'ggml-small.bin', approx: '470 MB' },
  medium: { file: 'ggml-medium.bin', approx: '1,5 GB' },
};
const WHISPER_MODEL_HOSTS = [
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  'https://huggingface.co/ggml-org/whisper.cpp/resolve/main',
];

function extractZip(zipPath, destDir) {
  const AdmZip = require('adm-zip');
  fs.mkdirSync(destDir, { recursive: true });
  new AdmZip(zipPath).extractAllTo(destDir, true);
}

/** Fügt Ausgabe-Blöcke (Buffer) zusammen und dekodiert sie einmal als UTF-8. */
function decodeChunks(chunks) {
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
}

function run(cmd, args, { cwd, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    // Rohbytes sammeln und erst am Ende dekodieren: sonst zerfallen Umlaute,
    // wenn ein Mehrbyte-Zeichen (z. B. „ü“) genau an einer Blockgrenze liegt.
    const so = [];
    const se = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Zeitüberschreitung beim Ausführen von ' + path.basename(cmd)));
    }, timeoutMs);
    child.stdout.on('data', (d) => so.push(d));
    child.stderr.on('data', (d) => se.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = decodeChunks(so);
      const err = decodeChunks(se);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} beendete sich mit Fehler ${code}: ${(err || out).slice(-400)}`));
    });
    if (input != null) child.stdin.end(input);
  });
}

/** Wählt aus der Liste der Release-Dateien das passende Windows-x64-Paket von whisper.cpp. */
function pickWhisperAsset(assets) {
  const names = (assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
  const good = names.filter((a) => /\.zip$/i.test(a.name) && /(win|x64)/i.test(a.name));
  const bad = /(cublas|cuda|blas|vulkan|arm|win32|x86(?!_64)|openvino|xcframework|jni|android)/i;
  const preferred = good.filter((a) => !bad.test(a.name));
  const pool = preferred.length ? preferred : good;
  pool.sort((a, b) => {
    const score = (n) => (/bin/i.test(n) ? 2 : 0) + (/x64/i.test(n) ? 1 : 0);
    return score(b.name) - score(a.name);
  });
  return pool[0] || null;
}

/** Dauer einer 16-bit-Mono-WAV mit 16 kHz (Kopf 44 Byte) in Sekunden. */
function wavSeconds(buf) {
  return Math.max(0, (buf.length - 44) / 32000);
}

/**
 * Audio-Kontext für Whisper passend zur Aufnahmelänge (1500 = volle 30 s, 50 pro Sekunde).
 * Whisper rechnet sonst immer ein 30-s-Fenster, auch für 3 s Sprache – das kostet die meiste Zeit.
 * Mindestens 768 (≈ 15 s) und 2,5 s Reserve: darunter neigt Whisper zu Wiederholungen.
 */
function audioCtxFor(seconds) {
  if (!(seconds > 0) || seconds > 27) return 0; // 0 = volles Fenster
  const want = Math.ceil(((seconds + 2.5) * 50) / 64) * 64;
  return Math.min(1500, Math.max(768, want));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill();
  } catch { /* egal */ }
}

const WHISPER_IDLE_MS = 15 * 60 * 1000; // danach Modell aus dem Speicher nehmen

class SpeechManager {
  constructor(dataDir, emitProgress, bundledDir) {
    this.dir = dataDir;
    this.bundledDir = bundledDir || null;
    this.emit = emitProgress || (() => {});
    this.whisperDir = path.join(dataDir, 'whisper');
    this.piperDir = path.join(dataDir, 'piper');
    this.voiceDir = path.join(dataDir, 'voices');
    this.tmp = path.join(os.tmpdir(), 'fa-ki-desktop');
    fs.mkdirSync(this.tmp, { recursive: true });
    this.controllers = new Map();
    this.ws = null; // laufender whisper-server { child, model, url, ready }
    this.wsTimer = null;
  }

  // ---------- Pfade ----------
  whisperBin() {
    const names = ['whisper-cli.exe', 'main.exe', 'whisper-cli'];
    if (this.bundledDir) {
      const b = findFile(path.join(this.bundledDir, 'whisper'), names);
      if (b) return b;
    }
    return findFile(path.join(this.whisperDir, 'bin'), names);
  }
  whisperServerBin() {
    const names = ['whisper-server.exe', 'whisper-server'];
    if (this.bundledDir) {
      const b = findFile(path.join(this.bundledDir, 'whisper'), names);
      if (b) return b;
    }
    return findFile(path.join(this.whisperDir, 'bin'), names);
  }
  whisperModelPath(model) {
    const m = WHISPER_MODELS[model] || WHISPER_MODELS.small;
    return path.join(this.whisperDir, 'models', m.file);
  }
  piperBin() {
    return findFile(this.piperDir, ['piper.exe', 'piper']);
  }
  /** Beste bereits geladene Piper-Stimme für 'de' oder 'tr' (oder null). */
  installedVoice(key) {
    const v = VOICES[key];
    if (!v) throw new Error('Unbekannte Stimme: ' + key);
    let files = [];
    try { files = fs.readdirSync(this.voiceDir); } catch { return null; }
    const ids = files
      .filter((f) => f.startsWith(v.region + '-') && f.endsWith('.onnx') && files.includes(f + '.json') && voiceCompatible(path.join(this.voiceDir, f + '.json')))
      .map((f) => f.slice(0, -5));
    if (!ids.length) return null;
    ids.sort((x, y) => rankVoice(key, x) - rankVoice(key, y));
    const id = ids[0];
    return { id, onnx: path.join(this.voiceDir, id + '.onnx'), json: path.join(this.voiceDir, id + '.onnx.json') };
  }

  status() {
    const voices = {};
    for (const k of Object.keys(VOICES)) voices[k] = !!this.installedVoice(k);
    const models = {};
    for (const k of Object.keys(WHISPER_MODELS)) models[k] = fs.existsSync(this.whisperModelPath(k));
    return {
      whisperBinary: !!(this.whisperBin() || this.whisperServerBin()),
      whisperServer: !!this.whisperServerBin(),
      whisperModels: models,
      piperBinary: !!this.piperBin(),
      voices,
      info: {
        voices: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => {
          const iv = this.installedVoice(k);
          return [k, { label: v.label + (iv ? ` (${iv.id})` : ''), approx: v.approx }];
        })),
        whisperModels: Object.fromEntries(Object.entries(WHISPER_MODELS).map(([k, v]) => [k, { approx: v.approx }])),
      },
    };
  }

  abort(task) {
    const c = this.controllers.get(task);
    if (c) c.abort();
  }

  _progress(task, label) {
    return ({ received, total }) => {
      this.emit({ task, label, received, total, pct: total ? Math.round((received / total) * 100) : null });
    };
  }

  _ctrl(task) {
    const c = new AbortController();
    this.controllers.set(task, c);
    return c;
  }

  async _downloadWithFallback(urls, dest, task, label, signal) {
    let lastErr;
    for (const u of urls) {
      try {
        return await downloadFile(u, dest, this._progress(task, label), signal);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error('Download fehlgeschlagen');
  }

  // ---------- Spracherkennung (whisper.cpp) ----------
  async prepareStt(model = 'small') {
    const task = 'stt';
    const ctrl = this._ctrl(task);
    try {
      if (!this.whisperBin()) {
        this.emit({ task, label: 'Programm für Spracherkennung wird gesucht …', pct: null });
        const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', {
          headers: { 'User-Agent': 'FA-KI-Desktop', Accept: 'application/vnd.github+json' },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('Whisper-Release nicht gefunden (' + res.status + ')');
        const rel = await res.json();
        const asset = pickWhisperAsset(rel.assets);
        if (!asset) throw new Error('Das Spracherkennungs-Programm fehlt in dieser Version der App. Bitte die neueste Version installieren.');
        const zip = path.join(this.tmp, asset.name);
        await downloadFile(asset.url, zip, this._progress(task, 'Spracherkennungs-Programm'), ctrl.signal);
        extractZip(zip, path.join(this.whisperDir, 'bin'));
        try { fs.unlinkSync(zip); } catch { /* egal */ }
        if (!this.whisperBin()) throw new Error('whisper-cli.exe wurde im Paket nicht gefunden.');
      }
      const mp = this.whisperModelPath(model);
      if (!fs.existsSync(mp)) {
        const file = (WHISPER_MODELS[model] || WHISPER_MODELS.small).file;
        await this._downloadWithFallback(
          WHISPER_MODEL_HOSTS.map((h) => `${h}/${file}`), mp, task, `Sprachmodell „${model}“`, ctrl.signal);
      }
      return true;
    } finally {
      this.controllers.delete(task);
    }
  }

  _threads() {
    return Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
  }

  /**
   * Startet whisper-server (hält das Modell im Speicher) oder gibt den laufenden zurück.
   * Vorher wurde für jede Aufnahme whisper-cli neu gestartet und das Modell jedes Mal neu geladen.
   */
  async ensureWhisperServer(model = 'small') {
    const bin = this.whisperServerBin();
    const mp = this.whisperModelPath(model);
    if (!bin || !fs.existsSync(mp)) return null;
    if (this.ws && this.ws.model === model && this.ws.child.exitCode == null) {
      this._touchWs();
      return this.ws.ready;
    }
    this.stopWhisperServer();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const args = ['-m', mp, '--host', '127.0.0.1', '--port', String(port), '-t', String(this._threads()), '-nt'];
    const child = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: 'ignore' });
    const ws = { child, model, url, ready: null };
    child.on('error', () => { if (this.ws === ws) this.ws = null; });
    child.on('exit', () => { if (this.ws === ws) this.ws = null; });
    this.ws = ws; // vor dem Warten setzen, die Schleife prüft darauf
    ws.ready = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        if (child.exitCode != null || this.ws !== ws) return null;
        try {
          const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) });
          if (r.ok) return url;
        } catch { /* lädt noch */ }
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    })();
    this._touchWs();
    const ok = await ws.ready;
    if (!ok && this.ws === ws) this.stopWhisperServer();
    return ok;
  }

  _touchWs() {
    clearTimeout(this.wsTimer);
    this.wsTimer = setTimeout(() => this.stopWhisperServer(), WHISPER_IDLE_MS);
    if (this.wsTimer.unref) this.wsTimer.unref();
  }

  stopWhisperServer() {
    clearTimeout(this.wsTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) killTree(ws.child);
  }

  /** Lädt das Modell vorab (z. B. beim App-Start oder sobald das Mikrofon angeht). Fehler sind egal. */
  warmStt(model = 'small') {
    return this.ensureWhisperServer(model).then((u) => !!u).catch(() => false);
  }

  async _transcribeServer(url, wavBuffer, lang, audioCtx) {
    const fd = new FormData();
    fd.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'rec.wav');
    fd.append('language', lang === 'auto' ? 'auto' : lang);
    fd.append('response_format', 'json');
    fd.append('temperature', '0');
    fd.append('beam_size', '1'); // gierige Suche: bei kurzen Diktaten kaum schlechter, aber schneller
    if (audioCtx) fd.append('audio_ctx', String(audioCtx));
    const res = await fetch(url + '/inference', { method: 'POST', body: fd, signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`whisper-server ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // res.json() dekodiert die ganze Antwort auf einmal als UTF-8 -> Umlaute bleiben heil.
    const d = await res.json();
    return String((d && d.text) || '');
  }

  async transcribe(wavBuffer, lang = 'de', model = 'small') {
    const bin = this.whisperBin();
    const mp = this.whisperModelPath(model);
    const buf = Buffer.from(wavBuffer);
    const audioCtx = audioCtxFor(wavSeconds(buf));
    const t0 = Date.now();
    // 1) Schneller Weg: dauerhaft laufender whisper-server
    try {
      const url = await this.ensureWhisperServer(model);
      if (url) {
        const text = await this._transcribeServer(url, buf, lang, audioCtx);
        this._touchWs();
        this.lastTiming = { path: 'server', ms: Date.now() - t0, audioCtx };
        return cleanTranscript(text);
      }
    } catch { /* Rückfall auf whisper-cli */ }
    // 2) Rückfall: whisper-cli pro Aufnahme
    if (!bin || !fs.existsSync(mp)) throw new Error('Spracherkennung ist noch nicht eingerichtet.');
    const wav = path.join(this.tmp, `rec-${Date.now()}.wav`);
    fs.writeFileSync(wav, buf);
    try {
      const args = ['-m', mp, '-f', wav, '-l', lang === 'auto' ? 'auto' : lang, '-nt', '-np', '-t', String(this._threads()), '-bs', '1'];
      if (audioCtx) args.push('-ac', String(audioCtx));
      const { out } = await run(bin, args, { cwd: path.dirname(bin), timeoutMs: 180000 });
      this.lastTiming = { path: 'cli', ms: Date.now() - t0, audioCtx };
      return cleanTranscript(out);
    } finally {
      try { fs.unlinkSync(wav); } catch { /* egal */ }
    }
  }

  // ---------- Sprachausgabe (Piper) ----------
  async prepareTts(voiceKey) {
    const task = 'tts';
    const ctrl = this._ctrl(task);
    try {
      if (!this.piperBin()) {
        const zip = path.join(this.tmp, 'piper_windows_amd64.zip');
        await downloadFile(PIPER_URL, zip, this._progress(task, 'Sprachausgabe-Programm'), ctrl.signal);
        extractZip(zip, this.piperDir);
        try { fs.unlinkSync(zip); } catch { /* egal */ }
        if (!this.piperBin()) throw new Error('piper.exe wurde im Paket nicht gefunden.');
      }
      const v = VOICES[voiceKey];
      if (!v) throw new Error('Unbekannte Stimme: ' + voiceKey);
      const candidates = await this._voiceCandidates(voiceKey, ctrl.signal);
      let lastErr = null;
      for (const base of candidates) {
        const id = path.basename(base);
        const onnx = path.join(this.voiceDir, id + '.onnx');
        const json = onnx + '.json';
        try {
          if (!fs.existsSync(onnx)) await downloadFile(`${HF_VOICES}/${base}.onnx`, onnx, this._progress(task, `Stimme ${id}`), ctrl.signal);
          if (!fs.existsSync(json)) await downloadFile(`${HF_VOICES}/${base}.onnx.json`, json, this._progress(task, `Stimme ${id}`), ctrl.signal);
          if (!voiceCompatible(json)) {
            try { fs.unlinkSync(onnx); fs.unlinkSync(json); } catch { /* egal */ }
            throw new Error(`${id} ist zu neu für das Sprachprogramm`);
          }
          lastErr = null;
          break;
        } catch (e) {
          if (ctrl.signal.aborted) throw e;
          lastErr = e;
          try { fs.unlinkSync(onnx); } catch { /* egal */ }
        }
      }
      if (lastErr) throw new Error(`Keine ${v.label}e Stimme ladbar (${lastErr.message}). Geprüft: ${candidates.map((c) => path.basename(c)).join(', ')}`);
      return true;
    } finally {
      this.controllers.delete(task);
    }
  }

  async synthesize(text, voiceKey, speed = 1) {
    const bin = this.piperBin();
    if (!bin) throw new Error('Sprachausgabe ist noch nicht eingerichtet.');
    const p = this.installedVoice(voiceKey);
    if (!p) throw new Error('Stimme ist noch nicht geladen.');
    const out = path.join(this.tmp, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
    const cwd = path.dirname(bin);
    const args = ['--model', p.onnx, '--config', p.json, '--output_file', out];
    const sp = Math.min(2, Math.max(0.5, Number(speed) || 1));
    if (sp !== 1) args.push('--length_scale', String((1 / sp).toFixed(2)));
    const espeak = path.join(cwd, 'espeak-ng-data');
    if (fs.existsSync(espeak)) args.push('--espeak_data', espeak);
    try {
      await run(bin, args, { cwd, input: String(text).replace(/\s+/g, ' ').trim() + '\n', timeoutMs: 90000 });
      return fs.readFileSync(out);
    } finally {
      try { fs.unlinkSync(out); } catch { /* egal */ }
    }
  }

  /** Fragt Hugging Face nach den vorhandenen Stimmen; bei Fehler nimmt es die bekannten Pfade. */
  async _voiceCandidates(key, signal) {
    const v = VOICES[key];
    const fallback = v.guess.slice();
    try {
      const url = `https://huggingface.co/api/models/rhasspy/piper-voices/tree/main/${v.region.slice(0, 2)}/${v.region}?recursive=true`;
      const res = await fetch(url, { headers: { 'User-Agent': 'FA-KI-Desktop' }, signal });
      if (!res.ok) throw new Error(String(res.status));
      const list = await res.json();
      const found = list
        .filter((f) => f.type === 'file' && f.path.endsWith('.onnx'))
        .map((f) => f.path.slice(0, -5))
        .sort((x, y) => rankVoice(key, path.basename(x)) - rankVoice(key, path.basename(y)));
      if (found.length) return found.slice(0, 4);
    } catch (e) {
      if (signal && signal.aborted) throw e;
    }
    return fallback;
  }

  /** Stimmen-Server mit OpenAI-kompatibler Schnittstelle (z. B. Chatterbox, XTTS, Kokoro). */
  async synthesizeServer(text, lang, cfg, speed = 1) {
    const base = String(cfg.ttsServerUrl || 'http://127.0.0.1:8004').replace(/\/+$/, '');
    const body = {
      model: cfg.ttsServerModel || 'tts-1',
      input: String(text),
      voice: (lang === 'tr' ? cfg.ttsServerVoiceTr : cfg.ttsServerVoice) || cfg.ttsSampleFile || cfg.ttsServerVoice || 'alloy',
      response_format: 'wav',
      speed: Math.min(2, Math.max(0.5, Number(speed) || 1)),
      language: lang,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300000);
    this._srvCtrls = this._srvCtrls || new Set();
    this._srvCtrls.add(ctrl);
    try {
      const res = await fetch(base + '/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Stimmen-Server antwortete ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
      this._srvCtrls.delete(ctrl);
    }
  }

  /** Bricht laufende Aufträge beim Stimmen-Server ab (nach „Stopp“), damit der nächste Text nicht wartet. */
  async cancelServer(url) {
    for (const c of this._srvCtrls || []) { try { c.abort(); } catch { /* egal */ } }
    const base = String(url || 'http://127.0.0.1:8004').replace(/\/+$/, '');
    try { await fetch(base + '/cancel', { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch { /* Server läuft evtl. nicht */ }
    return true;
  }

  async serverVoices(url) {
    const base = String(url || 'http://127.0.0.1:8004').replace(/\/+$/, '');
    for (const p of ['/v1/audio/voices', '/get_predefined_voices', '/voices']) {
      try {
        const res = await fetch(base + p, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const d = await res.json();
        const arr = Array.isArray(d) ? d : d.voices || d.data || [];
        const names = arr.map((x) => (typeof x === 'string' ? x : x.filename || x.id || x.name || x.voice_id)).filter(Boolean);
        if (names.length) return { ok: true, voices: names };
      } catch { /* nächster Pfad */ }
    }
    try {
      const r = await fetch(base + '/', { signal: AbortSignal.timeout(6000) });
      return { ok: r.status < 500, voices: [] };
    } catch (e) {
      return { ok: false, voices: [], error: String(e.message || e) };
    }
  }
}

module.exports = { SpeechManager, VOICES, WHISPER_MODELS, pickWhisperAsset, decodeChunks, run, audioCtxFor, wavSeconds };
