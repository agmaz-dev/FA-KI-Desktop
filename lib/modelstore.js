'use strict';
// Modellordner: GGUF-Dateien liegen als normale Dateien in einem Ordner (Standard: App-Daten/models).
// Heruntergeladene Modelle bekommen eine kleine Beschreibungsdatei (.fa-<Stufe>.json) neben den Dateien.
// Lose .gguf-Dateien im Ordner werden auch erkannt.

const fs = require('fs');
const path = require('path');
const { featuresOf } = require('./hf');

const SIDECAR = /^\.fa-[A-Za-z0-9._-]+\.json$/;
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT_RE = /(IQ\d_[A-Z]+(?:_[A-Z0-9]+)?|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d|Q\d_0|MXFP4|BF16|F16|F32)/i;
const MAX_DEPTH = 5;

function walk(dir, depth, cb) {
  if (depth > MAX_DEPTH) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, cb);
    else if (e.isFile()) cb(p, e.name);
  }
}

const toCaps = (features) => (features || []).map((f) => ({ Bilder: 'vision', Werkzeuge: 'tools', Denken: 'thinking' })[f]).filter(Boolean);
const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const fileTime = (p) => { try { return fs.statSync(p).mtime.toISOString(); } catch { return ''; } };

/** Ist p innerhalb von root (nach dem Auflösen)? Schützt vor ../ in Beschreibungsdateien. */
function inside(root, p) {
  const r = path.resolve(root) + path.sep;
  const x = path.resolve(p);
  return x.startsWith(r);
}

class ModelStore {
  constructor(getDir) {
    this.getDir = getDir;
  }

  dir() { const d = this.getDir(); try { fs.mkdirSync(d, { recursive: true }); } catch { /* egal */ } return d; }

  /** Alle Modelle: [{ name, file, mmproj, files[], size, modified, features, details, sidecar }] */
  list() {
    const root = this.dir();
    const sidecars = [];
    const ggufs = [];
    walk(root, 0, (p, n) => {
      if (SIDECAR.test(n)) sidecars.push(p);
      else if (/\.gguf$/i.test(n) && !/mmproj/i.test(n)) ggufs.push(p);
    });
    const used = new Set();
    const out = [];
    for (const sc of sidecars) {
      let j;
      try { j = JSON.parse(fs.readFileSync(sc, 'utf8')); } catch { continue; }
      const base = path.dirname(sc);
      const files = (j.files || []).map((f) => path.join(base, f));
      if (!files.length || !files.every((f) => inside(root, f))) continue;
      if (!files.every((f) => fs.existsSync(f))) continue; // unvollständig oder gelöscht
      const mm = j.mmproj ? path.join(base, j.mmproj) : '';
      files.forEach((f) => used.add(f));
      if (mm) used.add(mm);
      out.push({
        name: j.name,
        file: files[0],
        mmproj: mm && inside(root, mm) && fs.existsSync(mm) ? mm : '',
        files: files.concat(mm ? [mm] : []),
        size: files.reduce((n, f) => n + fileSize(f), 0) + (mm ? fileSize(mm) : 0),
        modified: j.created || fileTime(files[0]),
        features: j.features || [],
        details: { parameter_size: j.parameter || '', quantization_level: j.quant || '', family: j.architektur || '' },
        sidecar: sc,
      });
    }
    // lose Dateien (nur die erste eines geteilten Modells)
    for (const f of ggufs) {
      if (used.has(f)) continue;
      const sp = f.match(SPLIT_RE);
      if (sp && sp[1] !== '00001') continue;
      const rel = path.relative(root, f).split(path.sep).join('/').replace(SPLIT_RE, '').replace(/\.gguf$/i, '');
      let size = fileSize(f);
      if (sp) { // alle Teile addieren
        const stem = f.slice(0, f.length - sp[0].length);
        for (let i = 2; i <= parseInt(sp[2], 10); i++) size += fileSize(`${stem}-${String(i).padStart(5, '0')}-of-${sp[2]}.gguf`);
      }
      const dir = path.dirname(f);
      const mm = fs.readdirSync(dir).find((n) => /mmproj/i.test(n) && /\.gguf$/i.test(n));
      const q = (path.basename(f).match(QUANT_RE) || [])[1] || '';
      const params = ((rel.match(/(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?\s?[BM])(?![A-Za-z0-9])/i) || [])[1] || '').toUpperCase();
      out.push({
        name: rel,
        file: f,
        mmproj: mm ? path.join(dir, mm) : '',
        files: [f],
        size,
        modified: fileTime(f),
        features: featuresOf({ id: rel, hasMmproj: !!mm }),
        details: { parameter_size: params, quantization_level: q.toUpperCase(), family: '' },
        sidecar: '',
      });
    }
    return out.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  }

