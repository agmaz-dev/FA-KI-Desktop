// „Erkunden“ (Modelle suchen und laden) und „Bibliothek“ (installierte Modelle)
// Beide Seiten liegen in den Einstellungen unter „Lokale Modelle“ (wie bei Bionic).
import { el, icon } from './ui.js';
import { formatBytes } from '../lib/util.js';

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
  const { box: sbox, inp: q } = searchBox('Modelle auf Hugging Face suchen, z. B. qwen, gpt-oss, gemma', (now) => { if (now) doSearch(); });
  page.appendChild(sbox);

  const info = el('div', 'result-bar');
  const count = el('span', 'note', '');
  const refresh = el('button', 'icon-btn small'); refresh.innerHTML = icon('refresh2', 14); refresh.title = 'Neu suchen'; refresh.onclick = () => doSearch();
  const sort = document.createElement('select'); sort.className = 'mini';
  for (const [v, t] of [['downloads', 'Beliebteste'], ['trendingScore', 'Im Trend'], ['likes', 'Meiste Likes'], ['lastModified', 'Neueste']]) { const o = el('option', null, t); o.value = v; sort.appendChild(o); }
  const left0 = el('div', 'rb-left'); left0.append(count, refresh);
  info.append(left0, sort);

  const cols = el('div', 'cols');
  const left = el('div', 'col-list');
  const right = el('div', 'col-detail');
  const listWrap = el('div', 'list-wrap'); listWrap.append(info, left);
  cols.append(listWrap, right);
  page.appendChild(cols);
  root.appendChild(page);

  let selected = '';
  let busy = false;
  let offPull = null;
  const installedNames = () => new Set((ctx.models() || []).map((m) => m.name.toLowerCase()));

  function showEmpty() {
    right.innerHTML = '';
    const e = el('div', 'detail-empty');
    e.appendChild(el('div', null, 'Wähle links ein Modell, um Größen, Stufen und Beschreibung zu sehen.'));
    const direct = el('div', 'direct');
    direct.appendChild(el('div', 'note', 'Oder gleich laden mit dem Namen aus der Ollama-Bibliothek (z. B. gpt-oss:20b):'));
    const inl = el('div', 'inline');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'gpt-oss:20b';
    const b = el('button', 'btn', 'Laden');
    const st = el('div', 'note');
    b.onclick = () => { if (inp.value.trim()) download(inp.value.trim(), st, b, 'Laden'); };
    inl.append(inp, b);
    direct.append(inl, st);
    e.appendChild(direct);
    right.appendChild(e);
  }

  async function download(name, statusEl, btn, label = 'Laden') {
    if (busy) return ctx.hint('Es läuft schon ein Download.');
    if (/cloud/i.test(name) && !confirm('Cloud-Modelle laufen NICHT lokal und senden Daten an fremde Server. Trotzdem laden?')) return;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Lädt …'; }
    if (offPull) offPull();
    offPull = api.ollama.onPull((p) => {
      statusEl.textContent = p.total ? `${p.status} – ${Math.round((p.completed / p.total) * 100)} % (${formatBytes(p.completed)} / ${formatBytes(p.total)})` : p.status;
    });
    statusEl.textContent = 'Starte Download …';
    try {
      const r = await api.ollama.pull(name);
      if (r && r.aborted) statusEl.textContent = 'Download abgebrochen.';
      else {
        statusEl.textContent = 'Fertig. Das Modell ist jetzt in der Bibliothek.';
        await ctx.refreshModels();
        if (selected) openDetail(selected, true);
      }
    } catch (e) { statusEl.textContent = 'Fehler: ' + cleanErr(e); }
    finally { busy = false; if (btn) { btn.disabled = false; btn.textContent = label; } if (offPull) { offPull(); offPull = null; } }
  }

  async function openDetail(id, keepScroll) {
    selected = id;
    left.querySelectorAll('.model-card').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
    const prev = right.scrollTop;
    right.innerHTML = '';
    right.appendChild(el('div', 'note', 'Lade Details …'));
    let d;
    try { d = await api.hf.details(id); } catch (e) { right.innerHTML = ''; right.appendChild(el('div', 'err', 'Details nicht ladbar: ' + cleanErr(e))); return; }
    if (selected !== id) return;
    right.innerHTML = '';
    const [author, name] = d.id.split('/');
    right.appendChild(el('h2', null, name));
    right.appendChild(el('div', 'repo-id', d.id));
    const stats = el('div', 'stats-row');
    stats.appendChild(el('span', null, '↓ ' + fmtNum(d.downloads)));
    stats.appendChild(el('span', null, '♥ ' + fmtNum(d.likes)));
    if (d.updated) stats.appendChild(el('span', null, 'Aktualisiert ' + ago(d.updated)));
    const web = el('a', 'web-link', 'Im Web öffnen ↗'); web.href = 'https://huggingface.co/' + d.id; web.target = '_blank'; web.rel = 'noreferrer';
    stats.appendChild(web);
    right.appendChild(stats);

    right.appendChild(el('h3', null, 'Download-Optionen'));
    if (!d.quants.length) {
      right.appendChild(el('div', 'err', 'In diesem Repo liegen keine direkt ladbaren GGUF-Dateien.'));
    } else {
      const have = installedNames();
      const tbl = el('div', 'quant-table');
      const status = el('div', 'note dl-status');
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
          b.onclick = () => download(qn.pull, status, b);
          act.appendChild(b);
        }
        row.append(nm, sz, fit, act);
        tbl.appendChild(row);
      }
      right.appendChild(tbl);
      const stop = el('button', 'btn small', 'Download abbrechen');
      stop.onclick = () => api.ollama.pullCancel();
      right.append(status, stop);
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

    if (d.readme) {
      right.appendChild(el('h3', null, 'README'));
      const md = el('div', 'md readme');
      md.innerHTML = ctx.renderMd(d.readme);
      md.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
      md.querySelectorAll('img').forEach((i) => i.remove());
      right.appendChild(md);
    }
    if (keepScroll) right.scrollTop = prev;
  }

  async function doSearch() {
    left.innerHTML = '';
    count.textContent = 'Suche …';
    let list = [];
    try { list = await api.hf.search({ query: q.value.trim(), sort: sort.value }); }
    catch (e) { count.textContent = ''; left.appendChild(el('div', 'err', 'Suche nicht möglich: ' + cleanErr(e))); return; }
    count.textContent = `${list.length} Ergebnisse auf Hugging Face`;
    if (!list.length) { left.appendChild(el('div', 'note', 'Nichts gefunden.')); return; }
    for (const m of list) {
      const [author, name] = m.id.split('/');
      const c = el('button', 'model-card' + (m.id === selected ? ' active' : ''));
      c.dataset.id = m.id;
      c.appendChild(el('div', 'mc-name', name));
      c.appendChild(el('div', 'mc-author', author));
      const sub = el('div', 'mc-sub');
      sub.appendChild(el('span', null, '↓ ' + fmtNum(m.downloads)));
      for (const f of m.features) sub.appendChild(el('span', 'badge feat', f));
      c.appendChild(sub);
      c.onclick = () => openDetail(m.id);
      left.appendChild(c);
    }
  }

  sort.onchange = doSearch;
  showEmpty();
  doSearch();
  return () => { if (offPull) offPull(); };
}

