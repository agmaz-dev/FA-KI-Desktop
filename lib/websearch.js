'use strict';
// Websuche und Seitenabruf ohne API-Schlüssel und ohne Konto.
// Die Suche fragt öffentliche Suchseiten direkt ab (DuckDuckGo, danach Bing als Ersatz).
// Seiten werden selbst geladen und als reiner Text zurückgegeben.
// Alle Anfragen gehen nur im Hauptprozess raus; private und lokale Adressen werden blockiert.

const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;

// ---------- Hilfen ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', middot: '·' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
  });
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Macht aus HTML lesbaren Text (ohne Skripte, Menüs, Fußzeilen). */
function htmlToText(html) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|blockquote)>/gi, '\n');
  h = h.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);
  const lines = h.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter((l) => l);
  // sehr kurze Menüzeilen hintereinander (Navigation) wegwerfen, wenn es genug anderen Text gibt
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return { title: title ? stripTags(title) : '', text };
}

// ---------- Sicherheit: keine lokalen/privaten Ziele ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true;
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true;
}

/** Wirft einen Fehler, wenn die Adresse nicht öffentlich im Internet liegt. */
async function assertPublicUrl(raw, lookup = dns.lookup) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Ungültige Adresse'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur http und https sind erlaubt');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !net.isIP(host)) {
    throw new Error('Lokale Adressen sind gesperrt');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private Adressen sind gesperrt');
    return u;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private Adressen sind gesperrt');
  return u;
}

// ---------- Laden ----------

async function readLimited(res, max = MAX_BYTES) {
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      parts.push(Buffer.from(value));
      if (n >= max) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).subarray(0, max);
}

function decodeBody(buf, contentType) {
  let cs = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  try { return new TextDecoder((cs || 'utf-8').toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
}

/** GET mit Weiterleitungen; jedes Ziel wird erneut auf öffentliche Adresse geprüft. */
async function httpGet(url, { timeoutMs = 15000, headers = {}, fetchImpl = fetch, lookup } = {}) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(cur, lookup);
    const res = await fetchImpl(cur, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7', Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.5', ...headers },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location'), cur).href;
      continue;
    }
    const buf = await readLimited(res);
    return { status: res.status, url: cur, contentType: res.headers.get('content-type') || '', text: decodeBody(buf, res.headers.get('content-type')) };
  }
  throw new Error('Zu viele Weiterleitungen');
}

/** Lädt eine Seite und gibt Titel und Text zurück (auf maxChars gekürzt). */
async function fetchPage(url, { maxChars = 7000, ...opts } = {}) {
  const r = await httpGet(url, opts);
  if (r.status >= 400) throw new Error(`Seite antwortet mit Fehler ${r.status}`);
  const ct = r.contentType.toLowerCase();
  if (ct && !/text\/|json|xml/.test(ct)) throw new Error('Kein Text (' + ct.split(';')[0] + ')');
  let title = '';
  let text;
  if (/html|xml/.test(ct) || /^\s*<(!doctype|html)/i.test(r.text)) ({ title, text } = htmlToText(r.text));
  else text = r.text.trim();
  const cut = text.length > maxChars;
  return { url: r.url, title, text: cut ? text.slice(0, maxChars) + '\n[… gekürzt]' : text, truncated: cut };
}

// ---------- Suche ----------

function unwrapDdg(href) {
  let h = decodeEntities(href);
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    const t = u.searchParams.get('uddg');
    if (t) return t;
    return u.href;
  } catch { return h; }
}

function parseDdgHtml(html) {
  const out = [];
  const re = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = unwrapDdg(m[1]);
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js|ad_provider/.test(url)) continue;
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 3000);
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(rest);
    out.push({ title: stripTags(m[2]), url, snippet: sn ? stripTags(sn[1]) : '' });
  }
  return out;
}

function parseDdgLite(html) {
  const out = [];
  const re = /<a\b[^>]*class=['"]result-link['"][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = unwrapDdg(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 2500);
    const sn = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(rest);
    out.push({ title: stripTags(m[2]), url, snippet: sn ? stripTags(sn[1]) : '' });
  }
  return out;
}

function unwrapBing(href) {
  const h = decodeEntities(href);
  try {
    const u = new URL(h);
    const p = u.searchParams.get('u');
    if (u.hostname.endsWith('bing.com') && p && /^a1/.test(p)) {
      const b = p.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const dec = Buffer.from(b, 'base64').toString('utf8');
      if (/^https?:\/\//.test(dec)) return dec;
    }
  } catch { /* roh */ }
  return h;
}

function parseBing(html) {
  const out = [];
  const re = /<li\b[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = /<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(m[1]);
    if (!a) continue;
    const url = unwrapBing(a[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const sn = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(m[1]) || /class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(m[1]);
    out.push({ title: stripTags(a[2]), url, snippet: sn ? stripTags(sn[1]) : '' });
  }
  return out;
}

const ENGINES = [
  { name: 'DuckDuckGo', url: (q) => 'https://html.duckduckgo.com/html/?kl=de-de&q=' + encodeURIComponent(q), parse: parseDdgHtml },
  { name: 'DuckDuckGo Lite', url: (q) => 'https://lite.duckduckgo.com/lite/?kl=de-de&q=' + encodeURIComponent(q), parse: parseDdgLite },
  { name: 'Bing', url: (q) => 'https://www.bing.com/search?setlang=de&cc=DE&q=' + encodeURIComponent(q), parse: parseBing },
];

/** Sucht im Web. Probiert mehrere Suchseiten nacheinander, falls eine blockt oder nichts liefert. */
async function search(query, { max = 8, engines = ENGINES, ...opts } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Leerer Suchbegriff');
  const errors = [];
  for (const e of engines) {
    try {
      const r = await httpGet(e.url(q), { timeoutMs: 12000, ...opts });
      if (r.status >= 400) { errors.push(`${e.name}: Fehler ${r.status}`); continue; }
      const seen = new Set();
      const items = e.parse(r.text).filter((x) => x.title && !seen.has(x.url) && seen.add(x.url)).slice(0, max);
      if (items.length) return { engine: e.name, results: items };
      errors.push(`${e.name}: keine Treffer lesbar (evtl. Sperre)`);
    } catch (err) {
      errors.push(`${e.name}: ${err.message}`);
    }
  }
  throw new Error('Keine Suchseite hat geantwortet. ' + errors.join('; '));
}

// ---------- Shop-Links (nur Links bauen, nichts abrufen) ----------

function shopLinks(query, shops) {
  const q = encodeURIComponent(String(query || '').trim());
  const all = {
    ebay: ['eBay', `https://www.ebay.de/sch/i.html?_nkw=${q}`],
    kleinanzeigen: ['Kleinanzeigen', `https://www.kleinanzeigen.de/s-suchanfrage.html?keywords=${q}`],
    amazon: ['Amazon', `https://www.amazon.de/s?k=${q}`],
    idealo: ['idealo (Preisvergleich)', `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${q}`],
    google: ['Google Shopping', `https://www.google.de/search?tbm=shop&q=${q}`],
  };
  const keys = shops && shops.length ? shops.filter((s) => all[s]) : ['ebay', 'kleinanzeigen', 'amazon', 'idealo'];
  return (keys.length ? keys : ['ebay', 'kleinanzeigen']).map((k) => ({ shop: all[k][0], url: all[k][1] }));
}

module.exports = { htmlToText, decodeEntities, stripTags, isPrivateIp, assertPublicUrl, httpGet, fetchPage, search, shopLinks, parseDdgHtml, parseDdgLite, parseBing, unwrapDdg };
