'use strict';
// Modelle suchen (Hugging Face, öffentliche Schnittstelle, ohne Konto) für „Erkunden“.
// Heruntergeladen wird direkt von Hugging Face (lib/download.js) in den Modellordner der App.

const HF = 'https://huggingface.co';
const GIB = 1024 * 1024 * 1024;

const QUANT_RE = /(IQ\d_[A-Z]+(?:_[A-Z0-9]+)?|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d|Q\d_0|MXFP4|BF16|F16|F32|Q\d)/i;
const okId = (s) => /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/.test(String(s || '')) && !String(s).split('/').some((x) => /^\.+$/.test(x));

async function getJson(url, fetchImpl = fetch, timeout = 15000) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'FA-KI-Desktop', Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Hugging Face: ${res.status === 429 ? 'zu viele Anfragen, kurz warten' : res.statusText || 'Fehler'} (${res.status})`);
  return res.json();
}

/** Merkmale grob aus Schlagworten und Namen. Ungenau, deshalb nur als Hinweis anzeigen. */
function featuresOf({ id = '', tags = [], pipeline = '', hasMmproj = false }) {
  const t = new Set((tags || []).map((x) => String(x).toLowerCase()));
  const name = String(id).toLowerCase();
  const f = [];
  if (hasMmproj || pipeline === 'image-text-to-text' || t.has('image-text-to-text') || t.has('vision') || t.has('multimodal') || /vl\b|-vl-|vision/.test(name)) f.push('Bilder');
  if (t.has('tool-use') || t.has('function-calling') || t.has('tools') || t.has('agent') || /instruct|gpt-oss|qwen3|qwen2\.5|llama-3\.[123]|mistral|hermes/.test(name)) f.push('Werkzeuge');
  if (t.has('reasoning') || t.has('thinking') || /think|reason|r1\b|qwq|gpt-oss|qwen3/.test(name)) f.push('Denken');
  return f;
}

/** Sucht GGUF-Modelle. sort: downloads | likes | lastModified | trendingScore | createdAt */
async function search(query, { sort = 'downloads', limit = 50 } = {}, fetchImpl) {
  const q = String(query || '').trim();
  const s = ['downloads', 'likes', 'lastModified', 'trendingScore', 'createdAt'].includes(sort) ? sort : 'downloads';
  const url = `${HF}/api/models?filter=gguf&sort=${s}&direction=-1&limit=${Math.min(60, Math.max(1, limit | 0))}` + (q ? `&search=${encodeURIComponent(q)}` : '');
  const d = await getJson(url, fetchImpl);
  return (Array.isArray(d) ? d : []).filter((m) => okId(m.id || m.modelId)).map((m) => ({
    id: m.id || m.modelId,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    updated: m.lastModified || m.createdAt || '',
    features: featuresOf({ id: m.id || m.modelId, tags: m.tags, pipeline: m.pipeline_tag }),
  }));
}

/** Fasst die Dateien eines Repos zu Quantisierungen zusammen (geteilte Dateien werden addiert). */
function quantsFromFiles(siblings) {
  const map = new Map();
  const mmprojs = [];
  for (const f of siblings || []) {
    const n = String(f.rfilename || '');
    if (!/\.gguf$/i.test(n)) continue;
    const size = f.size || (f.lfs && f.lfs.size) || 0;
    if (/mmproj/i.test(n)) { mmprojs.push({ path: n, size }); continue; }
    const m = n.match(QUANT_RE);
    if (!m) continue;
    const q = m[1].toUpperCase();
    const cur = map.get(q) || { name: q, bytes: 0, files: 0, list: [] };
    cur.bytes += size;
    cur.files++;
    cur.list.push({ path: n, size });
    map.set(q, cur);
  }
  // Bildteil: bevorzugt F16, dann BF16, sonst die erste Datei
  const mmproj = mmprojs.find((x) => /f16/i.test(x.path) && !/bf16/i.test(x.path)) || mmprojs.find((x) => /bf16/i.test(x.path)) || mmprojs[0] || null;
  return { quants: [...map.values()].filter((x) => x.bytes > 0).sort((a, b) => a.bytes - b.bytes), hasMmproj: mmprojs.length > 0, mmproj };
}

/**
 * Passt ein Modell auf den PC? hw = { vramGb, ramGb }.
 * Grob: Modellgröße plus etwa 1,5 GB für Kontext. gpu = alles auf der Grafikkarte (schnell);
 * teils = zusätzlich Arbeitsspeicher nötig (deutlich langsamer); nein = zu groß.
 */
function fitFor(bytes, hw) {
  const vram = Number(hw && hw.vramGb) || 16;
  const ram = Number(hw && hw.ramGb) || 32;
  const need = bytes / GIB + 1.5;
  if (need <= vram) return { fit: 'gpu', text: 'Passt auf Deine Karte' };
  if (need <= vram + ram * 0.6) return { fit: 'teils', text: 'Teils auf der Karte, langsamer' };
  return { fit: 'nein', text: 'Zu groß für diesen PC' };
}

/** Empfehlung: größte brauchbare Stufe, die noch ganz auf die Karte passt (bevorzugt Q4/Q5/Q6/Q8), sonst die kleinste Q4. */
function recommend(quants, hw) {
  const usable = quants.filter((q) => /^(IQ4|Q4|Q5|Q6|Q8|MXFP4)/.test(q.name));
  const fits = usable.filter((q) => fitFor(q.bytes, hw).fit === 'gpu');
  if (fits.length) {
    const pref = fits.filter((q) => /^(Q4_K_M|Q5_K_M|Q6_K|Q8_0|MXFP4)$/.test(q.name));
    return (pref.length ? pref : fits).slice().sort((a, b) => b.bytes - a.bytes)[0].name;
  }
  const q4 = usable.filter((q) => /^(IQ4|Q4)/.test(q.name)).sort((a, b) => a.bytes - b.bytes)[0];
  return q4 ? q4.name : (quants[0] && quants[0].name) || '';
}

async function details(id, hw, fetchImpl) {
  if (!okId(id)) throw new Error('Ungültiger Modellname');
  const d = await getJson(`${HF}/api/models/${id}?blobs=true`, fetchImpl);
  const { quants, hasMmproj } = quantsFromFiles(d.siblings);
  const rec = recommend(quants, hw);
  let readme = '';
  try {
    const res = await (fetchImpl || fetch)(`${HF}/${id}/raw/main/README.md`, { headers: { 'User-Agent': 'FA-KI-Desktop' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) readme = (await res.text()).replace(/^---[\s\S]*?\n---\s*\n/, '').slice(0, 7000);
  } catch { /* README ist optional */ }
  return {
    id: d.id || id,
    downloads: d.downloads || 0,
    likes: d.likes || 0,
    updated: d.lastModified || '',
    parameter: ((String(id).match(/(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?\s?[BM])(?![A-Za-z0-9])/i) || [])[1] || '').toUpperCase(),
    architektur: (d.gguf && d.gguf.architecture) || '',
    kontext: (d.gguf && d.gguf.context_length) || 0,
    features: featuresOf({ id, tags: d.tags, pipeline: d.pipeline_tag, hasMmproj }),
    quants: quants.map((q) => ({ name: q.name, bytes: q.bytes, ...fitFor(q.bytes, hw), empfohlen: q.name === rec, pull: `${id}:${q.name}` })),
    readme,
  };
}

/** Zerlegt „besitzer/repo:QUANT“ (so heißen heruntergeladene Modelle). Gibt null zurück, wenn der Name nicht sicher aussieht. */
function parsePull(name) {
  const m = String(name || '').trim().match(/^([A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}):([A-Za-z0-9._-]{1,40})$/);
  if (!m || !okId(m[1])) return null;
  return { id: m[1], quant: m[2].toUpperCase() };
}

/** Plan für den Download: welche Dateien gehören zu einer Quantisierung (plus Bildteil). */
async function plan(id, quant, fetchImpl) {
  if (!okId(id)) throw new Error('Ungültiger Modellname');
  const d = await getJson(`${HF}/api/models/${id}?blobs=true`, fetchImpl);
  const { quants, hasMmproj, mmproj } = quantsFromFiles(d.siblings);
  const q = quants.find((x) => x.name === String(quant).toUpperCase());
  if (!q) throw new Error(`Die Stufe ${quant} gibt es in diesem Repo nicht.`);
  const files = q.list.slice().sort((a, b) => a.path.localeCompare(b.path));
  if (files.some((f) => !f.size)) throw new Error('Dateigrößen unbekannt, Download nicht möglich.');
  return {
    id, quant: q.name, files, mmproj: mmproj && mmproj.size ? mmproj : null,
    features: featuresOf({ id, tags: d.tags, pipeline: d.pipeline_tag, hasMmproj }),
    parameter: ((String(id).match(/(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?\s?[BM])(?![A-Za-z0-9])/i) || [])[1] || '').toUpperCase(),
    architektur: (d.gguf && d.gguf.architecture) || '',
  };
}

module.exports = { search, details, plan, quantsFromFiles, fitFor, recommend, featuresOf, parsePull, okId, HF };
