// Seiten „Erkunden“ (Modelle suchen und laden) und „Bibliothek“ (installierte Modelle)
import { el, icon } from './ui.js';
import { formatBytes } from '../lib/util.js';

const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' Mio.' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.', ',') + ' Tsd.' : String(n || 0));
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const FIT_CLASS = { gpu: 'ok', teils: 'warn', nein: 'bad' };

function pageHead(title, sub, onBack) {
  const h = el('div', 'page-head');
  const b = el('button', 'back-btn');
  b.innerHTML = icon('arrowleft', 17) + '<span>Zurück zum Chat</span>';
  b.onclick = onBack;
  const t = el('div', 'grow');
  t.appendChild(el('h1', null, title));
  if (sub) t.appendChild(el('div', 'note', sub));
  h.append(b, t);
  return h;
}

/**
 * ctx: { api, models() -> Liste, refreshModels(), useModel(name), back(), renderMd(text), hint(text) }
 */
export function mountExplore(root, ctx) {
  root.innerHTML = '';
  const api = ctx.api;
  const page = el('div', 'page explore');
  page.appendChild(pageHead('Erkunden', 'Modelle auf Hugging Face suchen und mit einem Klick laden. Geladen wird über Ollama, alles läuft danach lokal auf diesem PC.', ctx.back));

  const bar = el('div', 'search-bar');
  const q = el('input'); q.type = 'text'; q.placeholder = 'Modell suchen, z. B. qwen, gpt-oss, gemma, llama';
  const sort = document.createElement('select');
  for (const [v, t] of [['downloads', 'Beliebteste'], ['trendingScore', 'Im Trend'], ['likes', 'Meiste Likes'], ['lastModified', 'Zuletzt geändert']]) { const o = el('option', null, t); o.value = v; sort.appendChild(o); }
  const go = el('button', 'btn primary', 'Suchen');
  bar.append(q, sort, go);
  page.appendChild(bar);

  const cols = el('div', 'cols');
  const left = el('div', 'col-list');
  const right = el('div', 'col-detail');
  cols.append(left, right);
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
    b.onclick = () => { if (inp.value.trim()) download(inp.value.trim(), st, b); };
    inl.append(inp, b);
    direct.append(inl, st);
    e.appendChild(direct);
    right.appendChild(e);
  }

  async function download(name, statusEl, btn) {
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
    finally { busy = false; if (btn) { btn.disabled = false; btn.textContent = 'Herunterladen'; } if (offPull) { offPull(); offPull = null; } }
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
    right.appendChild(el('h2', null, d.id));
    const meta = el('div', 'meta-row');
    meta.appendChild(el('span', 'badge', fmtNum(d.downloads) + ' Downloads'));
    meta.appendChild(el('span', 'badge', fmtNum(d.likes) + ' Likes'));
    if (d.architektur) meta.appendChild(el('span', 'badge', d.architektur));
    if (d.kontext) meta.appendChild(el('span', 'badge', 'Kontext bis ' + fmtNum(d.kontext)));
    for (const f of d.features) meta.appendChild(el('span', 'badge feat', f));
    right.appendChild(meta);
    if (d.features.length) right.appendChild(el('div', 'note', 'Bilder, Werkzeuge und Denken sind nur aus den Schlagworten des Modells geschätzt und können fehlen oder abweichen.'));

    if (!d.quants.length) {
      right.appendChild(el('div', 'err', 'In diesem Repo liegen keine direkt ladbaren GGUF-Dateien.'));
    } else {
      right.appendChild(el('h3', null, 'Stufen (Quantisierung)'));
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
          const b = el('button', 'btn small' + (qn.empfohlen ? ' primary' : ''), 'Herunterladen');
          b.onclick = () => download(qn.pull, status, b);
          act.appendChild(b);
        }
        row.append(nm, sz, fit, act);
        tbl.appendChild(row);
      }
      right.appendChild(tbl);
      const stop = el('button', 'btn small', 'Download abbrechen');
      stop.onclick = () => api.ollama.pullCancel();
      right.appendChild(status);
      right.appendChild(stop);
      right.appendChild(el('div', 'note', 'Größere Stufen sind genauer, brauchen aber mehr Speicher. „Passt auf Deine Karte“ rechnet mit dem Wert aus Einstellungen → KI und Modell.'));
    }
    if (d.readme) {
      right.appendChild(el('h3', null, 'Beschreibung'));
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
    left.appendChild(el('div', 'note', 'Suche …'));
    let list = [];
    try { list = await api.hf.search({ query: q.value.trim(), sort: sort.value }); }
    catch (e) { left.innerHTML = ''; left.appendChild(el('div', 'err', 'Suche nicht möglich: ' + cleanErr(e))); return; }
    left.innerHTML = '';
    if (!list.length) { left.appendChild(el('div', 'note', 'Nichts gefunden.')); return; }
    left.appendChild(el('div', 'note', `${list.length} Ergebnisse (Hugging Face, GGUF)`));
    for (const m of list) {
      const c = el('button', 'model-card' + (m.id === selected ? ' active' : ''));
      c.dataset.id = m.id;
      c.appendChild(el('div', 'mc-name', m.id));
      const sub = el('div', 'mc-sub');
      sub.appendChild(el('span', null, fmtNum(m.downloads) + ' Downloads'));
      for (const f of m.features) sub.appendChild(el('span', 'badge feat', f));
      c.appendChild(sub);
      c.onclick = () => openDetail(m.id);
      left.appendChild(c);
    }
  }

  go.onclick = doSearch;
  sort.onchange = doSearch;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  showEmpty();
  doSearch();
  return () => { if (offPull) offPull(); };
}

export function mountLibrary(root, ctx) {
  root.innerHTML = '';
  const api = ctx.api;
  const page = el('div', 'page library');
  page.appendChild(pageHead('Bibliothek', 'Deine installierten Modelle: im Chat verwenden oder löschen.', ctx.back));
  const box = el('div', 'lib-list');
  page.appendChild(box);
  root.appendChild(page);

  async function render() {
    box.innerHTML = '';
    let list = [];
    try { list = await api.ollama.models(); }
    catch { box.appendChild(el('div', 'err', 'Ollama nicht erreichbar.')); return; }
    if (!list.length) {
      const e = el('div', 'detail-empty');
      e.appendChild(el('div', null, 'Noch keine Modelle installiert.'));
      const b = el('button', 'btn primary', 'Zu „Erkunden“');
      b.onclick = () => ctx.goExplore();
      e.appendChild(b);
      box.appendChild(e);
      return;
    }
    const total = list.filter((m) => !m.remote).reduce((n, m) => n + (m.size || 0), 0);
    box.appendChild(el('div', 'note', `${list.length} Modelle, zusammen ${formatBytes(total)} auf der Festplatte`));
    const current = (ctx.currentModel && ctx.currentModel()) || '';
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
        try { await api.ollama.remove(m.name); await ctx.refreshModels(); render(); } catch (e) { ctx.hint('Löschen fehlgeschlagen: ' + cleanErr(e), 0); }
      };
      row.append(info, use, del);
      box.appendChild(row);
    }
  }
  render();
  return () => {};
}
