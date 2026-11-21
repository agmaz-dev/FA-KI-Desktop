'use strict';
// Eigene Rechen-Engine: startet llama-server (llama.cpp) direkt aus der App – ohne Ollama.
// Die Chat-Schnittstelle bleibt im Ollama-Format (messages, tools, think, options → Stream-Blöcke),
// damit Werkzeugschleife und Oberfläche unverändert bleiben. Hier wird nur übersetzt.

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { mtpLayers } = require('./gguf');

const SERVER_NAMES = process.platform === 'win32' ? ['llama-server.exe'] : ['llama-server'];

/** Sucht llama-server: Umgebungsvariable, App-Ressourcen (installiert) oder vendor/llama (Entwicklung). */
function findServerExe(resourcesPath, appDir) {
  const cands = [];
  if (process.env.FA_LLAMA_SERVER) cands.push(process.env.FA_LLAMA_SERVER);
  if (resourcesPath) for (const n of SERVER_NAMES) cands.push(path.join(resourcesPath, 'llama', n));
  if (appDir) for (const n of SERVER_NAMES) cands.push(path.join(appDir, 'vendor', 'llama', n));
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** keepAlive-Einstellung ('5m', '30m', '2h', '-1') → Sekunden bis zum Entladen (-1 = nie). */
/** Verständliche Meldung, wenn llama-server beim Laden abbricht. err.memory = zu wenig Speicher. */
function engineError(tail, spawnError) {
  const log = (tail || []).join('\n');
  const last = (tail || []).slice(-4).join(' | ');
  let e;
  if (spawnError) e = new Error('Die Engine konnte nicht starten: ' + spawnError.message);
  else if (/failed to open|No such file|cannot open/i.test(log) && !/allocate/i.test(log)) e = new Error('Die Modelldatei ist nicht lesbar oder fehlt. Bitte in der Bibliothek neu laden.');
  else if (/invalid ggml type|unknown ggml type|invalid tensor type|unsupported (tensor|ggml) type|type \d+ (is )?(invalid|not supported)/i.test(log)) {
    e = new Error('Diese Modelldatei nutzt ein Sonderformat, das nur mit einer abgewandelten Engine läuft. Bitte eine andere Stufe desselben Modells laden (z. B. Q4_K_M oder Q2_g64).');
  } else if (/unknown (model )?architecture|unsupported model|unknown pre-tokenizer|wrong number of tensors|invalid magic|failed to read magic/i.test(log)) {
    e = new Error('Dieses Modell wird von der eingebauten Engine nicht unterstützt (neue oder ungewöhnliche Bauart). Bitte ein anderes Modell wählen.' + (last ? ` (${last})` : ''));
  } else if (/out of memory|failed to allocate|unable to allocate|insufficient memory|ErrorOutOfDeviceMemory|kIOGPUCommandBufferCallbackErrorOutOfMemory|cudaMalloc failed|not enough memory|bad_alloc/i.test(log) || !log) {
    e = new Error('Zu wenig Arbeitsspeicher für dieses Modell. Bitte eine kleinere Stufe (z. B. Q4) oder ein kleineres Modell wählen oder andere Programme schließen.');
    e.memory = true;
  } else {
    e = new Error('Die Engine hat sich beim Laden beendet: ' + last + ' – meist zu wenig Speicher oder eine beschädigte Modelldatei.');
    e.memory = true;
  }
  return e;
}

function idleSeconds(keepAlive) {
  const k = String(keepAlive == null ? '5m' : keepAlive).trim();
  if (k === '-1' || k === '') return -1;
  const m = k.match(/^(\d+)\s*([smh])?$/i);
  if (!m) return 300;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  return n * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
}

// ---------- Übersetzung Ollama-Format → OpenAI-Format ----------

function mimeOfBase64(b64) {
  const s = String(b64 || '');
  if (s.startsWith('/9j/')) return 'image/jpeg';
  if (s.startsWith('iVBOR')) return 'image/png';
  if (s.startsWith('R0lGO')) return 'image/gif';
  if (s.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

function toOpenAIMessages(messages) {
  const out = [];
  let n = 0;
  const pending = []; // offene Werkzeug-Aufrufe in Reihenfolge: { id, name }
  for (const m of messages || []) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c) => {
        const fn = (c && c.function) || {};
        const id = 'call_' + (++n);
        pending.push({ id, name: fn.name });
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
        return { id, type: 'function', function: { name: fn.name, arguments: args } };
      });
      out.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
    } else if (m.role === 'tool') {
      const i = pending.findIndex((p) => p.name === m.tool_name);
      const hit = i >= 0 ? pending.splice(i, 1)[0] : pending.shift();
      out.push({ role: 'tool', tool_call_id: hit ? hit.id : 'call_' + (++n), content: String(m.content == null ? '' : m.content) });
    } else if (Array.isArray(m.images) && m.images.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const b of m.images) parts.push({ type: 'image_url', image_url: { url: `data:${mimeOfBase64(b)};base64,${b}` } });
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: m.content == null ? '' : m.content });
    }
  }
  return out;
}

