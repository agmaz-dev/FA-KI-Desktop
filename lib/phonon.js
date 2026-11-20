'use strict';
// Phonon (gradium/phonon-40m-multilingual): mehrsprachige Sprachausgabe, ganz lokal.
// Laufzeit: das Programm „ptts“ (gradium-ai/xn-ptts, Rust) liegt fertig im Installer (Ordner resources/ptts).
// Modell (q8, ca. 75 MB) und Stimmen (je 250 KB) werden einmal von Hugging Face geladen, danach läuft alles offline.
// Das Modell ist geschützt („gated“): Bedingungen auf Hugging Face akzeptieren + Token in den Einstellungen.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { fetchFile, freeBytes } = require('./download');
const { HF, authHeaders } = require('./hf');

const MODEL_REPO = 'gradium/phonon-40m-multilingual';
const VOICE_REPO = 'gradium/phonon-voices';
// Alles, was ptts für einen lokalen Ordner braucht (config, Tokenizer, q8-Gewichte, Standardstimme).
const MODEL_FILES = [
  'config.json', 'generation_config.json', 'processor_config.json', 'tokenizer.json', 'tokenizer.5.0.0.json',
  'tokenizer.model', 'tokenizer_config.json', 'chat_template.jinja', 'default-voice.safetensors', 'model.q8.gguf',
];
const LICENSE = 'CC BY-NC 4.0 (privat und nicht kommerziell erlaubt)';
const APPROX = '75 MB';

// Stimmen aus dem Katalog gradium/phonon-voices (Name, ID, Sprache, Geschlecht)
const VOICES = [
  ['anton', 'Anton', '3ZKKapPOvuWFcw9f', 'de', 'm'],
  ['nele', 'Nele', '2A2fFf8SkDEJ8nzx', 'de', 'w'],
  ['mats', 'Mats', 'Kf5m22mROozoMWj3', 'de', 'm'],
  ['henrik', 'Henrik', 'yyS1KYWs6mXoEw7D', 'de', 'm'],
  ['leon', 'Leon', '20zdyYrQPzKlCwkk', 'de', 'm'],
  ['mirko', 'Mirko', 'Xn9xDzqSSr4xGTNg', 'de', 'm'],
  ['mika', 'Mika', 'R3uU1GTAZJotUhUs', 'de', 'm'],
  ['jette', 'Jette', '4Mn9VfG2wsLLEzi5', 'de', 'w'],
  ['annika', 'Annika', 'p6Uutkyi3j2iNAUu', 'de', 'w'],
  ['jule', 'Jule', 'MxhgvuHuUER7qjmL', 'de', 'w'],
  ['lotta', 'Lotta', 'MOrDPn052KUlnKXk', 'de', 'w'],
  ['josefine', 'Josefine', 'yadpmqsHVrYC0NJp', 'de', 'w'],
  ['svea', 'Svea', 'Adoh4wA9tp5QXJi9', 'de', 'w'],
  ['zoey', 'Zoey', 'NbpkqMVS3CJeq2j8', 'en', 'w'],
  ['easton', 'Easton', 'LMDIYE0Oa377Qh6Z', 'en', 'm'],
].map(([key, name, id, lang, gender]) => ({ key, name, id, lang, gender }));

// Textsprache: steuert, wie Zahlen, Datum und Zeichen gelesen werden. Gesprochen werden diese 5 Sprachen.
const LANGS = [['de', 'Deutsch'], ['en', 'Englisch'], ['fr', 'Französisch'], ['es', 'Spanisch'], ['pt', 'Portugiesisch']];
const LANG_CODES = new Set(LANGS.map((l) => l[0]));

const voiceOf = (key) => VOICES.find((v) => v.key === String(key || '').toLowerCase()) || VOICES[0];

