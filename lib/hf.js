'use strict';
// Modelle suchen (Hugging Face, öffentliche Schnittstelle, ohne Konto) für „Erkunden“.
// Heruntergeladen wird direkt von Hugging Face (lib/download.js) in den Modellordner der App.

const HF = 'https://huggingface.co';
const GIB = 1024 * 1024 * 1024;

const QUANT_RE = /(IQ\d_[A-Z]+(?:_[A-Z0-9]+)?|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d|Q\d_0|MXFP4|BF16|F16|F32|Q\d)/i;
const okId = (s) => /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/.test(String(s || '')) && !String(s).split('/').some((x) => /^\.+$/.test(x));

/** Kopfzeilen für Hugging Face; das Token wird nur bei Downloads mitgeschickt. */
const authHeaders = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

async function getJson(url, fetchImpl = fetch, timeout = 15000, token = '') {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'FA-KI-Desktop', Accept: 'application/json', ...authHeaders(token) }, signal: AbortSignal.timeout(timeout) });
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

/** Liest aus dem Link-Kopf von Hugging Face die Adresse der nächsten Seite. */
function nextLink(res) {
  const l = res.headers && res.headers.get ? res.headers.get('link') || '' : '';
  const m = l.match(/<([^>]+)>\s*;\s*rel="next"/);
  return m && m[1].startsWith(HF + '/api/models') ? m[1] : '';
}
const toItem = (m) => ({
  id: m.id || m.modelId,
  downloads: m.downloads || 0,
  likes: m.likes || 0,
  updated: m.lastModified || m.createdAt || '',
  features: featuresOf({ id: m.id || m.modelId, tags: m.tags, pipeline: m.pipeline_tag }),
});

/**
 * Sucht GGUF-Modelle. sort: downloads | likes | lastModified | trendingScore | createdAt.
 * Gibt { items, next } zurück; next ist die Adresse der nächsten Seite (für „Weitere laden“).
 * Ohne Treffer mit Leerzeichen („qwen 3.5“) wird auch die Schreibweise ohne bzw. mit Bindestrich versucht.
 */
