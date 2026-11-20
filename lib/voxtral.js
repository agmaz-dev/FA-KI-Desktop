'use strict';
// Voxtral (mistralai/Voxtral-Mini-4B-Realtime-2602) zum Diktieren, als Alternative zu Whisper.
// Laufzeit: dieselbe Engine wie für den Chat (llama-server, llama.cpp b12530: Vulkan unter Windows, Metal auf dem Mac),
// als zweiter Prozess nur auf 127.0.0.1. Text kommt über die Realtime-Schnittstelle (WebSocket /v1/realtime).
// Dateien: GGUF von ggml-org (Q4_K_M + Audio-Teil Q8_0, zusammen ca. 3,6 GB), einmal laden, danach offline.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { fetchFile, freeBytes } = require('./download');
const { HF } = require('./hf');
const { cleanTranscript } = require('./util');

const REPO = 'ggml-org/Voxtral-Mini-4B-Realtime-2602-GGUF';
const FILES = {
  model: 'Voxtral-Mini-4B-Realtime-2602-Q4_K_M.gguf',
  mmproj: 'mmproj-Voxtral-Mini-4B-Realtime-2602-Q8_0.gguf',
};
const APPROX = '3,6 GB';
const IDLE_MS = 15 * 60 * 1000; // danach aus dem Speicher nehmen (wie Whisper)

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** PCM16-Daten und Abtastrate aus einer WAV (sucht den data-Block, nicht nur Kopf 44 Byte). */
function wavPcm(buf) {
  const b = Buffer.from(buf);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Keine WAV-Aufnahme.');
  let rate = 16000;
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12);
    if (id === 'data') return { pcm: b.subarray(off + 8, Math.min(b.length, off + 8 + len)), rate };
    off += 8 + len + (len % 2);
  }
  throw new Error('WAV ohne Audiodaten.');
}

/**
 * Schickt eine ganze Aufnahme über die Realtime-Schnittstelle und sammelt den Text.
 * Ablauf: session.created → (session.update mit Abtastrate) → append in Stücken → commit final → completed.
 */
function transcribeRealtime(wsUrl, pcm, rate, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 180000, chunkMs = 500 } = {}) {
  // Laut llama.cpp (server-context.cpp, ws_realtime): Nach „commit“ mit final:true schickt der Server
  // noch die restlichen delta-Ereignisse, dann ein „completed“ mit dem ganzen Text, und schließt die Verbindung.
  return new Promise((resolve, reject) => {
    if (!WebSocketImpl) return reject(new Error('WebSocket fehlt in dieser Laufzeit.'));
    const ws = new WebSocketImpl(wsUrl);
    let full = null; // Text aus „completed“
    let deltas = '';
    let sent = false;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* egal */ }
      if (err) reject(err); else resolve(String(full != null ? full : deltas).replace(/\s+/g, ' ').trim());
    };
    const timer = setTimeout(() => finish(new Error('Voxtral antwortet nicht (Zeitüberschreitung).')), timeoutMs);

    const sendAudio = (serverRate) => {
      if (sent) return;
      sent = true;
      if (serverRate && serverRate !== rate) ws.send(JSON.stringify({ type: 'session.update', session: { audio: { input: { format: { type: 'audio/pcm', rate } } } } }));
      const step = Math.max(2, Math.round((rate * chunkMs) / 1000) * 2); // gerade Bytezahl (PCM16)
      for (let o = 0; o < pcm.length; o += step) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm.subarray(o, Math.min(pcm.length, o + step))).toString('base64') }));
      }
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', final: true }));
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.type === 'session.created') {
        const f = m.session && m.session.audio && m.session.audio.input && m.session.audio.input.format;
        sendAudio(Number(f && f.rate) || 0);
      } else if (m.type === 'conversation.item.input_audio_transcription.delta') {
        deltas += m.delta || '';
      } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
        full = (full ? full + ' ' : '') + String(m.transcript || '');
        if (sent) finish(); // es gibt nur einen (finalen) Abschnitt
      } else if (m.type === 'error') {
        finish(new Error('Voxtral: ' + ((m.error && m.error.message) || 'Fehler')));
      }
    };
    ws.onerror = () => finish(sent && (full != null || deltas) ? null : new Error('Verbindung zu Voxtral fehlgeschlagen.'));
    ws.onclose = () => finish(sent ? null : new Error('Voxtral hat die Verbindung geschlossen.'));
  });
}

/**
 * Live-Diktat: Audio wird während des Sprechens geschickt, Text kommt laufend zurück (onDelta mit dem bisherigen Text).
 * push(bytes) mit PCM16 16 kHz, finish() -> Promise<Endtext>, cancel().
 */