/** Kommandozeile für ptts (ohne Programm). */
function buildArgs({ modelDir, lang, voiceFile, text, out, threads }) {
  const a = ['--model', modelDir, '--lang', LANG_CODES.has(lang) ? lang : 'de', '--quant', 'q8'];
  if (voiceFile) a.push('--voice', voiceFile);
  if (threads) a.push('--threads', String(threads));
  a.push('-o', out, '--', String(text));
  return a;
}

/** Sucht ptts: Umgebungsvariable, App-Ressourcen (installiert) oder build-bundled (Entwicklung). */
function findPtts(bundledDir) {
  const exe = process.platform === 'win32' ? 'ptts.exe' : 'ptts';
  const cands = [];
  if (process.env.FA_PTTS) cands.push(process.env.FA_PTTS);
  if (bundledDir) cands.push(path.join(bundledDir, 'ptts', exe));
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || '';
}

class Phonon {
  constructor(dataDir, bundledDir, emit) {
    this.dir = path.join(dataDir, 'phonon');
    this.modelDir = path.join(this.dir, 'phonon-40m-multilingual');
    this.voiceDir = path.join(this.dir, 'voices');
    this.bundledDir = bundledDir;
    this.emit = emit || (() => {});
    this.tmp = path.join(os.tmpdir(), 'fa-ki-desktop', 'phonon');
    this.kids = new Set();
    this.ctrl = null;
  }

  bin() { return findPtts(this.bundledDir); }
  voiceFile(key) { return path.join(this.voiceDir, voiceOf(key).id + '.safetensors'); }
  modelReady() { return MODEL_FILES.every((f) => fs.existsSync(path.join(this.modelDir, f))); }
  ready() { return !!this.bin() && this.modelReady() && VOICES.every((v) => fs.existsSync(this.voiceFile(v.key))); }

  status() {
    return {
      ready: this.ready(), binary: !!this.bin(), model: this.modelReady(), busy: !!this.ctrl,
      approx: APPROX, license: LICENSE, repo: MODEL_REPO,
      voices: VOICES.map(({ key, name, lang, gender }) => ({ key, name, lang, gender })), langs: LANGS,
    };
  }

  async _listSizes(repo, token, signal, paths) {
    const res = await fetch(`${HF}/api/models/${repo}/tree/main${paths ? '/' + paths : ''}`, {
      headers: { 'User-Agent': 'FA-KI-Desktop', Accept: 'application/json', ...authHeaders(token) }, signal,
    });
    if (res.status === 401 || res.status === 403) throw this._gatedError(res.status);
    if (!res.ok) throw new Error(`Hugging Face: Fehler ${res.status} beim Lesen von ${repo}`);
    const map = new Map();
    for (const f of await res.json()) if (f.type === 'file') map.set(f.path, (f.lfs && f.lfs.size) || f.size || 0);
    return map;
  }

  _gatedError(code) {
    const e = new Error(`Hugging Face verweigert Phonon (${code}). Bitte einmal auf huggingface.co/${MODEL_REPO} anmelden, die Bedingungen akzeptieren (Freigabe kommt sofort) und unten Deinen Hugging-Face-Token speichern.`);
    e.gated = true;
    return e;
  }

