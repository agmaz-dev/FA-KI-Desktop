'use strict';
// Richtet die eigene Stimme (Chatterbox) mit einem Klick ein: portables Python, Pakete, Server-Skript.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { downloadFile, findFile } = require('./downloader');
const { reachable } = require('./procs');

const PY_URL = {
  cpu: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
  gpu: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip', // AMD-PyTorch gibt es nur für Python 3.12
  oute: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
};
const ROCM = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/';
const ROCM_SDK = ['rocm_sdk_core-7.2.1-py3-none-win_amd64.whl', 'rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl', 'rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl', 'rocm-7.2.1.tar.gz'].map((f) => ROCM + f);
const ROCM_TORCH = ['torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl', 'torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl'].map((f) => ROCM + f);
const PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const PKGS = [
  'numpy<2,>=1.24', 'librosa==0.11.0', 's3tokenizer', 'torch==2.6.0', 'torchaudio==2.6.0',
  'transformers==5.2.0', 'diffusers==0.29.0', 'resemble-perth>=1.0.0', 'conformer==0.3.2',
  'safetensors==0.5.3', 'spacy-pkuseg', 'pykakasi==2.3.0', 'pyloudnorm', 'omegaconf', 'soundfile',
  'setuptools<81', // perth braucht pkg_resources, das in neueren setuptools fehlt
];
const PKGS_GPU = PKGS.filter((p) => !/^torch/.test(p));
const PORT = 8004;
// OuteTTS (schnelle Stimme, Deutsch): eigenes Python, Pakete nach den Vorgaben der Bibliothek
const OUTE_GGUF = 'https://huggingface.co/OuteAI/OuteTTS-1.0-0.6B-GGUF/resolve/main/OuteTTS-1.0-0.6B-Q8_0.gguf';
const OUTE_BASE = ['numpy<2,>=1.24', 'torch==2.6.0', 'torchaudio==2.6.0', 'transformers==4.52.3', 'setuptools<81', 'wheel'];
const OUTE_SDIST = ['openai-whisper', 'argbind', 'randomname', 'encodec', 'unidic-lite'];
const OUTE_REST = ['descript-audio-codec', 'scipy', 'einops', 'pyyaml', 'huggingface-hub', 'matplotlib', 'soundfile', 'inflect', 'loguru',
  'polars', 'natsort', 'tqdm', 'requests', 'mecab-python3', 'uroman', 'ftfy', 'aiohttp', 'packaging'];

function paths(userData, mode = 'cpu') {
  const root = path.join(userData, 'voice');
  const pyName = mode === 'gpu' ? 'python-gpu' : mode === 'oute' ? 'python-oute' : 'python';
  const srvName = mode === 'oute' ? 'oute_server.py' : 'voice_server.py';
  return {
    root,
    pyDir: path.join(root, pyName),
    py: path.join(root, pyName, 'python.exe'),
    serverDir: path.join(root, 'server'),
    serverPy: path.join(root, 'server', srvName),
    llamaDir: path.join(root, 'llama'),
    gguf: path.join(root, 'OuteTTS-1.0-0.6B-Q8_0.gguf'),
    voices: path.join(userData, 'voices'),
    cache: path.join(root, 'hf-cache'),
    marker: path.join(root, mode === 'gpu' ? 'installiert-gpu.json' : mode === 'oute' ? 'installiert-oute.json' : 'installiert.json'),
  };
}

