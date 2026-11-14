'use strict';
// Richtet die eigene Stimme (Chatterbox) mit einem Klick ein: portables Python, Pakete, Server-Skript.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { downloadFile } = require('./downloader');
const { reachable } = require('./procs');

const PY_URL = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
const PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const PKGS = [
  'numpy<2,>=1.24', 'librosa==0.11.0', 's3tokenizer', 'torch==2.6.0', 'torchaudio==2.6.0',
  'transformers==5.2.0', 'diffusers==0.29.0', 'resemble-perth>=1.0.0', 'conformer==0.3.2',
  'safetensors==0.5.3', 'spacy-pkuseg', 'pykakasi==2.3.0', 'pyloudnorm', 'omegaconf', 'soundfile',
];
const PORT = 8004;

function paths(userData) {
  const root = path.join(userData, 'voice');
  return {
    root,
    pyDir: path.join(root, 'python'),
    py: path.join(root, 'python', 'python.exe'),
    serverDir: path.join(root, 'server'),
    serverPy: path.join(root, 'server', 'voice_server.py'),
    voices: path.join(userData, 'voices'),
    cache: path.join(root, 'hf-cache'),
    marker: path.join(root, 'installiert.json'),
  };
}

function isInstalled(userData) {
  const p = paths(userData);
  try { return fs.existsSync(p.marker) && fs.existsSync(p.py) && fs.existsSync(p.serverPy); } catch { return false; }
}

function runPy(py, args, onLine, state, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(py, args, {
      cwd, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONUTF8: '1' },
    });
    state.child = child;
    let tail = '';
    const feed = (d) => {
      const s = d.toString('utf8');
      tail = (tail + s).slice(-3000);
      const line = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
      if (line && onLine) onLine(line);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      state.child = null;
      if (state.cancelled) return reject(new Error('Abgebrochen.'));
      if (code === 0) resolve(tail);
      else reject(new Error(`Programm endete mit Code ${code}.\n${tail.slice(-700)}`));
    });
  });
}

class VoiceInstaller {
  constructor(userData, resourceServerPy, progress) {
    this.userData = userData;
    this.resourceServerPy = resourceServerPy;
    this.progress = progress;
    this.state = { cancelled: false, child: null, ctrl: null };
    this.busy = false;
  }

  cancel() {
    this.state.cancelled = true;
    if (this.state.ctrl) this.state.ctrl.abort();
    if (this.state.child) { try { this.state.child.kill(); } catch { /* egal */ } }
  }

  status() {
    return { installed: isInstalled(this.userData), busy: this.busy };
  }