  /** Lädt Modell und Stimmen (setzt abgebrochene Downloads fort). token = Hugging-Face-Token. */
  async install(token) {
    if (!this.bin()) throw new Error('Das Phonon-Programm (ptts) fehlt in dieser Installation. Bitte die neueste Version installieren.');
    if (this.ctrl) throw new Error('Phonon wird schon geladen.');
    const ctrl = (this.ctrl = new AbortController());
    const label = 'Phonon';
    try {
      this.emit({ task: 'phonon', label: 'Phonon: Dateiliste …', pct: null });
      const sizes = await this._listSizes(MODEL_REPO, token, ctrl.signal);
      const voiceSizes = await this._listSizes(VOICE_REPO, '', ctrl.signal, 'voices');
      const jobs = [];
      for (const f of MODEL_FILES) {
        if (!sizes.has(f)) throw new Error(`Im Phonon-Repo fehlt die Datei ${f}.`);
        jobs.push({ url: `${HF}/${MODEL_REPO}/resolve/main/${f}`, dest: path.join(this.modelDir, f), size: sizes.get(f), auth: true });
      }
      for (const v of VOICES) {
        const rel = `voices/${v.id}.safetensors`;
        if (!voiceSizes.has(rel)) throw new Error(`Die Stimme ${v.name} fehlt im Stimmen-Katalog.`);
        jobs.push({ url: `${HF}/${VOICE_REPO}/resolve/main/${rel}`, dest: this.voiceFile(v.key), size: voiceSizes.get(rel), auth: false });
      }
      const total = jobs.reduce((n, j) => n + j.size, 0);
      fs.mkdirSync(this.dir, { recursive: true });
      if ((await freeBytes(this.dir)) < total + 200 * 1024 * 1024) throw new Error('Zu wenig Platz auf dem Laufwerk für Phonon.');
      let done = 0;
      for (const j of jobs) {
        let got = 0;
        await fetchFile(j.url, j.dest, j.size, (n) => {
          got += n; done += n;
          this.emit({ task: 'phonon', label, received: done, total, pct: Math.round((done / total) * 100) });
        }, ctrl.signal, fetch, j.auth ? authHeaders(token) : {}).catch((e) => { throw e.gated ? this._gatedError(403) : e; });
        done += Math.max(0, j.size - got);
      }
      this.emit({ task: 'phonon', label: 'Phonon: Testsatz …', pct: 100 });
      return true;
    } finally {
      this.ctrl = null;
    }
  }

  cancelInstall() { if (this.ctrl) this.ctrl.abort(); }

  /** Entfernt Modell und Stimmen. */
  remove() {
    this.cancel();
    fs.rmSync(this.dir, { recursive: true, force: true });
    return true;
  }

  /** Spricht einen Text. Gibt WAV-Bytes (24 kHz, mono) zurück. */
  synthesize(text, { lang = 'de', voice = 'anton' } = {}) {
    const bin = this.bin();
    if (!bin || !this.modelReady()) return Promise.reject(new Error('Phonon ist noch nicht eingerichtet.'));
    const vf = this.voiceFile(voice);
    fs.mkdirSync(this.tmp, { recursive: true });
    const out = path.join(this.tmp, `ph-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    const args = buildArgs({
      modelDir: this.modelDir, lang, voiceFile: fs.existsSync(vf) ? vf : '', text, out,
      threads: Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))),
    });
    return new Promise((resolve, reject) => {
      // HF_HUB_OFFLINE: nie ins Internet, alles kommt aus dem lokalen Ordner.
      const child = spawn(bin, args, { windowsHide: true, cwd: path.dirname(bin), env: { ...process.env, HF_HUB_OFFLINE: '1' } });
      this.kids.add(child);
      const err = [];
      child.stderr.on('data', (d) => err.push(d));
      child.stdout.on('data', () => {});
      const timer = setTimeout(() => this._kill(child), 120000);
      child.on('error', (e) => { clearTimeout(timer); this.kids.delete(child); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const killed = child.faKilled;
        this.kids.delete(child);
        let buf = null;
        try { buf = fs.readFileSync(out); } catch { /* keine Ausgabe */ }
        try { fs.unlinkSync(out); } catch { /* egal */ }
        if (killed) return reject(new Error('abgebrochen (499)'));
        if (code === 0 && buf && buf.length > 44) return resolve(buf);
        reject(new Error(`Phonon: Fehler ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(-300)}`));
      });
    });
  }

  _kill(child) {
    if (!child || child.exitCode != null) return;
    child.faKilled = true;
    try {
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill();
    } catch { /* egal */ }
  }

  /** Bricht alle laufenden Sätze ab (Stopp beim Vorlesen). */
  cancel() { for (const c of [...this.kids]) this._kill(c); }
}

module.exports = { Phonon, VOICES, LANGS, MODEL_FILES, MODEL_REPO, buildArgs, voiceOf, findPtts };