export function mountLibrary(root, ctx) {
  root.innerHTML = '';
  const api = ctx.api;
  const page = el('div', 'library');
  page.appendChild(el('h2', null, 'Meine Modelle'));

  const dirRow = el('div', 'dir-row');
  const dic = el('span', 'dr-icon'); dic.innerHTML = icon('library', 18);
  const dtxt = el('div', 'grow');
  dtxt.appendChild(el('div', 'lc-name', 'Ollama'));
  dtxt.appendChild(el('div', 'note', 'Die Modelle liegen im Ollama-Ordner dieses PCs.'));
  dirRow.append(dic, dtxt);
  page.appendChild(dirRow);

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
  const box = el('div', 'lib-list');
  page.appendChild(box);
  root.appendChild(page);

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
      info.appendChild(el('div', 'lc-name', m.name));
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
      api.ollama.show(m.name).then((d) => {
        const map = { vision: 'Bilder', tools: 'Werkzeuge', thinking: 'Denken', embedding: 'Einbettung' };
        for (const c of d.capabilities || []) if (map[c]) caps.appendChild(el('span', 'badge feat', map[c]));
      }).catch(() => {});
      const use = el('button', 'btn small primary', 'Im Chat verwenden');
      use.onclick = () => ctx.useModel(m.name);
      const del = el('button', 'btn small danger', 'Löschen');
      del.onclick = async () => {
        if (!confirm(`Modell „${m.name}“ von der Festplatte löschen?`)) return;
        try { await api.ollama.remove(m.name); await ctx.refreshModels(); await load(); } catch (e) { ctx.hint('Löschen fehlgeschlagen: ' + cleanErr(e), 0); }
      };
      row.append(info, use, del);
      box.appendChild(row);
    }
  }
  async function load() {
    try { all = await api.ollama.models(); }
    catch { box.innerHTML = ''; box.appendChild(el('div', 'err', 'Ollama nicht erreichbar.')); return; }
    draw();
  }
  load();
  return () => {};
}