function buildRequest(body) {
  const o = body.options || {};
  const req = {
    model: 'local',
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAIMessages(body.messages),
  };
  if (Array.isArray(body.tools) && body.tools.length) req.tools = body.tools;
  if (o.temperature != null) req.temperature = o.temperature;
  if (o.top_p != null) req.top_p = o.top_p;
  if (o.top_k != null) req.top_k = o.top_k;
  if (o.min_p != null) req.min_p = o.min_p;
  if (o.repeat_penalty != null) req.repeat_penalty = o.repeat_penalty;
  if (o.seed != null) req.seed = o.seed;
  if (o.num_predict > 0) req.max_tokens = o.num_predict;
  if (Array.isArray(o.stop) && o.stop.length) req.stop = o.stop;
  if (typeof body.think === 'string') req.reasoning_effort = body.think; // gpt-oss: low / medium / high
  else if (body.think === false) req.chat_template_kwargs = { enable_thinking: false };
  else if (body.think === true) req.chat_template_kwargs = { enable_thinking: true };
  return req;
}

// ---------- Stream (SSE) lesen und in Ollama-Blöcke zurückübersetzen ----------

/**
 * Nimmt SSE-Daten Stück für Stück entgegen und ruft onObj mit Ollama-artigen Blöcken auf.
 * Am Ende (finish) kommt ein Block mit done:true, den gesammelten Werkzeug-Aufrufen und der Statistik.
 */
function createSseTranslator(onObj) {
  let buf = '';
  const calls = [];
  let finish = '';
  let usage = null;
  let timings = null;
  let ended = false;

  const handle = (data) => {
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new Error('Engine: ' + (j.error.message || JSON.stringify(j.error)));
    if (j.usage) usage = j.usage;
    if (j.timings) timings = j.timings;
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    const d = ch.delta || {};
    const content = d.content || '';
    const thinking = d.reasoning_content || '';
    if (content || thinking) onObj({ message: { role: 'assistant', content, thinking }, done: false });
    for (const tc of d.tool_calls || []) {
      const i = tc.index == null ? calls.length : tc.index;
      const cur = calls[i] || (calls[i] = { name: '', args: '' });
      if (tc.function && tc.function.name) cur.name += tc.function.name;
      if (tc.function && typeof tc.function.arguments === 'string') cur.args += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };

  const feed = (text) => {
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
  };

  const end = () => {
    if (ended) return;
    ended = true;
    if (buf.startsWith('data:')) handle(buf.slice(5).trim());
    const tool_calls = calls.filter(Boolean).map((c) => {
      let args = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = c.args; }
      return { function: { name: c.name, arguments: args } };
    });
    const msg = { role: 'assistant', content: '' };
    if (tool_calls.length) msg.tool_calls = tool_calls;
    onObj({
      message: msg,
      done: true,
      done_reason: tool_calls.length ? 'tool_calls' : finish === 'length' ? 'length' : 'stop',
      eval_count: (timings && timings.predicted_n) || (usage && usage.completion_tokens) || 0,
      eval_duration: Math.round(((timings && timings.predicted_ms) || 0) * 1e6),
      prompt_eval_count: (usage && usage.prompt_tokens) || ((timings && ((timings.prompt_n || 0) + (timings.cache_n || 0))) || 0),
    });
  };
  return { feed, end };
}

