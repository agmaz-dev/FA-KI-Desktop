'use strict';
// Modelle suchen (Hugging Face, öffentliche Schnittstelle, ohne Konto) für „Erkunden“.
// Heruntergeladen wird über Ollama: ollama pull hf.co/<repo>:<Quantisierung>.

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

/** Sucht GGUF-Modelle. sort: downloads | likes | lastModified | trendingScore */
async function search(query, { sort = 'downloads', limit = 30 } = {}, fetchImpl) {
  const q = String(query || '').trim();
  const s = ['downloads', 'likes', 'lastModified', 'trendingScore'].includes(sort) ? sort : 'downloads';
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
  let hasMmproj = false;
  for (const f of siblings || []) {
    const n = String(f.rfilename || '');
    if (!/\.gguf$/i.test(n)) continue;
    if (/mmproj/i.test(n)) { hasMmproj = true; continue; }
    const m = n.match(QUANT_RE);
    if (!m) continue;
    const q = m[1].toUpperCase();
    const cur = map.get(q) || { name: q, bytes: 0, files: 0 };
    cur.bytes += f.size || (f.lfs && f.lfs.size) || 0;
    cur.files++;
    map.set(q, cur);
  }
  return { quants: [...map.values()].filter((x) => x.bytes > 0).sort((a, b) => a.bytes - b.bytes), hasMmproj };
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
    quants: quants.map((q) => ({ name: q.name, bytes: q.bytes, ...fitFor(q.bytes, hw), empfohlen: q.name === rec, pull: `hf.co/${id}:${q.name}` })),
    readme,
  };
}

/** Prüft, dass ein Modellname für ollama pull sicher aussieht (Ollama-Bibliothek oder hf.co). */
function okPullName(name) {
  const n = String(name || '').trim();
  return /^(hf\.co\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?|[a-z0-9][A-Za-z0-9._\/-]{0,80}(:[A-Za-z0-9._-]{1,40})?)$/.test(n);
}

module.exports = { search, details, quantsFromFiles, fitFor, recommend, featuresOf, okPullName, okId };
