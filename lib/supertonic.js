'use strict';
/**
 * Supertonic 3 – schnelle, lokale Stimme (ONNX, nur CPU, ohne Python).
 * Umsetzung nach dem offiziellen Node.js-Beispiel von Supertone (MIT-Code, Modell OpenRAIL-M).
 * Modelldateien (ca. 250 MB) werden einmalig geladen und liegen in <Datenordner>/supertonic.
 */
const fs = require('fs');
const path = require('path');
const { downloadFile } = require('./downloader');

const REV = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const REPO = 'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/';
const LANGS = ['de', 'tr'];

/** Eigene Stimmennamen -> Kennung im Modell. */
const VOICES = {
  elena: { id: 'F2', label: 'Elena (weiblich)' },
  tessa: { id: 'F5', label: 'Tessa (weiblich)' },
  caleb: { id: 'M2', label: 'Caleb (männlich)' },
};
const DEFAULT_VOICE = 'elena';

const MODEL_FILES = [
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
  'onnx/duration_predictor.onnx',
  'onnx/text_encoder.onnx',
  'onnx/vector_estimator.onnx',
  'onnx/vocoder.onnx',
];
const voiceFile = (id) => `voice_styles/${id}.json`;

function chunkText(text, maxLen = 300) {
  const paragraphs = String(text).trim().split(/\n\s*\n+/).filter((p) => p.trim());
  const chunks = [];
  for (let paragraph of paragraphs) {
    paragraph = paragraph.trim();
    if (!paragraph) continue;
    const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.|z\.B\.|d\.h\.|ca\.|Nr\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);
    let cur = '';
    for (const s of sentences) {
      if (cur.length + s.length + 1 <= maxLen) cur += (cur ? ' ' : '') + s;
      else {
        if (cur) chunks.push(cur.trim());
        cur = s;
      }
    }
    if (cur) chunks.push(cur.trim());
  }
  return chunks;
}