  find(name) { return this.list().find((m) => m.name === name) || null; }

  capabilities(name) {
    const m = this.find(name);
    return m ? toCaps(m.features) : [];
  }

  /** Löscht ein Modell (nur Dateien innerhalb des Modellordners). */
  remove(name) {
    const root = this.dir();
    const m = this.find(name);
    if (!m) throw new Error('Modell nicht gefunden.');
    for (const f of m.files) if (inside(root, f)) { try { fs.rmSync(f, { force: true }); } catch (e) { throw new Error('Löschen fehlgeschlagen: ' + e.message); } }
    if (m.sidecar) { try { fs.rmSync(m.sidecar, { force: true }); } catch { /* egal */ } }
    // leere Ordner wegräumen (bis zum Modellordner)
    let d = path.dirname(m.file);
    while (inside(root, d)) {
      try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
      d = path.dirname(d);
    }
    return true;
  }
}

// ---------- Übernahme aus Ollama (Hardlink: kostet keinen zusätzlichen Platz) ----------

function ollamaRoot() {
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.ollama', 'models');
}

/** Liest die Ollama-Modellliste von der Festplatte: [{ name, file, mmproj, size }]. */
function findOllamaModels(root = ollamaRoot()) {
  const man = path.join(root, 'manifests');
  const out = [];
  walk(man, 0, (p) => {
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return; }
    const layers = (j && j.layers) || [];
    const blob = (type) => {
      const l = layers.find((x) => x.mediaType === type);
      if (!l || !l.digest) return '';
      const f = path.join(root, 'blobs', String(l.digest).replace(':', '-'));
      return fs.existsSync(f) ? f : '';
    };
    const file = blob('application/vnd.ollama.image.model');
    if (!file) return;
    const rel = path.relative(man, p).split(path.sep); // registry / namespace / modell / tag
    const tag = rel.pop();
    const model = rel.slice(1).filter((x) => x !== 'library').join('/'); // z. B. gpt-oss oder owner/repo
    const mmproj = blob('application/vnd.ollama.image.projector');
    out.push({ name: `${model}:${tag}`, file, mmproj, size: fileSize(file) + (mmproj ? fileSize(mmproj) : 0) });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

/** Übernimmt ein Ollama-Modell in den Modellordner (Hardlink, sonst Kopie). */
async function importOllamaModel(store, m, onProgress) {
  const root = store.dir();
  const dir = path.join(root, 'ollama-import');
  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(m.name);
  const target = path.join(dir, base + '.gguf');
  const targetMm = m.mmproj ? path.join(dir, base + '-mmproj.gguf') : '';
  const place = async (src, dst) => {
    if (fs.existsSync(dst)) return;
    try { fs.linkSync(src, dst); } catch {
      onProgress && onProgress('Kopiere ' + path.basename(dst) + ' …');
      await fs.promises.copyFile(src, dst);
    }
  };
  await place(m.file, target);
  if (targetMm) await place(m.mmproj, targetMm);
  const features = featuresOf({ id: m.name, hasMmproj: !!m.mmproj });
  const q = (m.name.match(QUANT_RE) || [])[1] || '';
  const side = path.join(dir, `.fa-${base}.json`);
  fs.writeFileSync(side, JSON.stringify({
    name: m.name, files: [path.basename(target)], mmproj: targetMm ? path.basename(targetMm) : '',
    features, quant: q.toUpperCase(), parameter: ((m.name.match(/(\d+(?:\.\d+)?[bB])\b/) || [])[1] || '').toUpperCase(), architektur: '',
    created: new Date().toISOString(), source: 'ollama',
  }, null, 2));
  return true;
}

module.exports = { ModelStore, findOllamaModels, importOllamaModel, ollamaRoot, inside, toCaps };