class LiveSession {
  constructor(wsUrl, { onDelta, WebSocketImpl = globalThis.WebSocket, rate = 16000 } = {}) {
    this.onDelta = onDelta || (() => {});
    this.text = '';
    this.full = null;
    this.queue = [];
    this.open = false;
    this.closed = false;
    this.rate = rate;
    this.ws = new WebSocketImpl(wsUrl);
    this.done = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.done.catch(() => {});
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.type === 'session.created') {
        const f = m.session && m.session.audio && m.session.audio.input && m.session.audio.input.format;
        if (f && Number(f.rate) && Number(f.rate) !== this.rate) this._send({ type: 'session.update', session: { audio: { input: { format: { type: 'audio/pcm', rate: this.rate } } } } });
        this.open = true;
        for (const q of this.queue.splice(0)) this._send(q);
      } else if (m.type === 'conversation.item.input_audio_transcription.delta') {
        this.text += m.delta || '';
        this.onDelta(this.text.replace(/\s+/g, ' ').trim());
      } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
        this.full = (this.full ? this.full + ' ' : '') + String(m.transcript || '');
        if (this.finishing) this._end();
      } else if (m.type === 'error') {
        this._end(new Error('Voxtral: ' + ((m.error && m.error.message) || 'Fehler')));
      }
    };
    this.ws.onerror = () => this._end(this.finishing ? null : new Error('Verbindung zu Voxtral fehlgeschlagen.'));
    this.ws.onclose = () => this._end(this.finishing || this.text ? null : new Error('Voxtral hat die Verbindung geschlossen.'));
  }
  _send(o) { if (!this.open) { this.queue.push(o); return; } try { this.ws.send(JSON.stringify(o)); } catch { /* geschlossen */ } }
  push(bytes) {
    if (this.closed || this.finishing) return;
    const b = Buffer.from(bytes);
    if (b.length < 2) return;
    this._send({ type: 'input_audio_buffer.append', audio: b.subarray(0, b.length - (b.length % 2)).toString('base64') });
  }
  finish(timeoutMs = 20000) {
    if (!this.finishing) {
      this.finishing = true;
      this._send({ type: 'input_audio_buffer.commit', final: true });
      setTimeout(() => this._end(), timeoutMs).unref?.();
    }
    return this.done;
  }
  cancel() { this.finishing = true; this._end(); }
  _end(err) {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { /* egal */ }
    if (err) this._reject(err);
    else this._resolve(cleanTranscript(String(this.full != null ? this.full : this.text).replace(/\s+/g, ' ').trim()));
  }
}

class Voxtral {
  constructor(dataDir, getServerExe, emit) {
    this.dir = path.join(dataDir, 'voxtral');
    this.getExe = getServerExe;
    this.emit = emit || (() => {});
    this.srv = null; // { child, url, ready }
    this.timer = null;
    this.ctrl = null;
  }

  file(k) { return path.join(this.dir, FILES[k]); }
  ready() { return !!this.getExe() && fs.existsSync(this.file('model')) && fs.existsSync(this.file('mmproj')); }
  status() { return { ready: this.ready(), engine: !!this.getExe(), busy: !!this.ctrl, approx: APPROX, repo: REPO, running: !!this.srv }; }

