'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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

function run(cmd, args, { cwd, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Zeitüberschreitung beim Ausführen von ' + path.basename(cmd)));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
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
      .filter((f) => f.startsWith(v.region + '-') && f.endsWith('.onnx') && files.includes(f + '.json'))
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
      whisperBinary: !!this.whisperBin(),
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

  async transcribe(wavBuffer, lang = 'de', model = 'small') {
    const bin = this.whisperBin();
    const mp = this.whisperModelPath(model);
    if (!bin || !fs.existsSync(mp)) throw new Error('Spracherkennung ist noch nicht eingerichtet.');
    const wav = path.join(this.tmp, `rec-${Date.now()}.wav`);
    fs.writeFileSync(wav, Buffer.from(wavBuffer));
    try {
      const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
      const args = ['-m', mp, '-f', wav, '-l', lang === 'auto' ? 'auto' : lang, '-nt', '-np', '-t', String(threads)];
      const { out } = await run(bin, args, { cwd: path.dirname(bin), timeoutMs: 180000 });
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

module.exports = { SpeechManager, VOICES, WHISPER_MODELS, pickWhisperAsset };
