'use strict';
// Lädt GGUF-Dateien direkt von Hugging Face in den Modellordner – fortsetzbar, mit Fortschritt und Abbruch.

const fs = require('fs');
const path = require('path');
const hf = require('./hf');

const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

/** Sicherer Zielpfad im Modellordner: <ordner>/<besitzer>/<repo>/<datei>. */
function targetPath(root, id, rel) {
  const parts = String(rel).split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || /[\\:]/.test(x))) throw new Error('Ungültiger Dateiname im Repo.');
  const dest = path.resolve(root, ...id.split('/'), ...parts);
  const base = path.resolve(root) + path.sep;
  if (!dest.startsWith(base)) throw new Error('Ungültiger Zielpfad.');
  return dest;
}

async function freeBytes(dir) {
  try { const s = await fs.promises.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}

/** Lädt eine Datei (mit Fortsetzen). onBytes(n) meldet neu geladene Bytes. */
async function fetchFile(url, dest, size, onBytes, signal, fetchImpl = fetch) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) { onBytes(size); return; }
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* neu */ }
  if (have > size) { fs.rmSync(part, { force: true }); have = 0; }
  if (have === size) { fs.renameSync(part, dest); onBytes(size); return; }
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'FA-KI-Desktop', ...(have ? { Range: `bytes=${have}-` } : {}) }, signal, redirect: 'follow' });
  if (res.status === 416) { fs.rmSync(part, { force: true }); throw new Error('Download-Rest ungültig, bitte erneut starten.'); }
  if (!res.ok) throw new Error(`Hugging Face: ${res.status === 429 ? 'zu viele Anfragen, kurz warten' : res.statusText || 'Fehler'} (${res.status})`);
  let resume = have > 0 && res.status === 206;
  if (have > 0 && !resume) have = 0; // Server schickt alles neu
  const out = fs.createWriteStream(part, { flags: resume ? 'a' : 'w' });
  if (resume) onBytes(have);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      onBytes(value.length);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (fs.statSync(part).size !== size) throw new Error('Download unvollständig (Größe stimmt nicht). Bitte erneut starten, er setzt fort.');
  fs.renameSync(part, dest);
}

/**
 * Lädt eine Stufe eines Repos. name = „besitzer/repo:STUFE“.
 * onProgress({ status, total, completed }). Rückgabe: { aborted } oder true.
 */
async function downloadModel({ name, root, onProgress, signal, fetchImpl }) {
  const p = hf.parsePull(name);
  if (!p) throw new Error('Ungültiger Modellname.');
  const plan = await hf.plan(p.id, p.quant, fetchImpl);
  const jobs = plan.files.map((f) => ({ ...f, kind: 'model' }));
  if (plan.mmproj) jobs.push({ ...plan.mmproj, kind: 'mmproj' });
  const total = jobs.reduce((n, f) => n + f.size, 0);

  // Platz prüfen (bereits geladene Reste werden angerechnet)
  const dests = jobs.map((j) => targetPath(root, p.id, j.path));
  let have = 0;
  dests.forEach((d, i) => { try { have += Math.min(fs.statSync(fs.existsSync(d) ? d : d + '.part').size, jobs[i].size); } catch { /* neu */ } });
  await fs.promises.mkdir(root, { recursive: true });
  const free = await freeBytes(root);
  if (free < total - have + 1024 ** 3) {
    const gb = (x) => (x / 1024 ** 3).toFixed(1).replace('.', ',');
    throw new Error(`Zu wenig Platz auf dem Laufwerk: ${gb(total - have)} GB nötig, ${gb(free)} GB frei. Wähle in der Bibliothek einen anderen Modellordner.`);
  }

  let completed = 0;
  let last = 0;
  const report = (status, force) => {
    const now = Date.now();
    if (!force && now - last < 250) return;
    last = now;
    onProgress({ name, status, total, completed });
  };
  report('Starte Download …', true);
  try {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const url = `${hf.HF}/${p.id}/resolve/main/${encodePath(j.path)}`;
      let fileDone = 0;
      await fetchFile(url, dests[i], j.size, (n) => {
        // Fortsetzen meldet den vorhandenen Teil auf einmal; neue Blöcke zählen dazu
        fileDone += n; completed += n;
        report(`Lädt ${path.basename(j.path)}`);
      }, signal, fetchImpl);
      completed += Math.max(0, j.size - fileDone); // falls Datei schon komplett war
    }
  } catch (e) {
    if (signal && signal.aborted) return { aborted: true };
    throw e;
  }
  // Beschreibungsdatei: erst jetzt gilt das Modell als installiert
  const baseDir = path.dirname(dests[0]);
  const rootDir = path.resolve(root, ...p.id.split('/'));
  const rel = (d) => path.relative(rootDir, d).split(path.sep).join('/');
  const mmIdx = plan.mmproj ? jobs.length - 1 : -1;
  fs.writeFileSync(path.join(rootDir, `.fa-${plan.quant}.json`), JSON.stringify({
    name: `${p.id}:${plan.quant}`,
    files: dests.filter((_, i) => i !== mmIdx).map(rel),
    mmproj: mmIdx >= 0 ? rel(dests[mmIdx]) : '',
    features: plan.features, quant: plan.quant, parameter: plan.parameter, architektur: plan.architektur,
    created: new Date().toISOString(), source: 'huggingface',
  }, null, 2));
  void baseDir;
  onProgress({ name, status: 'Fertig', total, completed: total });
  return true;
}

module.exports = { downloadModel, fetchFile, targetPath };
