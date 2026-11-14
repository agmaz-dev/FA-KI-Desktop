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
  de: { id: 'de_DE-thorsten-high', dir: 'de/de_DE/thorsten/high', label: 'Deutsch (Thorsten, hoch)', approx: '110 MB' },
  tr: { id: 'tr_TR-fahrettin-medium', dir: 'tr/tr_TR/fahrettin/medium', label: 'Türkisch (Fahrettin)', approx: '65 MB' },
};

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
  voicePaths(key) {
    const v = VOICES[key];
    if (!v) throw new Error('Unbekannte Stimme: ' + key);
    return { onnx: path.join(this.voiceDir, v.id + '.onnx'), json: path.join(this.voiceDir, v.id + '.onnx.json') };
  }

  status() {
    const voices = {};
    for (const k of Object.keys(VOICES)) {
      const p = this.voicePaths(k);
      voices[k] = fs.existsSync(p.onnx) && fs.existsSync(p.json);
    }
    const models = {};
    for (const k of Object.keys(WHISPER_MODELS)) models[k] = fs.existsSync(this.whisperModelPath(k));
    return {
      whisperBinary: !!this.whisperBin(),
      whisperModels: models,
      piperBinary: !!this.piperBin(),
      voices,
      info: {
        voices: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, { label: v.label, approx: v.approx }])),
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
      const p = this.voicePaths(voiceKey);
      if (!fs.existsSync(p.onnx)) {
        await downloadFile(`${HF_VOICES}/${v.dir}/${v.id}.onnx`, p.onnx, this._progress(task, v.label), ctrl.signal);
      }
      if (!fs.existsSync(p.json)) {
        await downloadFile(`${HF_VOICES}/${v.dir}/${v.id}.onnx.json`, p.json, this._progress(task, v.label), ctrl.signal);
      }
      return true;
    } finally {
      this.controllers.delete(task);
    }
  }

  async synthesize(text, voiceKey, speed = 1) {
    const bin = this.piperBin();
    if (!bin) throw new Error('Sprachausgabe ist noch nicht eingerichtet.');
    const p = this.voicePaths(voiceKey);
    if (!fs.existsSync(p.onnx) || !fs.existsSync(p.json)) throw new Error('Stimme ist noch nicht geladen.');
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
}

module.exports = { SpeechManager, VOICES, WHISPER_MODELS, pickWhisperAsset };
