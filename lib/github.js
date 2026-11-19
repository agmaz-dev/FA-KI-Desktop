'use strict';
// GitHub nur LESEN. Es gibt keine Funktion, die etwas schreibt, ändert oder löscht;
// erlaubt sind ausschließlich GET-Anfragen an api.github.com.
// Der Token bleibt im Hauptprozess und wird nie an die Oberfläche oder das Modell gegeben.

const API = 'https://api.github.com';

function headers(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'FA-KI-Desktop' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

async function ghGet(pathAndQuery, token, fetchImpl = fetch) {
  if (!pathAndQuery.startsWith('/')) throw new Error('Ungültiger Pfad');
  const res = await fetchImpl(API + pathAndQuery, { method: 'GET', headers: headers(token), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  if (!res.ok) {
    let msg = (data && data.message) || res.statusText || 'Fehler';
    if (res.status === 401) msg = 'Token ungültig oder abgelaufen';
    else if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub-Zugriffsgrenze erreicht, später erneut versuchen';
    else if (res.status === 404) msg = 'Nicht gefunden (oder keine Berechtigung für dieses private Repo)';
    throw new Error(`GitHub: ${msg} (${res.status})`);
  }
  return data;
}

const seg = (s) => encodeURIComponent(String(s || '').trim());
const okName = (s) => /^[A-Za-z0-9._-]{1,100}$/.test(String(s || ''));

/** Prüft den Token und gibt den Anmeldenamen zurück. */
async function whoami(token, fetchImpl) {
  const d = await ghGet('/user', token, fetchImpl);
  return d && d.login;
}

async function listRepos(token, { max = 30 } = {}, fetchImpl) {
  if (!token) throw new Error('Für die Liste Deiner Repos fehlt der GitHub-Token (Einstellungen → KI und Modell)');
  const d = await ghGet(`/user/repos?per_page=${Math.min(100, max)}&sort=pushed&affiliation=owner,collaborator`, token, fetchImpl);
  return (d || []).map((r) => ({ name: r.full_name, privat: !!r.private, beschreibung: r.description || '', aktualisiert: r.pushed_at }));
}

/** Liest eine Datei (Text) oder listet einen Ordner. */
async function readPath(token, { owner, repo, path = '', ref = '', maxChars = 8000 }, fetchImpl) {
  if (!okName(owner) || !okName(repo)) throw new Error('Ungültiger Besitzer oder Repo-Name');
  const p = String(path || '').replace(/^\/+/, '').split('/').filter(Boolean).map(seg).join('/');
  const q = ref ? `?ref=${seg(ref)}` : '';
  const d = await ghGet(`/repos/${seg(owner)}/${seg(repo)}/contents/${p}${q}`, token, fetchImpl);
  if (Array.isArray(d)) {
    return { art: 'ordner', pfad: path || '/', eintraege: d.map((x) => ({ name: x.name, typ: x.type, groesse: x.size })) };
  }
  if (d.type !== 'file') return { art: d.type, pfad: d.path };
  if (d.size > 1024 * 1024) return { art: 'datei', pfad: d.path, hinweis: 'Datei größer als 1 MB, wird nicht gelesen' };
  const buf = Buffer.from(d.content || '', 'base64');
  if (buf.subarray(0, 8000).includes(0)) return { art: 'datei', pfad: d.path, hinweis: 'Binärdatei, kein Text' };
  const text = buf.toString('utf8');
  const cut = text.length > maxChars;
  return { art: 'datei', pfad: d.path, text: cut ? text.slice(0, maxChars) + '\n[… gekürzt, mit weiteren Aufrufen und Teilpfaden gezielt nachlesen]' : text, gekuerzt: cut };
}

async function searchCode(token, { query, owner, repo }, fetchImpl) {
  if (!token) throw new Error('Die Code-Suche braucht den GitHub-Token (Einstellungen → KI und Modell)');
  let q = String(query || '').trim();
  if (!q) throw new Error('Leerer Suchbegriff');
  if (owner && repo && okName(owner) && okName(repo)) q += ` repo:${owner}/${repo}`;
  else if (owner && okName(owner)) q += ` user:${owner}`;
  const d = await ghGet(`/search/code?per_page=10&q=${encodeURIComponent(q)}`, token, fetchImpl);
  return ((d && d.items) || []).map((i) => ({ repo: i.repository && i.repository.full_name, pfad: i.path }));
}

async function searchRepos(token, { query }, fetchImpl) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Leerer Suchbegriff');
  const d = await ghGet(`/search/repositories?per_page=8&q=${encodeURIComponent(q)}`, token, fetchImpl);
  return ((d && d.items) || []).map((r) => ({ name: r.full_name, beschreibung: r.description || '', sterne: r.stargazers_count, url: r.html_url }));
}

module.exports = { whoami, listRepos, readPath, searchCode, searchRepos, ghGet };