  async install() {
    if (!this.getExe()) throw new Error('Die Engine (llama-server) fehlt in dieser Installation.');
    if (this.ctrl) throw new Error('Voxtral wird schon geladen.');
    const ctrl = (this.ctrl = new AbortController());
    try {
      this.emit({ task: 'voxtral', label: 'Voxtral: Dateiliste …', pct: null });
      const res = await fetch(`${HF}/api/models/${REPO}/tree/main`, { headers: { 'User-Agent': 'FA-KI-Desktop', Accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`Hugging Face: Fehler ${res.status} beim Lesen von ${REPO}`);
      const sizes = new Map((await res.json()).filter((f) => f.type === 'file').map((f) => [f.path, (f.lfs && f.lfs.size) || f.size || 0]));
      const jobs = Object.values(FILES).map((f) => {
        if (!sizes.get(f)) throw new Error(`Im Voxtral-Repo fehlt die Datei ${f}.`);
        return { url: `${HF}/${REPO}/resolve/main/${f}`, dest: path.join(this.dir, f), size: sizes.get(f) };
      });
      const total = jobs.reduce((n, j) => n + j.size, 0);
      fs.mkdirSync(this.dir, { recursive: true });
      let have = 0;
      for (const j of jobs) { try { have += fs.statSync(fs.existsSync(j.dest) ? j.dest : j.dest + '.part').size; } catch { /* neu */ } }
      const free = await freeBytes(this.dir);
      if (free < total - have + 512 * 1024 * 1024) throw new Error(`Zu wenig Platz auf dem Laufwerk für Voxtral (${APPROX} nötig).`);
      let done = 0;
      for (const j of jobs) {
        let got = 0;
        await fetchFile(j.url, j.dest, j.size, (n) => {
          got += n; done += n;
          this.emit({ task: 'voxtral', label: 'Voxtral', received: done, total, pct: Math.round((done / total) * 100) });
        }, ctrl.signal);
        done += Math.max(0, j.size - got);
      }
      return true;
    } finally {
      this.ctrl = null;
    }
  }

  cancelInstall() { if (this.ctrl) this.ctrl.abort(); }

  remove() {
    this.stop();
    this.cancelInstall();
    fs.rmSync(this.dir, { recursive: true, force: true });
    return true;
  }

  /** Startet den Voxtral-Server (oder gibt den laufenden zurück). Rückgabe: Basis-URL oder null. */
  async ensure() {
    if (!this.ready()) return null;
    if (this.srv && this.srv.child.exitCode == null) { this._touch(); return this.srv.ready; }
    this.stop();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const args = ['-m', this.file('model'), '--mmproj', this.file('mmproj'), '--host', '127.0.0.1', '--port', String(port),
      '-ngl', this.cpu ? '0' : (process.env.FA_VOXTRAL_NGL || 'all'), '-c', '8192', '-np', '1', '--no-webui'];
    const exe = this.getExe();
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    if (child.pid && this.onSpawn) this.onSpawn(child.pid);
    const srv = { child, url, ready: null, log: '' };
    child.stderr.on('data', (d) => { srv.log = (srv.log + d.toString('utf8')).slice(-2000); });
    child.on('error', () => { if (this.srv === srv) this.srv = null; });
    child.on('exit', () => { if (this.srv === srv) this.srv = null; });
    this.srv = srv;
    srv.ready = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        if (child.exitCode != null || this.srv !== srv) return null;
        try { const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) }); if (r.ok) return url; } catch { /* lädt noch */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    })();
    this._touch();
    const ok = await srv.ready;
    if (!ok) {
      const log = srv.log.trim().split('\n').slice(-3).join(' ');
      if (this.srv === srv) this.stop();
      throw new Error('Voxtral startet nicht' + (log ? ': ' + log.slice(-300) : '.'));
    }
    return ok;
  }

  warm() { return this.ensure().then((u) => !!u).catch(() => false); }

  _touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), IDLE_MS);
    if (this.timer.unref) this.timer.unref();
  }

  running() { return !!(this.srv && this.srv.child.exitCode == null); }

  /** Sofort beenden (Programmende). */
  killNow() {
    clearTimeout(this.timer);
    const s = this.srv;
    this.srv = null;
    if (s && s.child.exitCode == null) { try { s.child.kill(); } catch { /* egal */ } }
  }

  stop() {
    clearTimeout(this.timer);
    const s = this.srv;
    this.srv = null;
    if (!s || s.child.exitCode != null) return;
    try {
      if (process.platform === 'win32' && s.child.pid) execFile('taskkill', ['/pid', String(s.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else s.child.kill();
    } catch { /* egal */ }
  }

  /** Startet ein Live-Diktat (Server wird bei Bedarf gestartet). */
  async live(onDelta) {
    const url = await this.ensure();
    if (!url) throw new Error('Voxtral ist noch nicht eingerichtet.');
    this._touch();
    return new LiveSession(url.replace(/^http/, 'ws') + '/v1/realtime?intent=transcription', { onDelta });
  }

  async transcribe(wav) {
    const { pcm, rate } = wavPcm(wav);
    const seconds = pcm.length / 2 / (rate || 16000);
    // Zeitlimit passend zur Länge der Aufnahme statt pauschal 3 Minuten
    // Großzügig (erster Durchgang nach dem Start ist langsamer); FA_VOXTRAL_TIMEOUT_MS nur für Tests auf langsamen Rechnern
    const timeoutMs = Number(process.env.FA_VOXTRAL_TIMEOUT_MS) || Math.min(180000, 60000 + seconds * 6000);
    for (let attempt = 0; ; attempt++) {
      const url = await this.ensure();
      if (!url) throw new Error('Voxtral ist noch nicht eingerichtet.');
      const t0 = Date.now();
      try {
        const text = await transcribeRealtime(url.replace(/^http/, 'ws') + '/v1/realtime?intent=transcription', pcm, rate, { timeoutMs });
        this._touch();
        this.lastTiming = { ms: Date.now() - t0, cpu: !!this.cpu };
        return cleanTranscript(text);
      } catch (e) {
        // Hängt Voxtral auf der Grafikkarte (z. B. weil das Chat-Modell den Grafikspeicher füllt),
        // einmal auf dem Prozessor neu starten und es dort versuchen. Das gilt bis zum Programmende.
        if (attempt === 0 && !this.cpu && /Zeitüberschreitung|Verbindung/.test(String(e.message))) {
          this.cpu = true;
          if (this.onNote) this.onNote('Spracherkennung hing auf der Grafikkarte – läuft jetzt auf dem Prozessor.');
          this.stop();
          continue;
        }
        throw e;
      }
    }
  }
}

module.exports = { Voxtral, LiveSession, transcribeRealtime, wavPcm, FILES, REPO };
