'use strict';
// GitHub-Zugriff. Lesen: beliebige GET-Anfragen an api.github.com.
// Schreiben: nur über die unten ausdrücklich freigegebenen Funktionen (neues Repo, Datei, Branch,
// Pull Request, Zusammenführen, Issue) – es gibt kein DELETE und keine Änderung von Repo-Einstellungen.
// Der Token bleibt im Hauptprozess und wird nie an die Oberfläche oder das Modell gegeben.
// Jeder schreibende Aufruf wird vorher dem Nutzer zur Bestätigung gezeigt (lib/agent.js).

const API = 'https://api.github.com';

function headers(token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'FA-KI-Desktop' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

function explain(res, data) {
  let msg = (data && data.message) || res.statusText || 'Fehler';
  if (res.status === 401) msg = 'Token ungültig oder abgelaufen';
  else if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub-Zugriffsgrenze erreicht, später erneut versuchen';
  else if (res.status === 403) msg = 'Keine Berechtigung – der Token braucht Schreibrechte (klassisch: „repo“; fein: Contents und Pull requests „Read and write“). ' + msg;
  else if (res.status === 404) msg = 'Nicht gefunden (oder keine Berechtigung für dieses private Repo)';
  else if (res.status === 422 && data && Array.isArray(data.errors) && data.errors.length) msg += ': ' + data.errors.map((e) => e.message || e.code || JSON.stringify(e)).join('; ');
  return `GitHub: ${msg} (${res.status})`;
}

async function call(method, pathAndQuery, token, body, fetchImpl = fetch) {
  if (!pathAndQuery.startsWith('/')) throw new Error('Ungültiger Pfad');
  const init = { method, headers: headers(token), signal: AbortSignal.timeout(20000) };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetchImpl(API + pathAndQuery, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  if (!res.ok) throw new Error(explain(res, data));
  return data;
}

const ghGet = (p, token, fetchImpl) => call('GET', p, token, undefined, fetchImpl);

// Erlaubte Schreib-Pfade (Whitelist). Alles andere wird abgelehnt.
const WRITE_ALLOWED = [
  ['POST', /^\/user\/repos$/],
  ['PUT', /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/contents\/.+$/],
  ['POST', /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/git\/refs$/],
  ['POST', /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pulls$/],
  ['PUT', /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pulls\/\d+\/merge$/],
  ['POST', /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues$/],
];
async function ghWrite(method, pathAndQuery, token, body, fetchImpl) {
  if (!token) throw new Error('Zum Schreiben auf GitHub fehlt der Token (Einstellungen → Internet und GitHub)');
  if (!WRITE_ALLOWED.some(([m, re]) => m === method && re.test(pathAndQuery.split('?')[0]))) throw new Error('Diese GitHub-Aktion ist nicht erlaubt');
  return call(method, pathAndQuery, token, body, fetchImpl);
}

const seg = (s) => encodeURIComponent(String(s || '').trim());
const okName = (s) => /^[A-Za-z0-9._-]{1,100}$/.test(String(s || ''));
function need(owner, repo) {
  if (!okName(owner) || !okName(repo)) throw new Error('Ungültiger Besitzer oder Repo-Name');
}
const filePath = (path) => String(path || '').replace(/^\/+/, '').split('/').filter(Boolean).map(seg).join('/');

/** Prüft den Token und gibt den Anmeldenamen zurück. */
async function whoami(token, fetchImpl) {
  const d = await ghGet('/user', token, fetchImpl);
  return d && d.login;
}

async function listRepos(token, { max = 30 } = {}, fetchImpl) {
  if (!token) throw new Error('Für die Liste Deiner Repos fehlt der GitHub-Token (Einstellungen → Internet und GitHub)');
  const d = await ghGet(`/user/repos?per_page=${Math.min(100, max)}&sort=pushed&affiliation=owner,collaborator`, token, fetchImpl);
  return (d || []).map((r) => ({ name: r.full_name, privat: !!r.private, beschreibung: r.description || '', aktualisiert: r.pushed_at, standardBranch: r.default_branch }));
}

/** Liest eine Datei (Text) oder listet einen Ordner. */
async function readPath(token, { owner, repo, path = '', ref = '', maxChars = 8000 }, fetchImpl) {
  need(owner, repo);
  const p = filePath(path);
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
  if (!token) throw new Error('Die Code-Suche braucht den GitHub-Token (Einstellungen → Internet und GitHub)');
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

async function listPulls(token, { owner, repo, state = 'open' }, fetchImpl) {
  need(owner, repo);
  const st = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  const d = await ghGet(`/repos/${seg(owner)}/${seg(repo)}/pulls?state=${st}&per_page=20`, token, fetchImpl);
  return (d || []).map((p) => ({ nummer: p.number, titel: p.title, von: p.head && p.head.ref, nach: p.base && p.base.ref, status: p.merged_at ? 'zusammengeführt' : p.state, url: p.html_url }));
}

async function listRuns(token, { owner, repo, branch = '' }, fetchImpl) {
  need(owner, repo);
  const q = branch ? `&branch=${seg(branch)}` : '';
  const d = await ghGet(`/repos/${seg(owner)}/${seg(repo)}/actions/runs?per_page=8${q}`, token, fetchImpl);
  return ((d && d.workflow_runs) || []).map((r) => ({ id: r.id, name: r.name, branch: r.head_branch, status: r.status, ergebnis: r.conclusion, url: r.html_url }));
}

// ---------- Schreiben (nur nach Bestätigung des Nutzers aufrufen) ----------
async function createRepo(token, { name, description = '', privat = true }, fetchImpl) {
  if (!okName(name)) throw new Error('Ungültiger Repo-Name (erlaubt: Buchstaben, Ziffern, Punkt, Strich, Unterstrich)');
  const d = await ghWrite('POST', '/user/repos', token, { name, description: String(description || ''), private: privat !== false, auto_init: false }, fetchImpl);
  return { name: d.full_name, privat: !!d.private, url: d.html_url, cloneUrl: d.clone_url, standardBranch: d.default_branch };
}

async function putFile(token, { owner, repo, path, content, message, branch = '' }, fetchImpl) {
  need(owner, repo);
  const p = filePath(path);
  if (!p) throw new Error('Pfad fehlt');
  const refQ = branch ? `?ref=${seg(branch)}` : '';
  let sha;
  try {
    const cur = await ghGet(`/repos/${seg(owner)}/${seg(repo)}/contents/${p}${refQ}`, token, fetchImpl);
    if (cur && !Array.isArray(cur) && cur.sha) sha = cur.sha;
  } catch (e) { if (!/\(404\)/.test(String(e.message))) throw e; }
  const body = { message: String(message || 'Änderung über FA KI Desktop'), content: Buffer.from(String(content ?? ''), 'utf8').toString('base64') };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;
  const d = await ghWrite('PUT', `/repos/${seg(owner)}/${seg(repo)}/contents/${p}`, token, body, fetchImpl);
  return { pfad: d.content && d.content.path, commit: d.commit && d.commit.sha, url: d.commit && d.commit.html_url, neu: !sha };
}

async function createBranch(token, { owner, repo, name, from = '' }, fetchImpl) {
  need(owner, repo);
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(String(name || ''))) throw new Error('Ungültiger Branch-Name');
  let base = from;
  if (!base) {
    const r = await ghGet(`/repos/${seg(owner)}/${seg(repo)}`, token, fetchImpl);
    base = r.default_branch;
  }
  const ref = await ghGet(`/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${base.split('/').map(seg).join('/')}`, token, fetchImpl);
  const d = await ghWrite('POST', `/repos/${seg(owner)}/${seg(repo)}/git/refs`, token, { ref: 'refs/heads/' + name, sha: ref.object.sha }, fetchImpl);
  return { branch: name, von: base, sha: d.object && d.object.sha };
}

async function createPull(token, { owner, repo, title, head, base, body = '', draft = false }, fetchImpl) {
  need(owner, repo);
  if (!title || !head || !base) throw new Error('Titel, head und base sind nötig');
  const d = await ghWrite('POST', `/repos/${seg(owner)}/${seg(repo)}/pulls`, token, { title, head, base, body, draft: !!draft }, fetchImpl);
  return { nummer: d.number, url: d.html_url };
}

async function mergePull(token, { owner, repo, number, method = 'squash' }, fetchImpl) {
  need(owner, repo);
  const n = parseInt(number, 10);
  if (!(n > 0)) throw new Error('Ungültige PR-Nummer');
  const m = ['merge', 'squash', 'rebase'].includes(method) ? method : 'squash';
  const d = await ghWrite('PUT', `/repos/${seg(owner)}/${seg(repo)}/pulls/${n}/merge`, token, { merge_method: m }, fetchImpl);
  return { zusammengefuehrt: !!(d && d.merged), meldung: d && d.message };
}

async function createIssue(token, { owner, repo, title, body = '' }, fetchImpl) {
  need(owner, repo);
  if (!title) throw new Error('Titel fehlt');
  const d = await ghWrite('POST', `/repos/${seg(owner)}/${seg(repo)}/issues`, token, { title, body }, fetchImpl);
  return { nummer: d.number, url: d.html_url };
}

module.exports = {
  whoami, listRepos, readPath, searchCode, searchRepos, listPulls, listRuns, ghGet, ghWrite, WRITE_ALLOWED,
  createRepo, putFile, createBranch, createPull, mergePull, createIssue,
};
