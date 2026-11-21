// Einstellungen → MCP: verbundene Server, beliebte Dienste als Karten, eigener Server (manuell).
import { el, icon } from './ui.js';

const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const LOGO = { github: ['#24292f', 'GH'], linear: ['#5e6ad2', 'L'], notion: ['#191919', 'N'], sentry: ['#362d59', 'S'], atlassian: ['#0c66e4', 'A'], cloudflare: ['#f38020', 'CF'], gdrive: ['#1a73e8', 'D'] };

function logo(id, size = 40) {
  const [bg, txt] = LOGO[id] || ['#5e5ce6', ''];
  const t = el('span', 'mcp-logo');
  t.style.width = t.style.height = size + 'px';
  t.style.background = bg;
  if (txt) t.textContent = txt; else t.innerHTML = icon('plug', Math.round(size * 0.55));
  return t;
}
function btn(text, onclick, cls = '') {
  const b = el('button', 'ap-btn' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  if (onclick) b.onclick = onclick;
  return b;
}
function toggle(checked, onChange, label) {
  const w = el('label', 'ap-sw');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!checked; cb.setAttribute('aria-label', label || '');
  cb.onchange = () => onChange(cb.checked);
  w.append(cb, el('span'));
  return w;
}

/** ctx: { api, hint, draft, save, rerender } */
export function mountMcp(root, ctx) {
  const api = ctx.api;
  let state = null;
  let view = 'list'; // list | custom
  let panel = ''; // github | gdrive | ''
  let busy = '';
  let msg = '';
  const off = api.mcp.onChange(async () => { if (!root.isConnected) { off(); return; } state = await api.mcp.state(); if (view === 'list') draw(); });

  async function load() { state = await api.mcp.state(); draw(); }

  function draw() {
    root.innerHTML = '';
    if (view === 'custom') return drawCustom();
    const connected = [];
    if (state.github.connected) connected.push({ key: 'github', name: 'GitHub', status: 'verbunden', kind: 'github' });
    if (state.gdrive.connected) connected.push({ key: 'gdrive', name: 'Google Drive', status: 'verbunden', kind: 'gdrive' });
    for (const s of state.servers) connected.push({ key: s.catalogId || 'custom', name: s.name, status: s.status, error: s.error, tools: s.tools, server: s });

    // ----- Verbundene MCP-Server -----
    const h = el('div', 'mcp-head');
    h.append(el('h2', 'ap-h', 'Verbundene MCP-Server'), el('span', 'mcp-count', String(connected.length)));
    root.appendChild(h);
    if (!connected.length) {
      const e = el('div', 'mcp-empty');
      const ic = el('span', 'mcp-empty-ic'); ic.innerHTML = icon('check', 18);
      const t = el('div');
      t.append(el('div', 'ap-t', 'Noch keine MCPs verbunden'), el('div', 'ap-d', 'Wähle unten einen beliebten MCP-Server aus, um loszulegen.'));
      e.append(ic, t);
      root.appendChild(e);
    } else {
      const box = el('div', 'ap-box');
      for (const c of connected) {
        const r = el('div', 'ap-row');
        r.appendChild(logo(c.key, 28));
        const l = el('div', 'ap-lbl');
        l.appendChild(el('div', 'ap-t', c.name));
        const st = c.status === 'verbunden' ? `Verbunden${c.tools ? ` · ${c.tools} Werkzeuge` : ''}` : c.status === 'anmelden' ? 'Anmeldung läuft …' : c.status === 'verbinde' ? 'Verbinde …' : c.status === 'aus' ? 'Ausgeschaltet' : c.status === 'fehler' ? 'Fehler: ' + c.error : 'Nicht verbunden';
        l.appendChild(el('div', 'ap-d' + (c.status === 'fehler' ? ' ap-warn' : ''), st));
        if (c.server && c.server.hidden) l.appendChild(el('div', 'ap-d', `Nur nach Erwähnung mit @${c.server.name}`));
        r.appendChild(l);
        const ctl = el('div', 'ap-ctl');
        if (c.server) {
          const s = c.server;
          ctl.appendChild(toggle(s.enabled, async (v) => { state = await api.mcp.update({ id: s.id, patch: { enabled: v } }); draw(); }, `${s.name} ein/aus`));
          if (s.enabled && c.status !== 'verbunden') ctl.appendChild(btn(c.status === 'fehler' || c.status === 'getrennt' ? 'Verbinden' : '…', () => connect(s.id)));
          ctl.appendChild(btn('Entfernen', async () => { if (!confirm(`„${s.name}“ entfernen? Die Anmeldung wird gelöscht.`)) return; state = await api.mcp.remove(s.id); draw(); }, 'red'));
        } else if (c.kind === 'github') {
          ctl.append(btn('Token ändern …', () => { panel = 'github'; draw(); }), btn('Trennen', async () => { await api.github.setToken(''); ctx.draft.githubHasToken = false; load(); }, 'red'));
        } else if (c.kind === 'gdrive') {
          ctl.appendChild(btn('Trennen', async () => { state = await api.mcp.gdriveDisconnect(); draw(); }, 'red'));
        }
        r.appendChild(ctl);
        box.appendChild(r);
      }
      root.appendChild(box);
    }
    if (msg) root.appendChild(el('div', 'ap-foot mcp-msg', msg));

    // ----- Beliebte MCPs -----
    root.appendChild(el('h2', 'ap-h mcp-h2', 'Beliebte MCPs'));
    root.appendChild(el('div', 'ap-d mcp-sub', 'Ausgewählte MCP-Server, die sich einfach einrichten lassen.'));
    const grid = el('div', 'mcp-grid');
    for (const c of state.catalog) {
      const card = el('div', 'mcp-card');
      card.appendChild(logo(c.id, 44));
      card.append(el('div', 'mcp-name', c.name), el('div', 'mcp-desc', c.desc));
      const foot = el('div', 'mcp-foot');
      foot.appendChild(el('span', 'ap-d', 'Von ' + c.by));
      const isConn = c.id === 'github' ? state.github.connected : c.id === 'gdrive' ? state.gdrive.connected : state.servers.some((s) => s.catalogId === c.id && s.status === 'verbunden');
      if (isConn) {
        const ok = el('span', 'ap-ok'); ok.innerHTML = icon('check', 12); ok.appendChild(document.createTextNode('Verbunden'));
        foot.appendChild(ok);
      } else {
        const b = btn(busy === c.id ? 'Anmelden …' : 'Einrichten', () => setup(c), 'blue');
        b.disabled = !!busy;
        foot.appendChild(b);
      }
      card.appendChild(foot);
      grid.appendChild(card);
    }
    root.appendChild(grid);
    if (panel === 'github') root.appendChild(githubPanel());
    if (panel === 'gdrive') root.appendChild(gdrivePanel());

    // ----- Manuell -----
    const man = el('div', 'ap-box mcp-manual');
    const t = el('div', 'grow');
    t.append(el('div', 'ap-t', 'MCP-Server manuell einrichten'), el('div', 'ap-d', 'Füge einen lokalen Befehl oder einen entfernten MCP-Server hinzu.'));
    const add = btn('Benutzerdefinierten MCP-Server hinzufügen', () => { view = 'custom'; draw(); });
    add.insertAdjacentHTML('afterbegin', icon('plus', 14));
    man.append(t, add);
    root.appendChild(man);
  }

  async function connect(id) {
    msg = '';
    const r = await api.mcp.connect(id);
    state = r.state;
    if (!r.ok) msg = 'Verbindung fehlgeschlagen: ' + r.error;
    draw();
  }

  async function setup(c) {
    msg = '';
    if (c.id === 'github') { panel = 'github'; return draw(); }
    if (c.id === 'gdrive') { panel = 'gdrive'; return draw(); }
    busy = c.id; draw();
    const r = await api.mcp.connectCatalog(c.id);
    busy = ''; state = r.state;
    msg = r.ok ? `${c.name} ist verbunden.` : `${c.name}: ${r.error}`;
    draw();
  }

  function githubPanel() {
    const p = el('div', 'ap-box mcp-panel');
    p.appendChild(el('div', 'ap-t', 'GitHub verbinden'));
    const d = el('div', 'ap-d');
    d.append('Auf github.com unter Settings → Developer settings → Personal access tokens ein Token erstellen. Zum Lesen reicht „Contents: Read-only“. Damit die KI auch schreiben darf (Repos, Pull Requests): „repo“ und „workflow“. ');
    const a = el('a', null, 'Token erstellen'); a.href = 'https://github.com/settings/tokens'; a.target = '_blank'; a.rel = 'noreferrer';
    d.appendChild(a);
    p.appendChild(d);
    const r = el('div', 'mcp-inline');
    const f = el('input', 'ap-field'); f.type = 'password'; f.placeholder = 'GitHub-Token einfügen'; f.autocomplete = 'off'; f.setAttribute('aria-label', 'GitHub-Token');
    const out = el('div', 'ap-d');
    r.append(f, btn('Verbinden', async () => {
      if (!f.value.trim()) return;
      out.textContent = 'Prüfe …';
      const res = await api.github.setToken(f.value.trim());
      if (res.ok) { ctx.draft.githubHasToken = true; panel = ''; msg = `GitHub verbunden als ${res.login || '?'}.`; load(); }
      else out.textContent = 'Nicht gespeichert: ' + res.error;
    }, 'blue'), btn('Abbrechen', () => { panel = ''; draw(); }));
    p.append(r, out);
    return p;
  }

  function gdrivePanel() {
    const p = el('div', 'ap-box mcp-panel');
    p.appendChild(el('div', 'ap-t', 'Google Drive verbinden'));
    const ol = el('ol', 'mcp-steps');
    const step = (html) => { const li = el('li'); li.innerHTML = html; ol.appendChild(li); };
    step('Öffne <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">console.cloud.google.com</a>, lege ein Projekt an und aktiviere die „Google Drive API“.');
    step('Unter „OAuth-Zustimmungsbildschirm“: Typ „Extern“, Dich selbst als Testnutzer eintragen.');
    step('Unter „Anmeldedaten“ → „OAuth-Client-ID erstellen“ → Typ <b>Desktop-App</b>.');
    step('Client-ID und Clientschlüssel hier einfügen und „Anmelden“ klicken. Google zeigt einmal „App nicht überprüft“: auf „Weiter“ klicken.');
    p.appendChild(ol);
    const id = el('input', 'ap-field'); id.placeholder = 'Client-ID (…apps.googleusercontent.com)'; id.setAttribute('aria-label', 'Client-ID');
    const sec = el('input', 'ap-field'); sec.type = 'password'; sec.placeholder = 'Clientschlüssel'; sec.setAttribute('aria-label', 'Clientschlüssel');
    const out = el('div', 'ap-d');
    const r = el('div', 'mcp-inline');
    r.append(id, sec, btn('Anmelden', async () => {
      out.textContent = 'Anmeldefenster ist offen …';
      const res = await api.mcp.gdriveConnect({ clientId: id.value, clientSecret: sec.value });
      state = res.state;
      if (res.ok) { panel = ''; msg = 'Google Drive ist verbunden.'; draw(); } else out.textContent = 'Fehler: ' + res.error;
    }, 'blue'), btn('Abbrechen', () => { panel = ''; draw(); }));
    p.append(r, out);
    return p;
  }

  // ----- Benutzerdefinierter MCP -----
  function drawCustom() {
    const f = { enabled: true, name: '', description: '', hidden: false, transport: 'stdio', command: '', url: '', env: '', headers: '', adv: false };
    const head = el('div', 'mcp-chead');
    head.appendChild(logo('custom', 52));
    const ht = el('div');
    ht.append(el('div', 'ap-hero-t', 'Benutzerdefinierter MCP'), el('div', 'ap-d', 'Verbinde einen MCP-Server, der nicht im Katalog enthalten ist.'));
    head.appendChild(ht);
    root.appendChild(head);

    const stBox = el('div', 'ap-box');
    const stRow = el('div', 'ap-row');
    const stL = el('div', 'ap-lbl'); stL.append(el('div', 'ap-t', 'Status'), el('div', 'ap-d', 'Bereit zum Verbinden'));
    stRow.append(stL, toggle(true, (v) => { f.enabled = v; stL.lastChild.textContent = v ? 'Bereit zum Verbinden' : 'Wird ausgeschaltet gespeichert'; }, 'Status'));
    stBox.appendChild(stRow);
    root.appendChild(stBox);

    root.appendChild(el('h2', 'ap-h', 'Konfiguration'));
    const box = el('div', 'ap-box');
    const frow = (title, desc, ctrl) => {
      const r = el('div', 'ap-row mcp-frow');
      const l = el('div', 'ap-lbl'); l.appendChild(el('div', 'ap-t', title)); if (desc) l.appendChild(el('div', 'ap-d', desc));
      r.append(l, ctrl);
      box.appendChild(r);
      return r;
    };
    const inp = (ph, key, mono) => { const i = el('input', 'ap-field' + (mono ? ' mono' : '')); i.placeholder = ph; i.oninput = () => { f[key] = i.value; check(); }; return i; };
    const nameI = inp('Mein MCP', 'name'); nameI.setAttribute('aria-label', 'Name');
    frow('Name', 'Der angezeigte Name dieses MCP-Servers.', nameI);
    const descI = inp('', 'description'); descI.setAttribute('aria-label', 'Beschreibung');
    frow('Beschreibung', 'Hilft dem Agenten zu verstehen, wann er diesen MCP verwenden soll.', descI);
    frow('Ohne Erwähnung vor dem Agenten verbergen', 'Diesen MCP dem Agenten erst anzeigen, nachdem Du ihn mit @ erwähnt hast.', toggle(false, (v) => { f.hidden = v; }, 'Verbergen'));
    const seg = el('span', 'ap-seg wide');
    const cmdRow = frow('Befehl', 'Der Befehl zum Starten dieses Servers.', inp('npx -y mein-mcp-server', 'command', true));
    const urlRow = frow('Webadresse', 'Die Adresse des MCP-Servers (Streamable HTTP oder SSE).', inp('https://beispiel.de/mcp', 'url', true));
    for (const [v, t] of [['stdio', 'Auf diesem Computer'], ['http', 'Webadresse']]) {
      const b = el('button', v === f.transport ? 'on' : '', t);
      b.type = 'button';
      b.onclick = () => { f.transport = v; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); sync(); check(); };
      seg.appendChild(b);
    }
    const vRow = frow('Verbindung', 'Wähle, wie sich FA KI Desktop mit diesem Server verbindet.', seg);
    box.insertBefore(vRow, cmdRow);
    root.appendChild(box);

    root.appendChild(el('h2', 'ap-h', 'Erweiterte Einstellungen'));
    const advBox = el('div', 'ap-box');
    const advRow = el('div', 'ap-row');
    const advL = el('div', 'ap-lbl'); advL.append(el('div', 'ap-t', 'Erweiterte Optionen anzeigen'), el('div', 'ap-d', 'Konfiguriere bei Bedarf weitere Verbindungsdetails.'));
    advRow.append(advL, toggle(false, (v) => { f.adv = v; sync(); }, 'Erweiterte Optionen'));
    advBox.appendChild(advRow);
    const envRow = el('div', 'ap-row mcp-frow');
    const envL = el('div', 'ap-lbl'); envL.append(el('div', 'ap-t', 'Umgebungsvariablen'), el('div', 'ap-d', 'Eine pro Zeile: NAME=wert (z. B. Schlüssel für den Server).'));
    const envT = el('textarea', 'ap-field ap-area mono'); envT.rows = 3; envT.placeholder = 'API_KEY=…'; envT.oninput = () => { f.env = envT.value; };
    envRow.append(envL, envT);
    const hdRow = el('div', 'ap-row mcp-frow');
    const hdL = el('div', 'ap-lbl'); hdL.append(el('div', 'ap-t', 'Kopfzeilen'), el('div', 'ap-d', 'Eine pro Zeile: Name: Wert (z. B. Authorization: Bearer …). Ohne Kopfzeile meldet sich die App bei Bedarf über ein Anmeldefenster an.'));
    const hdT = el('textarea', 'ap-field ap-area mono'); hdT.rows = 3; hdT.placeholder = 'Authorization: Bearer …'; hdT.oninput = () => { f.headers = hdT.value; };
    hdRow.append(hdL, hdT);
    advBox.append(envRow, hdRow);
    root.appendChild(advBox);

    const foot = el('div', 'ap-actions');
    const fmsg = el('span', 'ap-d grow', 'Fülle die Pflichtfelder aus');
    const back = btn('Abbrechen', () => { view = 'list'; load(); });
    const addB = btn('MCP hinzufügen', async () => {
      addB.disabled = true; fmsg.textContent = 'Verbinde …';
      const r = await api.mcp.addCustom(f);
      if (!r.ok) { fmsg.textContent = 'Fehler: ' + r.error; addB.disabled = false; return; }
      state = r.state; view = 'list';
      msg = r.warn ? `„${f.name}“ gespeichert, aber noch nicht verbunden: ${r.warn}` : `„${f.name}“ ist verbunden.`;
      draw();
    }, 'blue');
    foot.append(fmsg, back, addB);
    root.appendChild(foot);

    function sync() {
      cmdRow.style.display = f.transport === 'stdio' ? '' : 'none';
      urlRow.style.display = f.transport === 'http' ? '' : 'none';
      envRow.style.display = f.adv && f.transport === 'stdio' ? '' : 'none';
      hdRow.style.display = f.adv && f.transport === 'http' ? '' : 'none';
    }
    function check() {
      const ok = f.name.trim() && (f.transport === 'stdio' ? f.command.trim() : /^https?:\/\/\S+/.test(f.url.trim()));
      addB.disabled = !ok;
      fmsg.textContent = ok ? '' : 'Fülle die Pflichtfelder aus';
    }
    sync(); check();
  }

  load().catch((e) => { root.appendChild(el('div', 'ap-warn', 'MCP nicht verfügbar: ' + cleanErr(e))); });
}