/** Text vorbereiten wie im Beispiel von Supertone. */
function preprocessText(text, lang) {
  if (!LANGS.includes(lang)) throw new Error('Sprache nicht unterstützt: ' + lang);
  text = String(text).normalize('NFKD');
  text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  const rep = { '–': '-', '‑': '-', '—': '-', _: ' ', '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' };
  for (const [k, v] of Object.entries(rep)) text = text.split(k).join(v);
  text = text.replace(/[♥☆♡©\\]/g, '');
  text = text.split('@').join(lang === 'tr' ? ' ' : ' at ');
  text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

function randNormal() {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function wavBuffer(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

class Supertonic {
  /** @param ort nur für Tests: eigenes onnxruntime-Modul */
  constructor(dataDir, emit, ort) {
    this.dir = path.join(dataDir, 'supertonic');
    this.emit = emit || (() => {});
    this.ort = ort || null;
    this.engine = null;
    this.styles = new Map();
    this.queue = Promise.resolve();
    this.ctrl = null;
  }

  file(rel) { return path.join(this.dir, rel); }

  hasModel() { return MODEL_FILES.every((f) => fs.existsSync(this.file(f))); }
  hasVoice(name) {
    const v = VOICES[name];
    return !!v && fs.existsSync(this.file(voiceFile(v.id)));
  }
  status() {
    const voices = {};
    for (const k of Object.keys(VOICES)) voices[k] = this.hasVoice(k);
    return { model: this.hasModel(), voices, ready: this.hasModel() && Object.values(voices).some(Boolean), dir: this.dir };
  }

  abort() { if (this.ctrl) this.ctrl.abort(); }

  /** Lädt alle fehlenden Dateien (Modell + die drei Stimmen). */
  async prepare() {
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    try {
      const rels = [...MODEL_FILES, ...Object.values(VOICES).map((v) => voiceFile(v.id))].filter((r) => !fs.existsSync(this.file(r)));
      let i = 0;
      for (const rel of rels) {
        i++;
        const label = `Supertonic: Datei ${i} von ${rels.length} (${path.basename(rel)})`;
        let lastErr = null;
        for (const rev of [REV, 'main']) {
          try {
            await downloadFile(REPO + rev + '/' + rel, this.file(rel), ({ received, total }) => {
              this.emit({ task: 'supertonic', label, received, total, pct: total ? Math.round((received / total) * 100) : null });
            }, signal);
            lastErr = null;
            break;
          } catch (e) {
            if (signal.aborted) throw new Error('Abgebrochen.');
            lastErr = e;
          }
        }
        if (lastErr) throw new Error(`${path.basename(rel)} konnte nicht geladen werden (${lastErr.message}).`);
      }
      this.engine = null;
      return this.status();
    } finally {
      this.ctrl = null;
    }
  }

  _ort() {
    if (!this.ort) this.ort = require('onnxruntime-node');
    return this.ort;
  }

  async _load() {
    if (this.engine) return this.engine;
    if (!this.hasModel()) throw new Error('Supertonic ist noch nicht geladen.');
    const ort = this._ort();
    const cfg = JSON.parse(fs.readFileSync(this.file('onnx/tts.json'), 'utf8'));
    const indexer = JSON.parse(fs.readFileSync(this.file('onnx/unicode_indexer.json'), 'utf8'));
    const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
    const mk = (n) => ort.InferenceSession.create(this.file('onnx/' + n + '.onnx'), opts);
    const [dp, enc, vec, voc] = await Promise.all([mk('duration_predictor'), mk('text_encoder'), mk('vector_estimator'), mk('vocoder')]);
    this.engine = { cfg, indexer, dp, enc, vec, voc };
    return this.engine;
  }

  _style(name) {
    const key = VOICES[name] ? name : DEFAULT_VOICE;
    if (this.styles.has(key)) return this.styles.get(key);
    const f = this.file(voiceFile(VOICES[key].id));
    if (!fs.existsSync(f)) throw new Error(`Stimme „${VOICES[key].label}“ ist noch nicht geladen.`);
    const ort = this._ort();
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const tensor = (s) => new ort.Tensor('float32', Float32Array.from(s.data.flat(Infinity)), s.dims);
    const st = { ttl: tensor(j.style_ttl), dp: tensor(j.style_dp) };
    this.styles.set(key, st);
    return st;
  }

  async _infer(eng, chunk, lang, style, steps, speed) {
    const ort = this._ort();
    const text = preprocessText(chunk, lang);
    const chars = Array.from(text);
    const ids = [];
    for (const c of chars) {
      const v = eng.indexer[c.charCodeAt(0)];
      if (v != null && v >= 0) ids.push(v);
    }
    const L = ids.length;
    if (!L) throw new Error('Kein sprechbarer Text.');
    const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, L]);
    const textMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);

    const dpRes = await eng.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const dur = Number(dpRes.duration.data[0]) / speed;
    const encRes = await eng.enc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });

    const sr = eng.cfg.ae.sample_rate;
    const chunkSize = eng.cfg.ae.base_chunk_size * eng.cfg.ttl.chunk_compress_factor;
    const latentDim = eng.cfg.ttl.latent_dim * eng.cfg.ttl.chunk_compress_factor;
    const wavLen = Math.floor(dur * sr);
    const latentLen = Math.max(1, Math.floor((dur * sr + chunkSize - 1) / chunkSize));
    const validLen = Math.floor((wavLen + chunkSize - 1) / chunkSize);
    const latent = new Float32Array(latentDim * latentLen);
    for (let d = 0; d < latentDim; d++) {
      for (let t = 0; t < latentLen; t++) latent[d * latentLen + t] = t < validLen ? randNormal() : 0;
    }
    const maskArr = new Float32Array(latentLen);
    for (let t = 0; t < latentLen; t++) maskArr[t] = t < validLen ? 1 : 0;
    const latentMask = new ort.Tensor('float32', maskArr, [1, 1, latentLen]);
    const totalStep = new ort.Tensor('float32', Float32Array.from([steps]), [1]);

    let cur = latent;
    for (let s = 0; s < steps; s++) {
      const r = await eng.vec.run({
        noisy_latent: new ort.Tensor('float32', cur, [1, latentDim, latentLen]),
        text_emb: encRes.text_emb,
        style_ttl: style.ttl,
        text_mask: textMask,
        latent_mask: latentMask,
        total_step: totalStep,
        current_step: new ort.Tensor('float32', Float32Array.from([s]), [1]),
      });
      cur = Float32Array.from(r.denoised_latent.data);
    }
    const voc = await eng.voc.run({ latent: new ort.Tensor('float32', cur, [1, latentDim, latentLen]) });
    const wav = voc.wav_tts.data;
    return wav.length > wavLen ? wav.slice(0, wavLen) : Float32Array.from(wav);
  }

  /**
   * Text -> WAV (Buffer). Aufträge laufen nacheinander.
   * @param speed Faktor wie die Sprechgeschwindigkeit in den Einstellungen (1 = Normal)
   */
  synthesize(text, lang, voiceName, speed = 1, steps = 8) {
    const job = this.queue.then(() => this._run(text, lang, voiceName, speed, steps));
    this.queue = job.catch(() => {});
    return job;
  }

  async _run(text, lang, voiceName, speed, steps) {
    const lg = LANGS.includes(lang) ? lang : 'de';
    const eng = await this._load();
    const style = this._style(voiceName);
    const sp = Math.min(1.6, Math.max(0.6, 1.05 * (Number(speed) || 1)));
    const chunks = chunkText(text, 220);
    if (!chunks.length) throw new Error('Kein Text zum Vorlesen.');
    const sr = eng.cfg.ae.sample_rate;
    const gap = new Float32Array(Math.floor(0.25 * sr));
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i) parts.push(gap);
      parts.push(await this._infer(eng, chunks[i], lg, style, Math.min(16, Math.max(2, steps | 0)), sp));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return wavBuffer(all, sr);
  }
}

module.exports = { Supertonic, VOICES, DEFAULT_VOICE, MODEL_FILES, preprocessText, chunkText, wavBuffer };