  async install() {
    if (process.platform !== 'win32') throw new Error('Die Einrichtung ist nur für Windows gedacht.');
    if (this.busy) throw new Error('Die Einrichtung läuft schon.');
    this.busy = true;
    this.state.cancelled = false;
    this.state.ctrl = new AbortController();
    const p = paths(this.userData);
    const say = (text, pct) => this.progress({ text, pct: pct == null ? null : Math.round(pct) });
    try {
      fs.mkdirSync(p.root, { recursive: true });
      fs.mkdirSync(p.serverDir, { recursive: true });
      fs.mkdirSync(p.voices, { recursive: true });

      // 1) Python
      if (!fs.existsSync(p.py)) {
        const zip = path.join(p.root, 'python.zip');
        say('Python wird geladen …', 0);
        await downloadFile(PY_URL, zip, ({ received, total }) => say('Python wird geladen …', total ? (received / total) * 8 : null), this.state.ctrl.signal);
        new AdmZip(zip).extractAllTo(p.pyDir, true);
        try { fs.unlinkSync(zip); } catch { /* egal */ }
        const pth = fs.readdirSync(p.pyDir).find((f) => /^python\d+\._pth$/.test(f));
        if (!pth) throw new Error('Python-Paket unvollständig (keine _pth-Datei).');
        const f = path.join(p.pyDir, pth);
        let txt = fs.readFileSync(f, 'utf8').replace(/^#\s*import site/m, 'import site');
        if (!/Lib\\site-packages/.test(txt)) txt += '\nLib\\site-packages\n';
        fs.writeFileSync(f, txt);
      }

      // 2) pip
      const havePip = fs.existsSync(path.join(p.pyDir, 'Lib', 'site-packages', 'pip'));
      if (!havePip) {
        say('Paketverwaltung wird eingerichtet …', 9);
        const gp = path.join(p.root, 'get-pip.py');
        await downloadFile(PIP_URL, gp, () => {}, this.state.ctrl.signal);
        await runPy(p.py, [gp, '--no-warn-script-location'], (l) => say('Paketverwaltung: ' + l.slice(0, 80), 10), this.state, p.root);
      }

      // 3) Pakete (das ist der große Teil, mehrere Gigabyte)
      say('Sprachpakete werden installiert (mehrere GB, das dauert) …', 12);
      let n = 0;
      await runPy(p.py, ['-m', 'pip', 'install', '--no-warn-script-location', ...PKGS], (l) => {
        n += 1;
        say(l.slice(0, 90), Math.min(70, 12 + n * 0.25));
      }, this.state, p.root);
      await runPy(p.py, ['-m', 'pip', 'install', '--no-warn-script-location', '--no-deps', 'chatterbox-tts==0.1.7'], (l) => say(l.slice(0, 90), 72), this.state, p.root);

      // 4) Server-Skript
      fs.copyFileSync(this.resourceServerPy, p.serverPy);
      fs.writeFileSync(p.marker, JSON.stringify({ at: new Date().toISOString(), model: 'chatterbox-multilingual' }));
      say('Installation fertig. Das Stimmenmodell wird beim ersten Start geladen …', 75);
      return { ok: true, cmd: this.command(), dir: p.serverDir };
    } finally {
      this.busy = false;
      this.state.ctrl = null;
    }
  }

  command() {
    const p = paths(this.userData);
    return `"${p.py}" "${p.serverPy}" --port ${PORT} --voices "${p.voices}" --cache "${p.cache}"`;
  }

  url() { return `http://127.0.0.1:${PORT}`; }

  /** Wartet, bis der Server das Modell geladen hat (erster Start lädt mehrere GB aus dem Internet). */
  async waitReady(maxMs = 45 * 60 * 1000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (this.state.cancelled) throw new Error('Abgebrochen.');
      try {
        const r = await fetch(this.url() + '/status', { signal: AbortSignal.timeout(4000) });
        const s = await r.json();
        if (s.state === 'ready') return s;
        if (s.state === 'error') throw new Error('Stimmenmodell konnte nicht geladen werden: ' + s.detail);
        this.progress({ text: 'Stimmenmodell wird geladen und vorbereitet … ' + Math.round((Date.now() - t0) / 1000) + ' s', pct: 80 });
      } catch (e) {
        if (/Stimmenmodell/.test(String(e.message))) throw e;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('Zeitüberschreitung beim Laden des Stimmenmodells.');
  }

  /** Erzeugt einen Testsatz und misst, wie lange der PC dafür braucht. */
  async benchmark(voice) {
    const t0 = Date.now();
    const res = await fetch(this.url() + '/v1/audio/speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Guten Abend, schön, dass Du da bist.', language: 'de', voice: voice || '' }),
      signal: AbortSignal.timeout(600000),
    });
    if (!res.ok) throw new Error('Testsatz fehlgeschlagen: ' + (await res.text()).slice(0, 200));
    const buf = Buffer.from(await res.arrayBuffer());
    return { seconds: (Date.now() - t0) / 1000, bytes: buf.length };
  }

  async isRunning() { return reachable(this.url()); }
}

module.exports = { VoiceInstaller, paths, isInstalled, PORT };