function friendlyError(status, text) {
  let msg = text || '';
  try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || msg; } catch { /* roh */ }
  msg = String(msg);
  if (/exceed|context size|too long|n_ctx/i.test(msg)) {
    return 'Der Text ist länger als der Kontext des Modells. Erhöhe die Kontextlänge in Einstellungen → Standardwerte für lokale Modelle oder kürze den Text.';
  }
  return `Engine: ${msg || 'Fehler'} (${status})`;
}

// ---------- Engine ----------

class Engine {
  /**
   * opts: { exePath, getSettings(), resolveModel(name) → { file, mmproj }, onStatus(text) }
   */
  constructor(opts) {
    this.exePath = opts.exePath;
    this.getSettings = opts.getSettings;
    this.resolveModel = opts.resolveModel;
    this.onStatus = opts.onStatus || (() => {});
    this.spawnFn = opts.spawnFn || spawn;
    this.beforeStart = opts.beforeStart || null;
    this.onSpawn = opts.onSpawn || (() => {});
    this.child = null;
    this.mtp = false;
    this.port = 0;
    this.key = '';
    this.loading = null;
    this.tail = [];
    this.version = '';
  }

  available() { return !!this.exePath && fs.existsSync(this.exePath); }

  async getVersion() {
    if (this.version) return this.version;
    if (!this.available()) return '';
    try { // CI schreibt die Version der mitgelieferten Engine neben das Programm
      const v = fs.readFileSync(path.join(path.dirname(this.exePath), 'VERSION'), 'utf8').trim();
      if (/^b\d+$/.test(v)) { this.version = v; return v; }
    } catch { /* keine Datei */ }
    this.version = await new Promise((resolve) => {
      execFile(this.exePath, ['--version'], { windowsHide: true, timeout: 8000, cwd: path.dirname(this.exePath) }, (e, so, se) => {
        const t = `${so || ''}\n${se || ''}`;
        const m = t.match(/version:\s*(\d{3,})\s*\(/i);
        resolve(m ? 'b' + m[1] : '');
      });
    });
    return this.version;
  }

  /** Hat die Modelldatei eingebaute MTP-Köpfe? (Ergebnis je Datei gemerkt) */
  hasMtp(file) {
    this._mtpCache = this._mtpCache || new Map();
    if (!this._mtpCache.has(file)) this._mtpCache.set(file, mtpLayers(file) > 0);
    return this._mtpCache.get(file);
  }

  buildArgs(entry, numCtx, port, opts = {}) {
    const s = this.getSettings();
    const args = ['-m', entry.file, '--host', '127.0.0.1', '--port', String(port), '-c', String(numCtx),
      '--jinja', '--no-webui', '--parallel', '1', '--reasoning-format', 'deepseek', '--cache-ram', '1024'];
    if (entry.mmproj) args.push('--mmproj', entry.mmproj);
    // MTP: eingebaute Vorausrate-Köpfe nutzen -> schnellere Antworten bei gleicher Qualität
    if (opts.mtp) args.push('--spec-type', 'draft-mtp');
    const idle = idleSeconds(s.keepAlive);
    if (idle > 0) args.push('--sleep-idle-seconds', String(idle));
    return args;
  }

  /** Stellt sicher, dass das Modell geladen ist. Gibt den Port zurück. */
  async ensure(modelName, numCtx, signal) {
    const entry = this.resolveModel(modelName);
    if (!entry) throw new Error(`Modell „${modelName}“ ist nicht in der Bibliothek.`);
    if (!this.available()) throw new Error('Die Rechen-Engine (llama-server) fehlt in dieser Installation. Bitte die App neu installieren.');
    const key = `${entry.file}|${entry.mmproj || ''}|${numCtx}|${this.getSettings().keepAlive}`;
    if (this.child && this.key === key && this.port) return this.port;
    if (this.loading && this.loadKey === key) return this.loading;
    await this.stop();
    this.loadKey = key;
    this.loading = (async () => {
      if (this.beforeStart) { try { await this.beforeStart(); } catch { /* egal */ } }
      let mtp = this.hasMtp(entry.file);
      let ctx = numCtx;
      for (let attempt = 0; ; attempt++) {
        try {
          const port = await this._start(entry, ctx, key, signal, { mtp });
          this.mtp = mtp;
          return port;
        } catch (e) {
          if ((signal && signal.aborted) || attempt >= 2) throw e;
          // MTP macht Probleme (oder braucht zu viel Speicher): ohne MTP nochmal
          if (mtp) { mtp = false; this.onStatus('Lade ohne Schnellmodus (MTP) …'); continue; }
          // Zu wenig Speicher: einmal mit kleinerem Kontext versuchen, statt abzubrechen
          if (e.memory && ctx > 8192) { ctx = 8192; this.onStatus('Wenig Speicher – lade mit kleinerem Kontext …'); continue; }
          throw e;
        }
      }
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async _start(entry, numCtx, key, signal, opts = {}) {
    const port = await freePort();
    const args = this.buildArgs(entry, numCtx, port, opts);
    this.tail = [];
    this.onStatus('Lade Modell …');
    const child = this.spawnFn(this.exePath, args, { cwd: path.dirname(this.exePath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    if (child.pid) this.onSpawn(child.pid);
    let exited = false;
    let spawnError = null;
    const keep = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { this.tail.push(l.trim()); if (this.tail.length > 40) this.tail.shift(); } };
    if (child.stdout) child.stdout.on('data', keep);
    if (child.stderr) child.stderr.on('data', keep);
    child.on('error', (e) => { spawnError = e; exited = true; });
    child.on('exit', () => { exited = true; if (this.child === child) { this.child = null; this.port = 0; this.key = ''; } });

    const deadline = Date.now() + 15 * 60 * 1000;
    for (;;) {
      if (signal && signal.aborted) { await this.stop(); throw new Error('abgebrochen'); }
      if (exited) {
        this.child = null;
        this.onStatus('');
        throw engineError(this.tail, spawnError);
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200) break;
      } catch { /* startet noch */ }
      if (Date.now() > deadline) { await this.stop(); throw new Error('Das Modell wurde nicht rechtzeitig geladen (Zeitüberschreitung).'); }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.port = port;
    this.key = key;
    this.onStatus('');
    return port;
  }

  /** Sofort beenden (auch beim Programmende, ohne zu warten). */
  killNow() {
    const c = this.child;
    this.child = null; this.port = 0; this.key = '';
    if (c && c.exitCode == null) { try { c.kill(); } catch { /* egal */ } }
  }

  async stop() {
    const c = this.child;
    this.child = null; this.port = 0; this.key = '';
    if (!c) return;
    try {
      if (process.platform === 'win32' && c.pid) execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else c.kill('SIGTERM');
    } catch { /* egal */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  /** Chat im Ollama-Format. onObj bekommt Ollama-artige Blöcke. */
  async chatStream(body, onObj, signal) {
    const numCtx = (body.options && body.options.num_ctx) || this.getSettings().numCtx || 16384;
    const port = await this.ensure(body.model, numCtx, signal);
    const req = buildRequest(body);
    const res = await new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(req), 'utf8');
      const r = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, signal }, resolve);
      r.on('error', reject);
      r.end(data);
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const parts = [];
      for await (const c of res) parts.push(c);
      throw new Error(friendlyError(res.statusCode, Buffer.concat(parts).toString('utf8')));
    }
    const tr = createSseTranslator(onObj);
    const dec = new TextDecoder('utf-8');
    try {
      for await (const chunk of res) tr.feed(dec.decode(chunk, { stream: true }));
    } finally {
      res.destroy();
    }
    tr.end();
  }
}

module.exports = { Engine, engineError, findServerExe, freePort, idleSeconds, toOpenAIMessages, buildRequest, createSseTranslator, friendlyError, mimeOfBase64 };