function isInstalled(userData, mode = 'cpu') {
  const p = paths(userData, mode);
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
    return { installed: isInstalled(this.userData, 'cpu'), gpuInstalled: isInstalled(this.userData, 'gpu'), outeInstalled: isInstalled(this.userData, 'oute'), busy: this.busy };
  }

  async install(mode = 'cpu') {
    if (process.platform !== 'win32') throw new Error('Die Einrichtung ist nur für Windows gedacht.');
    if (this.busy) throw new Error('Die Einrichtung läuft schon.');
    this.busy = true;
    this.state.cancelled = false;
    this.state.ctrl = new AbortController();
    const gpu = mode === 'gpu';
    const p = paths(this.userData, mode);
    const say = (text, pct) => this.progress({ text, pct: pct == null ? null : Math.round(pct) });
    try {
      fs.mkdirSync(p.root, { recursive: true });
      fs.mkdirSync(p.serverDir, { recursive: true });
      fs.mkdirSync(p.voices, { recursive: true });

      // 1) Python
      if (!fs.existsSync(p.py)) {
        const zip = path.join(p.root, 'python-' + mode + '.zip');
        say('Python wird geladen …', 0);
        await downloadFile(PY_URL[mode], zip, ({ received, total }) => say('Python wird geladen …', total ? (received / total) * 6 : null), this.state.ctrl.signal);
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
      if (!fs.existsSync(path.join(p.pyDir, 'Lib', 'site-packages', 'pip'))) {
        say('Paketverwaltung wird eingerichtet …', 7);
        const gp = path.join(p.root, 'get-pip.py');
        await downloadFile(PIP_URL, gp, () => {}, this.state.ctrl.signal);
        await runPy(p.py, [gp, '--no-warn-script-location'], (l) => say('Paketverwaltung: ' + l.slice(0, 80), 8), this.state, p.root);
      }

      if (mode === 'oute') return await this._installOute(p, say);

      const pip = (extra, pct, from) => runPy(p.py, ['-m', 'pip', 'install', '--no-warn-script-location', ...extra], (l) => say(l.slice(0, 90), pct(l)), this.state, p.root);
      let n = 0;
      const tick = (from, to) => () => { n += 1; return Math.min(to, from + n * 0.2); };

      if (gpu) {
        // 3g) AMD-ROCm-Umgebung und PyTorch (zuerst, damit pip nicht die Prozessor-Version holt)
        say('AMD-Grafikkarten-Umgebung wird installiert (mehrere GB) …', 10);
        await pip(['--no-cache-dir', ...ROCM_SDK], tick(10, 30));
        n = 0;
        say('PyTorch für AMD wird installiert …', 30);
        await pip(['--no-cache-dir', ...ROCM_TORCH], tick(30, 50));
        n = 0;
        say('Sprachpakete werden installiert …', 50);
        await pip(PKGS_GPU, tick(50, 70));
      } else {
        say('Sprachpakete werden installiert (mehrere GB, das dauert) …', 12);
        await pip(PKGS, tick(12, 70));
      }
      await pip(['--no-deps', 'chatterbox-tts==0.1.7'], () => 72);

      if (gpu) {
        say('Grafikkarte wird geprüft …', 74);
        const out = await runPy(p.py, ['-c', 'import torch;print("CUDA_OK" if torch.cuda.is_available() else "CUDA_NO");print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")'], null, this.state, p.root);
        if (!/CUDA_OK/.test(out)) {
          throw new Error('Die Grafikkarte wird von PyTorch nicht erkannt. AMD verlangt für Windows den Treiber 26.2.2 (oder neuer) und Windows 11. Bitte den Adrenalin-Treiber aktualisieren und erneut versuchen.');
        }
      }

      // 4) Server-Skript
      fs.copyFileSync(this.resourceServerPy, p.serverPy);
      fs.writeFileSync(p.marker, JSON.stringify({ at: new Date().toISOString(), mode, model: 'chatterbox-multilingual' }));
      say('Installation fertig. Das Stimmenmodell wird gestartet …', 76);
      return { ok: true, cmd: this.command(mode), dir: p.serverDir };
    } finally {
      this.busy = false;
      this.state.ctrl = null;
    }
  }

  /** OuteTTS: Pakete, llama-server (Vulkan = AMD-Grafikkarte) und das Sprachmodell (Q8, ca. 650 MB). */
  async _installOute(p, say) {
    const pipc = (extra, pct) => runPy(p.py, ['-m', 'pip', 'install', '--no-warn-script-location', '-c', path.join(p.root, 'oute-constraints.txt'), ...extra], (l) => say(l.slice(0, 90), pct), this.state, p.root);
    fs.writeFileSync(path.join(p.root, 'oute-constraints.txt'), 'torch==2.6.0\ntorchaudio==2.6.0\nnumpy<2\ntransformers==4.52.3\nsetuptools<81\n');
    say('OuteTTS: Grundpakete (PyTorch) …', 14);
    await pipc(OUTE_BASE, 16);
    say('OuteTTS: Whisper und weitere Pakete …', 30);
    await pipc(['--no-build-isolation', ...OUTE_SDIST], 34);
    say('OuteTTS: Audio-Pakete …', 45);
    await pipc(OUTE_REST, 50);
    await pipc(['--no-deps', 'outetts==0.4.4'], 62);

    // outetts verlangt beim Import die Python-Anbindung von llama.cpp, obwohl wir den llama-server per HTTP nutzen.
    // Ein kleiner Platzhalter genügt (das Modell läuft im llama-server, nicht in Python).
    const stubDir = path.join(p.pyDir, 'Lib', 'site-packages', 'llama_cpp');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, '__init__.py'),
      '# Platzhalter von FA KI Desktop: das Modell läuft im llama-server\n__version__ = "0.3.9"\n\n\nclass Llama:\n    def __init__(self, *a, **k):\n        raise RuntimeError("llama-cpp-python wird nicht genutzt (llama-server)")\n\n\ndef llama_token_is_eog(*a, **k):\n    return False\n');

    say('OuteTTS: Pakete werden geprüft …', 64);
    const chk = await runPy(p.py, ['-c', 'import outetts, dac, whisper, torch; print("OUTE_OK")'], null, this.state, p.root);
    if (!/OUTE_OK/.test(chk)) throw new Error('OuteTTS-Pakete lassen sich nicht laden.');

    // llama-server (neueste Version von GitHub; Vulkan läuft auf AMD-Grafikkarten)
    if (!findFile(p.llamaDir, ['llama-server.exe'])) {
      say('OuteTTS: llama-server wird gesucht …', 66);
      const res = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=12', { headers: { 'User-Agent': 'FA-KI-Desktop' }, signal: this.state.ctrl.signal });
      if (!res.ok) throw new Error('llama.cpp-Releases nicht erreichbar (' + res.status + ').');
      const rels = await res.json();
      // Neueste Version, die ein Windows-Paket schon enthält (frische Releases haben manchmal noch keine Dateien).
      const find = (re) => { for (const r of rels) { const a = (r.assets || []).find((x) => re.test(x.name)); if (a) return a; } return null; };
      const asset = find(/^llama-.*-bin-win(dows)?-vulkan-x64\.zip$/i) || find(/^llama-.*-bin-win(dows)?-(cpu|avx2)-x64\.zip$/i);
      if (!asset) {
        const seen = rels.slice(0, 3).map((r) => r.tag_name + ': ' + ((r.assets || []).length) + ' Dateien').join('; ');
        throw new Error('Kein passendes llama-server-Paket gefunden (' + seen + ').');
      }
      const zip = path.join(p.root, 'llama.zip');
      await downloadFile(asset.browser_download_url, zip, ({ received, total }) => say('OuteTTS: llama-server wird geladen …', total ? 66 + (received / total) * 6 : null), this.state.ctrl.signal);
      new AdmZip(zip).extractAllTo(p.llamaDir, true);
      try { fs.unlinkSync(zip); } catch { /* egal */ }
      if (!findFile(p.llamaDir, ['llama-server.exe'])) throw new Error('llama-server.exe fehlt im Paket.');
    }

    if (!fs.existsSync(p.gguf)) {
      say('OuteTTS: Sprachmodell wird geladen (ca. 650 MB) …', 72);
      await downloadFile(OUTE_GGUF, p.gguf, ({ received, total }) => say('OuteTTS: Sprachmodell wird geladen …', total ? 72 + (received / total) * 4 : null), this.state.ctrl.signal);
    }

    fs.copyFileSync(path.join(path.dirname(this.resourceServerPy), 'oute_server.py'), p.serverPy);
    fs.writeFileSync(p.marker, JSON.stringify({ at: new Date().toISOString(), mode: 'oute', model: 'OuteTTS-1.0-0.6B-Q8_0' }));
    say('Installation fertig. Die Stimme wird gestartet …', 78);
    return { ok: true, cmd: this.command('oute'), dir: p.serverDir };
  }

  command(mode = 'cpu') {
    const p = paths(this.userData, mode);
    if (mode === 'oute') {
      const llama = findFile(p.llamaDir, ['llama-server.exe']) || path.join(p.llamaDir, 'llama-server.exe');
      return `"${p.py}" "${p.serverPy}" --port ${PORT} --voices "${p.voices}" --cache "${p.cache}" --llama "${llama}" --gguf "${p.gguf}"`;
    }
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
