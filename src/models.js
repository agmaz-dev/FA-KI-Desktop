// „Erkunden“ (Modelle suchen und laden) und „Bibliothek“ (installierte Modelle)
// Beide Seiten liegen in den Einstellungen unter „Lokale Modelle“ (wie bei Bionic).
import { el, icon } from './ui.js';
import { formatBytes } from '../lib/util.js';
import { repoFromInput } from '../lib/hf.js';

const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' Mio.' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.', ',') + ' Tsd.' : String(n || 0));
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const FIT_CLASS = { gpu: 'ok', teils: 'warn', nein: 'bad' };

function ago(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const d = Math.max(0, Math.round((Date.now() - t) / 86400000));
  if (d < 1) return 'heute';
  if (d === 1) return 'vor 1 Tag';
  if (d < 60) return `vor ${d} Tagen`;
  const m = Math.round(d / 30);
  return m < 24 ? `vor ${m} Monaten` : `vor ${Math.round(d / 365)} Jahren`;
}

const AV_COLORS = ['#7c5cd6', '#2f8f83', '#c0563f', '#3b82c4', '#b8873a', '#b34f8a', '#5a8f3a'];
function avatarColor(name) { let h = 0; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AV_COLORS[h % AV_COLORS.length]; }

function searchBox(placeholder, onInput) {
  const box = el('div', 'search-box');
  const ic = el('span', 'sb-icon'); ic.innerHTML = icon('search', 16);
  const inp = el('input'); inp.type = 'text'; inp.placeholder = placeholder;
  const clr = el('button', 'sb-clear'); clr.type = 'button'; clr.innerHTML = icon('x', 14); clr.title = 'Leeren'; clr.classList.add('hidden');
  clr.onclick = () => { inp.value = ''; clr.classList.add('hidden'); inp.focus(); onInput(true); };
  inp.addEventListener('input', () => { clr.classList.toggle('hidden', !inp.value); onInput(false); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') onInput(true); });
  box.append(ic, inp, clr);
  return { box, inp };
}

/**
 * ctx: { api, models() -> Liste, refreshModels(), useModel(name), renderMd(text), hint(text), goTab(id) }
 */
export function mountExplore(root, ctx) {
  root.innerHTML = '';
  const api = ctx.api;
  const page = el('div', 'explore');
  const HKEY = 'fa-explore-history';
  const loadHist = () => { try { const v = JSON.parse(localStorage.getItem(HKEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 15) : []; } catch { return []; } };
  const saveHist = (arr) => { try { localStorage.setItem(HKEY, JSON.stringify(arr.slice(0, 15))); } catch { /* egal */ } };
  const { box: sbox, inp: q } = searchBox('Suchen (z. B. qwen, gemma) oder Link/„autor/name“ einfügen', (now) => { if (now) { hideHist(); doSearch(); } else showHist(); });
  const sWrap = el('div', 'search-wrap');
  const histBox = el('div', 'history hidden');
  sWrap.append(sbox, histBox);
  page.appendChild(sWrap);
  function hideHist() { histBox.classList.add('hidden'); }
  function showHist() {
    const f = q.value.trim().toLowerCase();
    const items = loadHist().filter((h) => !f || (h.toLowerCase().includes(f) && h.toLowerCase() !== f));
    histBox.innerHTML = '';
    if (!items.length) return hideHist();
    const head = el('div', 'hist-head');
    head.appendChild(el('span', 'note', 'Letzte Suchen'));
    const clr = el('button', 'link-btn', 'Verlauf löschen');
    clr.onmousedown = (e) => { e.preventDefault(); saveHist([]); hideHist(); };
    head.appendChild(clr);
    histBox.appendChild(head);
    for (const h of items) {
      const b = el('button', 'hist-item', h);
      b.onmousedown = (e) => { e.preventDefault(); q.value = h; hideHist(); doSearch(); };
      histBox.appendChild(b);
    }
    histBox.classList.remove('hidden');
  }
  q.addEventListener('focus', showHist);
  q.addEventListener('blur', () => setTimeout(hideHist, 120));

  const info = el('div', 'result-bar');
  const count = el('span', 'note', '');
  const refresh = el('button', 'icon-btn small'); refresh.innerHTML = icon('refresh2', 14); refresh.title = 'Neu suchen'; refresh.onclick = () => doSearch();
  const sort = document.createElement('select'); sort.className = 'mini';
  for (const [v, t] of [['downloads', 'Meiste Downloads'], ['likes', 'Meiste Likes'], ['trendingScore', 'Im Trend'], ['lastModified', 'Zuletzt aktualisiert'], ['createdAt', 'Neueste']]) { const o = el('option', null, t); o.value = v; sort.appendChild(o); }
  const left0 = el('div', 'rb-left'); left0.append(count, refresh);
  info.append(left0, sort);

  const cols = el('div', 'cols');
  const left = el('div', 'col-list');
  const right = el('div', 'col-detail');
  const listWrap = el('div', 'list-wrap'); listWrap.append(info, left);
  // Ziehbare Trennlinie: Breite der Liste wird gemerkt
  let lw = 340;
  try { lw = Math.min(720, Math.max(220, parseInt(localStorage.getItem('fa.exploreListW'), 10) || 340)); } catch { /* egal */ }
  cols.style.gridTemplateColumns = `${lw}px 8px minmax(0, 1fr)`;
  const split = el('div', 'splitter');
  split.title = 'Ziehen, um die Breite zu ändern (Doppelklick: zurücksetzen)';
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault(); split.setPointerCapture(e.pointerId); split.classList.add('drag');
    const x0 = e.clientX, w0 = lw;
    const mv = (ev) => { lw = Math.min(Math.max(220, w0 + ev.clientX - x0), Math.max(260, cols.clientWidth - 320)); cols.style.gridTemplateColumns = `${lw}px 8px minmax(0, 1fr)`; };
    const up = () => { split.classList.remove('drag'); split.removeEventListener('pointermove', mv); split.removeEventListener('pointerup', up); try { localStorage.setItem('fa.exploreListW', String(Math.round(lw))); } catch { /* egal */ } };
    split.addEventListener('pointermove', mv); split.addEventListener('pointerup', up);
  });
  split.addEventListener('dblclick', () => { lw = 340; cols.style.gridTemplateColumns = `${lw}px 8px minmax(0, 1fr)`; try { localStorage.removeItem('fa.exploreListW'); } catch { /* egal */ } });
  cols.append(listWrap, split, right);
  page.appendChild(cols);
  root.appendChild(page);

  let selected = '';
  const installedNames = () => new Set((ctx.models() || []).map((m) => m.name.toLowerCase()));

  function showEmpty() {
    right.innerHTML = '';
    const e = el('div', 'detail-empty');
    e.appendChild(el('div', null, 'Wähle links ein Modell, um Größen, Stufen und Beschreibung zu sehen.'));
    const direct = el('div', 'direct');
    direct.appendChild(el('div', 'note', 'Oder direkt von Hugging Face laden (besitzer/repo:STUFE):'));
    const inl = el('div', 'inline');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'unsloth/gpt-oss-20b-GGUF:Q4_K_M';
    const b = el('button', 'btn', 'Laden');
    const st = el('div', 'note');
    b.onclick = () => { if (inp.value.trim()) { download(inp.value.trim()); st.textContent = 'Download eingereiht – Stand siehst Du links unten und in der Bibliothek.'; } };
    inl.append(inp, b);
    direct.append(inl, st);
    e.appendChild(direct);
    right.appendChild(e);
  }

  function download(name) {
    if (/cloud/i.test(name) && !confirm('Cloud-Modelle laufen NICHT lokal und senden Daten an fremde Server. Trotzdem laden?')) return;
    ctx.startPull(name);
  }
  // Download-Stand in der Detailansicht: eine Zeile je laufendem/wartendem Download dieses Repos
  const drawDetailDl = () => {
    const box = right.querySelector('.dl-status');
    if (!box) return;
    box.innerHTML = '';
    for (const d of ctx.dls.values()) {
      if (!selected || !d.name.toLowerCase().startsWith(selected.toLowerCase() + ':')) continue;
      box.appendChild(ctx.dlRow(d));
    }
  };
  const offDl = ctx.dlOn(drawDetailDl);

  async function openDetail(id, keepScroll) {
    selected = id;
    left.querySelectorAll('.model-card').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
    const prev = right.scrollTop;
    right.innerHTML = '';
    right.appendChild(el('div', 'note', 'Lade Details …'));
    let d;
    try { d = await api.hf.details(id); } catch (e) {
      right.innerHTML = '';
      const msg = cleanErr(e);
      right.appendChild(el('div', 'err', /\(404\)|\(401\)/.test(msg) ? `Das Modell „${id}“ gibt es auf Hugging Face nicht (oder es ist privat).` : 'Details nicht ladbar: ' + msg));
      return;
    }
    if (selected !== id) return;
    right.innerHTML = '';
    const [author, name] = d.id.split('/');
    right.appendChild(el('h2', null, name));
    right.appendChild(el('div', 'repo-id', d.id));
    const stats = el('div', 'stats-row');
    const chip = (k, v) => { const c = el('div', 'stat-chip'); c.append(el('small', null, k), el('span', null, v)); stats.appendChild(c); };
    chip('Downloads', d.downloads.toLocaleString('de-DE'));
    chip('Likes', d.likes.toLocaleString('de-DE'));
    if (d.updated) chip('Aktualisiert', ago(d.updated));
    const web = el('a', 'web-link', 'Im Web öffnen ↗'); web.href = 'https://huggingface.co/' + d.id; web.target = '_blank'; web.rel = 'noreferrer';
    stats.appendChild(web);
    right.appendChild(stats);

    right.appendChild(el('h3', null, 'Download-Optionen'));
    if (!d.quants.length) {
      right.appendChild(el('div', 'err', 'In diesem Repo liegen keine direkt ladbaren GGUF-Dateien.'));
    } else {
      const have = installedNames();
      const tbl = el('div', 'quant-table');
      const status = el('div', 'dl-status');
      for (const qn of d.quants) {
        const row = el('div', 'quant-row' + (qn.empfohlen ? ' rec' : ''));
        const nm = el('div', 'q-name'); nm.textContent = qn.name;
        if (qn.empfohlen) nm.appendChild(el('span', 'badge ok', 'Empfohlen'));
        const sz = el('div', 'q-size', formatBytes(qn.bytes));
        const fit = el('div', 'q-fit'); fit.appendChild(el('span', 'badge ' + (FIT_CLASS[qn.fit] || ''), qn.text));
        const act = el('div', 'q-act');
        if (have.has(qn.pull.toLowerCase())) act.appendChild(el('span', 'badge ok', 'Installiert'));
        else {
          const b = el('button', 'btn small' + (qn.empfohlen ? ' primary' : ''), 'Laden');
          b.onclick = () => download(qn.pull);
          act.appendChild(b);
        }
        row.append(nm, sz, fit, act);
        tbl.appendChild(row);
      }
      right.appendChild(tbl);
      right.appendChild(status);
      right.appendChild(el('div', 'note', 'Bis zu 3 Downloads laufen gleichzeitig, weitere warten in der Reihe. Alle Downloads siehst Du auch links unten und in der Bibliothek.'));
      drawDetailDl();
    }

    right.appendChild(el('h3', null, 'Details'));
    const kv = el('div', 'kv-grid');
    const add = (k, v) => { if (!v) return; kv.appendChild(el('span', 'k', k)); const vv = el('span', 'v'); if (Array.isArray(v)) v.forEach((x) => vv.appendChild(el('span', 'badge feat', x))); else vv.appendChild(el('span', 'badge', v)); kv.appendChild(vv); };
    add('Parameter', d.parameter);
    add('Architektur', d.architektur);
    add('Formate', 'GGUF');
    add('Kontext', d.kontext ? fmtNum(d.kontext) + ' Tokens' : '');
    add('Funktionen', d.features);
    right.appendChild(kv);
    if (d.features.length) right.appendChild(el('div', 'note', 'Funktionen sind nur aus den Schlagworten des Modells geschätzt und können fehlen oder abweichen. „Passt auf Deine Karte“ rechnet mit den Werten aus Einstellungen → Standardwerte für lokale Modelle.'));

    {
      right.appendChild(el('h3', null, 'README'));
      const tb = el('button', 'btn small', 'Auf Deutsch übersetzen');
      const tst = el('span', 'note', '');
      const bar = el('div', 'inline'); bar.append(tb, tst);
      right.appendChild(bar);
      const md = el('div', 'md readme');
      const showMd = (t) => {
        md.innerHTML = ctx.renderMd(t);
        md.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
        md.querySelectorAll('img').forEach((i) => i.remove());
      };
      let translated = '';
      let showingDe = false;
      if (!d.readme) tb.disabled = true;
      tb.onclick = async () => {
        if (showingDe) { showMd(d.readme); showingDe = false; tb.textContent = 'Auf Deutsch übersetzen'; tst.textContent = ''; return; }
        if (!translated) {
          const model = ctx.currentModel();
          if (!model) { tst.textContent = 'Bitte zuerst ein Modell wählen.'; return; }
          tb.disabled = true; tst.textContent = 'Übersetze mit ' + model + ' … (erste ' + 6000 + ' Zeichen)';
          try { translated = await api.hf.translate({ model, text: d.readme }); }
          catch (e) { tst.textContent = 'Übersetzung fehlgeschlagen: ' + cleanErr(e); tb.disabled = false; return; }
          tb.disabled = false;
        }
        showMd(translated); showingDe = true; tb.textContent = 'Original zeigen'; tst.textContent = 'Maschinell übersetzt, nur die ersten 6000 Zeichen.';
      };
      md.innerHTML = ctx.renderMd(d.readme || '*Für dieses Modell gibt es keine Beschreibung (README).*');
      md.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
      md.querySelectorAll('img').forEach((i) => i.remove());
      right.appendChild(md);
    }
    if (keepScroll) right.scrollTop = prev;
  }

  async function doSearch() {
    left.innerHTML = '';
    const term = q.value.trim();
    if (term) saveHist([term, ...loadHist().filter((h) => h.toLowerCase() !== term.toLowerCase())]);
    // Link oder „autor/name“: direkt dieses Modell öffnen (die Suche zeigt höchstens 60 Treffer, da fehlen manche Repos)
    const direct = repoFromInput(term);
    if (direct) {
      count.textContent = 'Direkt geöffnet';
      left.appendChild(card({ id: direct, likes: 0, downloads: 0, updated: '', features: [] }, true));
      await openDetail(direct);
      return;
    }
    count.textContent = 'Suche …';
    let list = [];
    try { list = await api.hf.search({ query: q.value.trim(), sort: sort.value }); }
    catch (e) { count.textContent = ''; left.appendChild(el('div', 'err', 'Suche nicht möglich: ' + cleanErr(e))); return; }
    count.textContent = `${list.length} Ergebnisse auf Hugging Face`;
    if (!list.length) { left.appendChild(el('div', 'note', 'Nichts gefunden.')); return; }
    for (const m of list) left.appendChild(card(m));
  }

  /** Karte in der Trefferliste. bare = nur Name (direkt geöffnetes Repo, Zahlen stehen rechts). */
  function card(m, bare) {
    {
      const [author, name] = m.id.split('/');
      const c = el('button', 'model-card' + (m.id === selected ? ' active' : ''));
      c.dataset.id = m.id;
      const av = el('div', 'mc-av', (author || '?').charAt(0).toUpperCase());
      av.style.background = avatarColor(author);
      const l = el('div', 'mc-left');
      const nm = el('div', 'mc-name', name); nm.title = m.id;
      const au = el('div', 'mc-author');
      au.appendChild(el('span', null, author));
      const caps = el('span', 'mc-caps');
      for (const f of m.features) { const k = el('span', 'mc-cap', f.charAt(0)); k.title = f; caps.appendChild(k); }
      if (m.features.length) au.appendChild(caps);
      l.append(nm, au);
      const r = el('div', 'mc-right');
      const st = el('div', 'mc-stats');
      st.append(el('span', null, '☆ ' + m.likes.toLocaleString('de-DE')), el('span', null, '⤓ ' + fmtNum(m.downloads)));
      r.append(st, el('div', 'mc-ago', ago(m.updated)));
      c.append(av, l);
      if (!bare) c.appendChild(r);
      c.onclick = () => openDetail(m.id);
      return c;
    }
  }

  sort.onchange = doSearch;
  showEmpty();
  doSearch();
  return () => { offDl(); };
}

export function mountLibrary(root, ctx) {
  root.innerHTML = '';
  const api = ctx.api;
  const page = el('div', 'library');
  page.appendChild(el('h2', null, 'Bibliothek'));

  const dirRow = el('div', 'dir-row');
  const dic = el('span', 'dr-icon'); dic.innerHTML = icon('library', 18);
  const dtxt = el('div', 'grow');
  dtxt.appendChild(el('div', 'lc-name', 'Modellordner'));
  const dpath = el('div', 'note', '…');
  dtxt.appendChild(dpath);
  const dact = el('div'); dact.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  const bOpen = el('button', 'btn small', 'Öffnen'); bOpen.onclick = () => api.models.openDir();
  const bPick = el('button', 'btn small', 'Ändern …');
  bPick.onclick = async () => { await api.models.pickDir(); await showDir(); await ctx.refreshModels(); await load(); };
  const bOll = el('button', 'btn small', 'Aus Ollama übernehmen …');
  dact.append(bOpen, bPick, bOll);
  dirRow.append(dic, dtxt, dact);
  async function showDir() { try { dpath.textContent = (await api.models.status()).dir || ''; } catch { dpath.textContent = ''; } }
  showDir();
  const olBox = el('div', 'note'); olBox.style.margin = '6px 0';
  bOll.onclick = async () => {
    olBox.innerHTML = '';
    let found = [];
    try { found = await api.models.ollamaFound(); } catch { /* egal */ }
    if (!found.length) { olBox.textContent = 'Keine Ollama-Modelle auf diesem PC gefunden.'; return; }
    olBox.appendChild(el('div', null, 'Gefundene Modelle (werden per Verknüpfung übernommen, kein zusätzlicher Platz; manche Ollama-Dateien laufen nicht in der eigenen Engine):'));
    const boxes = [];
    for (const m of found) {
      const l = el('label'); l.style.cssText = 'display:flex;gap:8px;align-items:center;margin:3px 0';
      const c = document.createElement('input'); c.type = 'checkbox'; boxes.push([c, m.name]);
      l.append(c, document.createTextNode(`${m.name} (${(m.size / 1024 ** 3).toFixed(1).replace('.', ',')} GB)`));
      olBox.appendChild(l);
    }
    const go = el('button', 'btn small', 'Übernehmen');
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Übernehme …';
      const n = await api.models.ollamaImport(boxes.filter(([c]) => c.checked).map(([, nm]) => nm));
      olBox.textContent = `${n} Modell(e) übernommen.`; await ctx.refreshModels(); await load();
    };
    olBox.appendChild(go);
  };
  page.appendChild(dirRow);
  page.appendChild(olBox);

  let all = [];
  const { box: sbox, inp: filter } = searchBox('Installierte Modelle filtern', () => draw());
  page.appendChild(sbox);
  const bar = el('div', 'result-bar');
  const count = el('span', 'note', '');
  const sort = document.createElement('select'); sort.className = 'mini';
  for (const [v, t] of [['new', 'Neueste'], ['name', 'Name'], ['size', 'Größe']]) { const o = el('option', null, t); o.value = v; sort.appendChild(o); }
  sort.onchange = () => draw();
  bar.append(count, sort);
  page.appendChild(bar);
  const dlBox = el('div', 'dl-card hidden');
  page.insertBefore(dlBox, sbox);
  const box = el('div', 'lib-list');
  page.appendChild(box);
  root.appendChild(page);

  const doneSeen = new Set();
  function drawDl() {
    dlBox.innerHTML = '';
    dlBox.classList.toggle('hidden', !ctx.dls.size);
    if (!ctx.dls.size) return;
    const head = el('div', 'dl-head');
    head.appendChild(el('div', 'lc-name', 'Downloads'));
    head.appendChild(el('span', 'note', 'bis zu 3 gleichzeitig, weitere warten'));
    dlBox.appendChild(head);
    for (const d of ctx.dls.values()) dlBox.appendChild(ctx.dlRow(d));
  }
  const offDl = ctx.dlOn(() => {
    drawDl();
    let fresh = false;
    for (const d of ctx.dls.values()) if (d.state === 'done' && !doneSeen.has(d.name)) { doneSeen.add(d.name); fresh = true; }
    if (fresh) load();
  });
  drawDl();

  function draw() {
    box.innerHTML = '';
    const f = filter.value.trim().toLowerCase();
    const current = (ctx.currentModel && ctx.currentModel()) || '';
    let list = all.filter((m) => !f || m.name.toLowerCase().includes(f));
    list = list.slice().sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name) : sort.value === 'size' ? (b.size || 0) - (a.size || 0) : String(b.modified).localeCompare(String(a.modified)));
    const total = all.filter((m) => !m.remote).reduce((n, m) => n + (m.size || 0), 0);
    count.textContent = `${list.length} von ${all.length} Modellen werden angezeigt · zusammen ${formatBytes(total)}`;
    if (!all.length) {
      const e = el('div', 'detail-empty');
      e.appendChild(el('div', null, 'Noch keine Modelle installiert.'));
      const b = el('button', 'btn primary', 'Zu „Erkunden“');
      b.onclick = () => ctx.goTab('explore');
      e.appendChild(b);
      box.appendChild(e);
      return;
    }
    if (!list.length) { box.appendChild(el('div', 'note', 'Keine Modelle entsprechen diesem Filter.')); return; }
    for (const m of list) {
      const row = el('div', 'lib-card' + (m.name === current ? ' active' : ''));
      const info = el('div', 'grow');
      const lname = el('div', 'lc-name', m.name.replace(/^hf\.co\//, '')); lname.title = m.name;
      info.appendChild(lname);
      const meta = el('div', 'meta-row');
      meta.appendChild(el('span', 'badge', m.size ? formatBytes(m.size) : 'Cloud'));
      if (m.details.parameter_size) meta.appendChild(el('span', 'badge', m.details.parameter_size));
      if (m.details.quantization_level) meta.appendChild(el('span', 'badge', m.details.quantization_level));
      if (m.details.family) meta.appendChild(el('span', 'badge', m.details.family));
      if (m.remote) meta.appendChild(el('span', 'badge warn', 'Cloud – nicht lokal'));
      if (m.name === current) meta.appendChild(el('span', 'badge ok', 'Aktiv'));
      const caps = el('span', 'caps');
      meta.appendChild(caps);
      info.appendChild(meta);
      api.models.show(m.name).then((d) => {
        const map = { vision: 'Bilder', tools: 'Werkzeuge', thinking: 'Denken', embedding: 'Einbettung' };
        for (const c of d.capabilities || []) if (map[c]) caps.appendChild(el('span', 'badge feat', map[c]));
      }).catch(() => {});
      const use = el('button', 'btn small primary', 'Im Chat verwenden');
      use.onclick = () => ctx.useModel(m.name);
      const del = el('button', 'btn small danger', 'Löschen');
      del.onclick = async () => {
        if (!confirm(`Modell „${m.name}“ von der Festplatte löschen?`)) return;
        try { await api.models.remove(m.name); await ctx.refreshModels(); await load(); } catch (e) { ctx.hint('Löschen fehlgeschlagen: ' + cleanErr(e), 0); }
      };
      row.append(info, use, del);
      box.appendChild(row);
    }
  }
  async function load() {
    try { all = await api.models.list(); }
    catch { box.innerHTML = ''; box.appendChild(el('div', 'err', 'Modelle konnten nicht gelesen werden.')); return; }
    draw();
  }
  load();
  return () => { offDl(); };
}