async function search(query, { sort = 'downloads', limit = 100, next = '' } = {}, fetchImpl = fetch) {
  const q = String(query || '').trim();
  const s = ['downloads', 'likes', 'lastModified', 'trendingScore', 'createdAt'].includes(sort) ? sort : 'downloads';
  const page = async (url) => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'FA-KI-Desktop', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Hugging Face: ${res.status === 429 ? 'zu viele Anfragen, kurz warten' : res.statusText || 'Fehler'} (${res.status})`);
    const d = await res.json();
    return { items: (Array.isArray(d) ? d : []).filter((m) => okId(m.id || m.modelId)).map(toItem), next: nextLink(res) };
  };
  if (next) {
    if (!String(next).startsWith(HF + '/api/models?')) throw new Error('Ungültige Seitenadresse.');
    return page(next);
  }
  const url = (term) => `${HF}/api/models?filter=gguf&sort=${s}&direction=-1&limit=${Math.min(100, Math.max(1, limit | 0))}` + (term ? `&search=${encodeURIComponent(term)}` : '');
  let r = await page(url(q));
  if (!r.items.length && /\s/.test(q)) {
    for (const alt of [q.replace(/\s+/g, ''), q.replace(/\s+/g, '-')]) {
      r = await page(url(alt));
      if (r.items.length) break;
    }
  }
  return r;
}

// Hilfsdateien, die kein eigenständiges Sprachmodell sind (Bildteil, Wichtungsdaten, Entwurfsmodelle, Adapter …)
const AUX_RE = /(mmproj|dspark|eagle3?[-_]|(^|\/)imatrix|\.imatrix\.gguf$|(^|\/)mtp[-_]|draft|lora|adapter|tokenizer|vocab|refusal|patch-|modelfile|(^|\/)(audio|vision|spk-encoder|accents)\.gguf$|skeleton|ple-fp8)/i;
const SHARD_RE = /-\d{5}-of-\d{5}(?=\.gguf$)/i;
// Stufen-Namen: klassische (Q4_K_M, IQ3_XXS …) und neuere (TQ1_0, NVFP4, FP16, 4bpw …)
const QUANT_RE2 = /(?:^|[^A-Za-z0-9])(UD-)?(IQ\d_[A-Z]+(?:_[A-Z0-9]+)?|TQ\d_\d|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d(?:_\d_\d)?|Q\d_g\d+|Q\d|NVFP4|MXFP4|BF16|FP16|F16|FP32|F32|FP8|\d+(?:\.\d+)?bpw)(?=$|[^A-Za-z0-9])/i;

/** Saubere Bezeichnung für den Download-Namen „repo:STUFE“ (nur A-Z, 0-9, . _ -, max. 40). */
const cleanLabel = (x) => String(x).toUpperCase().replace(/[^A-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'MODELL';

/**
 * Fasst die Dateien eines Repos zu ladbaren Stufen zusammen. Jede Modelldatei (bzw. jede Gruppe geteilter Dateien)
 * wird eine Stufe – auch wenn ihr Name keine klassische Stufe enthält; dann zählt der unterscheidende Namensteil.
 */
function quantsFromFiles(siblings) {
  const mmprojs = [];
  const groups = new Map(); // Schlüssel (ohne Teilnummer) -> { key, list }
  for (const f of siblings || []) {
    const n = String(f.rfilename || '');
    if (!/\.gguf$/i.test(n)) continue;
    const size = f.size || (f.lfs && f.lfs.size) || 0;
    if (/mmproj/i.test(n)) { mmprojs.push({ path: n, size }); continue; }
    if (AUX_RE.test(n)) continue;
    // Geteilte Dateien (…-00001-of-00003.gguf) gehören zusammen; liegen sie in einem eigenen Ordner, ist der Ordner die Stufe
    let key = n.replace(SHARD_RE, '').replace(/\.gguf$/i, '');
    if (SHARD_RE.test(n) && n.includes('/')) key = n.slice(0, n.lastIndexOf('/'));
    const g = groups.get(key) || { key, list: [] };
    g.list.push({ path: n, size });
    groups.set(key, g);
  }
  // Gemeinsamen Anfang der Namen abschneiden, damit „Modell-A“ und „Modell-B“ unterscheidbar bleiben
  const keys = [...groups.keys()].map((k) => k.split('/').pop());
  let pre = keys.length > 1 ? keys[0] : '';
  for (const k of keys) while (pre && !k.startsWith(pre)) pre = pre.slice(0, -1);
  pre = pre.replace(/[A-Za-z0-9]+$/, ''); // nur an Trennzeichen schneiden
  const quants = [];
  const used = new Set();
  for (const g of groups.values()) {
    const base = g.key.split('/').pop();
    const m = g.key.match(QUANT_RE2);
    let name;
    // Wie bisher: „UD-Q5_K_XL“ heißt Q5_K_XL (bereits geladene Modelle behalten ihren Namen); UD- nur bei Doppelung
    if (m) name = cleanLabel(m[2].replace(/^FP16$/i, 'F16').replace(/^FP32$/i, 'F32'));
    else name = cleanLabel(base.slice(pre.length) || base);
    if (used.has(name) && m && m[1]) name = cleanLabel('UD-' + m[2]);
    if (used.has(name)) name = cleanLabel(base);
    let i = 2;
    while (used.has(name)) name = cleanLabel(base).slice(0, 36) + '-' + i++;
    used.add(name);
    const bytes = g.list.reduce((t, f) => t + f.size, 0);
    quants.push({ name, bytes, files: g.list.length, list: g.list.sort((x, y) => x.path.localeCompare(y.path)) });
  }
  // Bildteil: bevorzugt F16, dann BF16, sonst die erste Datei
  const mmproj = mmprojs.find((x) => /f16/i.test(x.path) && !/bf16/i.test(x.path)) || mmprojs.find((x) => /bf16/i.test(x.path)) || mmprojs[0] || null;
  return { quants: quants.filter((x) => x.bytes > 0).sort((a, b) => a.bytes - b.bytes), hasMmproj: mmprojs.length > 0, mmproj };
}

/** Aus einer Download-Adresse von Hugging Face: { id, file } oder null. */
function parseResolve(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)huggingface\.co$|(^|\.)hf\.co$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:resolve|blob)\/[^/]+\/(.+)$/);
    if (!m) return null;
    const id = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
    if (!okId(id)) return null;
    return { id, file: m[3].split('/').map(decodeURIComponent).join('/') };
  } catch { return null; }
}

/** Dateiliste eines Repos (mit Größen). */
async function siblings(id, fetchImpl, token) {
  if (!okId(id)) throw new Error('Ungültiger Modellname');
  const d = await getJson(`${HF}/api/models/${id}?blobs=true`, fetchImpl, 15000, token);
  return d.siblings || [];
}

/** Welche Stufe gehört zu einer Datei (für Downloads direkt von der Webseite)? */
function quantOfFile(siblings, filePath) {
  const { quants } = quantsFromFiles(siblings);
  const q = quants.find((x) => x.list.some((f) => f.path === filePath));
  return q ? q.name : '';
}

/**
 * Hardware für die Passt-es-Prüfung. Auf dem Mac teilen sich CPU und GPU den Arbeitsspeicher:
 * macOS gibt der GPU davon grob zwei Drittel (bei kleinen Macs eher weniger), eine getrennte Karte gibt es nicht.
 */
function hwFor(settings, platform, totalBytes) {
  const st = settings || {};
  if (platform === 'darwin' && totalBytes > 0) {
    const ram = totalBytes / GIB;
    return { vramGb: Math.round(ram * (ram <= 16 ? 0.62 : 0.72) * 10) / 10, ramGb: 0 };
  }
  return { vramGb: st.vramGb, ramGb: st.ramGb };
}

/**
 * Passt ein Modell auf den PC? hw = { vramGb, ramGb }.
 * Grob: Modellgröße plus etwa 1,5 GB für Kontext. gpu = alles auf der Grafikkarte (schnell);
 * teils = zusätzlich Arbeitsspeicher nötig (deutlich langsamer); nein = zu groß.
 */
function fitFor(bytes, hw) {
  const vram = Number(hw && hw.vramGb) || 16;
  const ram = hw && hw.ramGb === 0 ? 0 : Number(hw && hw.ramGb) || 32;
  const need = bytes / GIB + 1.5;
  if (need <= vram) return { fit: 'gpu', text: 'Passt auf Deine Karte' };
  if (need <= vram + ram * 0.6) return { fit: 'teils', text: 'Teils auf der Karte, langsamer' };
  return { fit: 'nein', text: 'Zu groß für diesen PC' };
}

/** Empfehlung: größte brauchbare Stufe, die noch ganz auf die Karte passt (bevorzugt Q4/Q5/Q6/Q8), sonst die kleinste Q4. */
function recommend(quants, hw) {
  const usable = quants.filter((q) => /^(UD-)?(IQ4|Q4|Q5|Q6|Q8|MXFP4)/.test(q.name));
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
  const ggufCount = (d.siblings || []).filter((f) => /\.gguf$/i.test(f.rfilename || '')).length;
  const tags = (d.tags || []).map((t) => String(t).toLowerCase());
  const format = ggufCount ? 'GGUF' : tags.includes('mlx') ? 'MLX (nur Apple-Programme)' : tags.includes('safetensors') ? 'Safetensors' : tags.includes('onnx') ? 'ONNX' : '';
  // Kein GGUF: passende GGUF-Fassungen desselben Modells suchen (gleicher Anbieter zuerst)
  let alternatives = [];
  if (!ggufCount) { try { alternatives = await ggufAlternatives(d.id || id, fetchImpl); } catch { /* optional */ } }
  return {
    id: d.id || id,
    ggufCount,
    format,
    alternatives,
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

/** Grundname ohne Format-Zusätze: „Ternary-Bonsai-27B-mlx-2bit“ -> „Ternary-Bonsai-27B“. */
function baseName(id) {
  const name = String(id).split('/').pop();
  return name.replace(/[-_.](mlx|unpacked|awq|gptq|exl2|exl3|fp8|bnb|onnx|hqq|int4|int8|4bit|8bit|2bit|1bit|w4a16|safetensors|hf)(?=$|[-_.]).*$/i, '');
}

async function ggufAlternatives(id, fetchImpl) {
  const base = baseName(id);
  if (!base || base.length < 3) return [];
  const author = String(id).split('/')[0].toLowerCase();
  const { items } = await search(base, { sort: 'downloads', limit: 20 }, fetchImpl || fetch);
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = norm(base);
  const ids = items.map((m) => m.id).filter((x) => norm(x.split('/').pop()).includes(b));
  ids.sort((x, y) => (y.split('/')[0].toLowerCase() === author) - (x.split('/')[0].toLowerCase() === author));
  return ids.slice(0, 4);
}

/**
 * Erkennt in der Sucheingabe ein bestimmtes Modell: einen Hugging-Face-Link
 * (https://huggingface.co/autor/name, auch mit /tree/main, /blob/…, ?…) oder „autor/name“ (optional „:STUFE“).
 * Gibt die Repo-ID zurück oder ''.
 */
function repoFromInput(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t)) return '';
  const link = t.match(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/(?!(?:models|datasets|spaces|docs|api)(?:[/?#]|$))([^/?#\s]+)\/([^/?#:\s]+)/i);
  const id = link ? `${link[1]}/${link[2]}` : (t.match(/^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?::[A-Za-z0-9._-]+)?$/) || [])[1] || '';
  return okId(id) ? id : '';
}

/** Prüft ein Hugging-Face-Token und gibt den Kontonamen zurück. */
async function whoami(token, fetchImpl = fetch) {
  const res = await fetchImpl(`${HF}/api/whoami-v2`, { headers: { 'User-Agent': 'FA-KI-Desktop', ...authHeaders(token) }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401) throw new Error('Hugging Face kennt dieses Token nicht.');
  if (!res.ok) throw new Error(`Hugging Face: Fehler ${res.status}`);
  const d = await res.json();
  return String((d && d.name) || '');
}

/** Zerlegt „besitzer/repo:QUANT“ (so heißen heruntergeladene Modelle). Gibt null zurück, wenn der Name nicht sicher aussieht. */
function parsePull(name) {
  const m = String(name || '').trim().match(/^([A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}):([A-Za-z0-9._-]{1,40})$/);
  if (!m || !okId(m[1])) return null;
  return { id: m[1], quant: m[2].toUpperCase() };
}

/** Plan für den Download: welche Dateien gehören zu einer Quantisierung (plus Bildteil). */
async function plan(id, quant, fetchImpl, token) {
  if (!okId(id)) throw new Error('Ungültiger Modellname');
  const d = await getJson(`${HF}/api/models/${id}?blobs=true`, fetchImpl, 15000, token);
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

module.exports = { baseName, search, details, plan, quantOfFile, siblings, parseResolve, nextLink, repoFromInput, authHeaders, whoami, quantsFromFiles, fitFor, hwFor, recommend, featuresOf, parsePull, okId, HF };
