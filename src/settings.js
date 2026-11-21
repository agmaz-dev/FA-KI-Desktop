import { el, icon, newId } from './ui.js';
import { mountMcp } from './mcp.js';

// Einstellungen im Apple-Stil: Seitenleiste aus Glas links, rechts Gruppen mit einer Zeile pro Einstellung.
// Jede Änderung gilt sofort (kein „Speichern“-Knopf).
const GROUPS = [
  ['App', [['general', 'Allgemein', 'gear', '#8e8e93'], ['profiles', 'Profile', 'user', '#0a84ff']]],
  ['Assistent', [['tools', 'Internet und Agent', 'globe', '#30b0c7'], ['speech', 'Sprache', 'wave', '#ff375f']]],
  ['Integrationen', [['mcp', 'MCP', 'plug', '#5e5ce6']]],
  ['Lokale Modelle', [['explore', 'Erkunden', 'compass', '#ff9f0a'], ['library', 'Bibliothek', 'cube', '#bf5af2'], ['ai', 'Standardwerte', 'sliders', '#8e8e93']]],
  ['System', [['data', 'Daten und Info', 'info', '#8e8e93']]],
];
const ITEMS = GROUPS.flatMap(([, items]) => items);
const TITLE = Object.fromEntries(ITEMS.map(([id, label]) => [id, label]));

export const PROFILE_FIELDS = [
  ['fullName', 'Vollständiger Name'],
  ['company', 'Firma / Organisation'],
  ['address', 'Adresse'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['signature', 'Grußformel / Unterschrift'],
  ['notes', 'Weitere Hinweise'],
];

/** Baut den Text, der der KI die Profil-Angaben mitgibt. */
export function profilePrompt(p) {
  if (!p) return '';
  const lang = { de: 'Deutsch', tr: 'Türkisch', auto: '' }[p.language || 'de'];
  const lines = [];
  if (p.label) lines.push(`Profilname: ${p.label}`);
  if (p.fullName) lines.push(`Name: ${p.fullName}`);
  if (p.company) lines.push(`Firma/Organisation: ${p.company}`);
  if (p.address) lines.push(`Adresse:\n${p.address}`);
  if (p.email) lines.push(`E-Mail: ${p.email}`);
  if (p.phone) lines.push(`Telefon: ${p.phone}`);
  if (p.signature) lines.push(`Grußformel/Unterschrift:\n${p.signature}`);
  if (lang) lines.push(`Bevorzugte Sprache für Schreiben: ${lang}`);
  if (p.notes) lines.push(`Weitere Hinweise: ${p.notes}`);
  if (!lines.length) return '';
  return (
    'Aktives Profil (der Absender, für den du schreibst). Wenn du in meinem Auftrag Briefe, E-Mails oder Dokumente verfasst, ' +
    'nimm diese Angaben als Absender und für die Unterschrift. Erfinde keine fehlenden Angaben: ' +
    'lass dann einen Platzhalter wie [Telefon] stehen.\n' + lines.join('\n')
  );
}

const isMac = /Mac/i.test(navigator.platform);
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const sec1 = (x) => Number(x).toFixed(1).replace('.', ',');

// ---------- Bausteine ----------
function tile(name, color, size = 20) {
  const t = el('span', 'ap-tile');
  t.style.background = color;
  t.style.width = t.style.height = size + 'px';
  t.style.borderRadius = Math.round(size / 4) + 'px';
  t.innerHTML = icon(name, Math.round(size * 0.65));
  return t;
}
function btn(text, onclick, cls = '') {
  const b = el('button', 'ap-btn' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  if (onclick) b.onclick = onclick;
  return b;
}
function okBadge(text) {
  const s = el('span', 'ap-ok');
  s.innerHTML = icon('check', 12);
  s.appendChild(document.createTextNode(text));
  return s;
}
function popup(options, value, onChange, label) {
  const w = el('span', 'ap-pop');
  const s = el('select');
  if (label) s.setAttribute('aria-label', label);
  for (const [v, t] of options) { const o = el('option', null, t); o.value = v; s.appendChild(o); }
  s.value = value;
  s.onchange = () => onChange(s.value);
  w.append(s);
  w.insertAdjacentHTML('beforeend', icon('updown', 12));
  return w;
}
function toggle(checked, onChange, label) {
  const w = el('label', 'ap-sw');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!checked;
  if (label) cb.setAttribute('aria-label', label);
  cb.onchange = () => onChange(cb.checked);
  w.append(cb, el('span'));
  return w;
}
function field(value, { placeholder = '', type = 'text', width, onInput, onChange } = {}) {
  const i = el('input', 'ap-field');
  i.type = type; i.value = value ?? ''; i.placeholder = placeholder;
  if (width) i.style.width = width;
  if (onInput) i.addEventListener('input', () => onInput(i.value));
  if (onChange) i.addEventListener('change', () => onChange(i.value));
  return i;
}
function area(value, rows, onInput, placeholder = '') {
  const t = el('textarea', 'ap-field ap-area');
  t.rows = rows; t.value = value ?? ''; t.placeholder = placeholder;
  t.addEventListener('input', () => onInput(t.value));
  return t;
}
/** Kleines Menü hinter „···“. items: [[Text, Funktion, gefährlich?]] */
function moreMenu(items, label) {
  const wrap = el('span', 'ap-more');
  const b = btn('', null, 'ap-icon');
  b.innerHTML = icon('dots', 16);
  b.setAttribute('aria-label', label || 'Weitere Aktionen');
  const m = el('div', 'ap-menu hidden');
  for (const [t, fn, danger] of items) {
    const i = el('button', danger ? 'danger' : '', t);
    i.type = 'button';
    i.onclick = () => { m.classList.add('hidden'); fn(); };
    m.appendChild(i);
  }
  b.onclick = (e) => { e.stopPropagation(); document.querySelectorAll('.ap-menu').forEach((x) => x !== m && x.classList.add('hidden')); m.classList.toggle('hidden'); };
  document.addEventListener('click', () => m.classList.add('hidden'));
  wrap.append(b, m);
  return wrap;
}
function section(body, title, foot) {
  const s = el('section', 'ap-sec');
  if (title) s.appendChild(el('h2', 'ap-h', title));
  const box = el('div', 'ap-box');
  s.appendChild(box);
  if (foot) s.appendChild(el('div', 'ap-foot', foot));
  body.appendChild(s);
  return box;
}
function row(box, title, desc, ...ctrls) {
  const r = el('div', 'ap-row');
  const l = el('div', 'ap-lbl');
  const t = el('div', 'ap-t', title);
  l.appendChild(t);
  let d = null;
  if (desc != null) { d = el('div', 'ap-d', desc); l.appendChild(d); }
  r.appendChild(l);
  const c = el('div', 'ap-ctl');
  ctrls.filter(Boolean).forEach((x) => c.appendChild(x));
  r.appendChild(c);
  box.appendChild(r);
  r.desc = (text) => { if (!d) { d = el('div', 'ap-d'); l.appendChild(d); } d.textContent = text; };
  return r;
}
function hero(body, name, color, title, text) {
  const h = el('div', 'ap-box ap-hero');
  h.appendChild(tile(name, color, 52));
  h.appendChild(el('div', 'ap-hero-t', title));
  if (text) h.appendChild(el('div', 'ap-d', text));
  body.appendChild(h);
}

/**
 * ctx: { settings, api, mount(build), close(), explore(root), library(root), apply(draft), hint, showProgress, hideProgress, onSaved(settings), stopSpeaking(), onChatsCleared(), dlWidget() }
 */
export async function openSettings(ctx, startTab = 'general') {
  const draft = JSON.parse(JSON.stringify(ctx.settings));
  if (!Array.isArray(draft.profiles)) draft.profiles = [];
  let tab = TITLE[startTab] ? startTab : 'general';
  const hist = [tab];
  let hpos = 0;
  const go = (id) => { if (id === tab) return; hist.length = hpos + 1; hist.push(id); hpos++; tab = id; render(); };
  let selProfile = draft.activeProfile || (draft.profiles[0] && draft.profiles[0].id) || '';
  const api = ctx.api;
  const info = await api.app.info();
  let navFilter = '';

  // Sofort speichern (kurz gebündelt, damit Tippen nicht bei jedem Buchstaben alles neu lädt)
  let pending = {};
  let timer = null;
  const save = (patch, now) => {
    Object.assign(draft, patch);
    Object.assign(pending, patch);
    ctx.apply(draft);
    clearTimeout(timer);
    const run = async () => {
      const p = pending; pending = {};
      if (!Object.keys(p).length) return;
      const next = await api.settings.set(p);
      Object.assign(draft, { hfHasToken: next.hfHasToken, githubHasToken: next.githubHasToken, mailHasPassword: next.mailHasPassword });
      await ctx.onSaved(next);
    };
    if (now) run(); else timer = setTimeout(run, 450);
  };

  const PH = (window.__phUi = window.__phUi || { running: false, done: '' });
  const VX = (window.__vxUi = window.__vxUi || { running: false, done: '' });
  const VU = (window.__voiceUi = window.__voiceUi || { text: '', pct: null, running: false, done: '' });
  if (!window.__voiceSub) {
    window.__voiceSub = api.voice.onProgress((p) => {
      VU.text = p.text || ''; VU.pct = p.pct;
      const t = document.getElementById('voiceProgText'); if (t) t.textContent = VU.text;
    });
  }

  async function render() {
    const st = await api.speech.status();
    const vstat = isMac ? { installed: false } : await api.voice.status();
    ctx.mount((m) => {
      m.classList.add('ap');
      // ----- Seitenleiste (Glas) -----
      const nav = el('nav', 'ap-nav');
      nav.setAttribute('aria-label', 'Einstellungen');
      const q = el('div', 'ap-search');
      q.insertAdjacentHTML('afterbegin', icon('search', 13));
      const qi = el('input'); qi.type = 'search'; qi.placeholder = 'Suchen'; qi.value = navFilter; qi.setAttribute('aria-label', 'Einstellungen durchsuchen');
      q.appendChild(qi);
      nav.appendChild(q);
      const back = el('button', 'ap-nav-item');
      back.type = 'button';
      back.append(tile('chevleft', '#636366'), document.createTextNode('Zurück zur App'));
      back.onclick = () => { save({}, true); ctx.close(); };
      nav.appendChild(back);
      const list = el('div', 'ap-nav-list');
      const drawNav = () => {
        list.innerHTML = '';
        const f = navFilter.trim().toLowerCase();
        for (const [group, items] of GROUPS) {
          const shown = items.filter(([, label]) => !f || label.toLowerCase().includes(f));
          if (!shown.length) continue;
          list.appendChild(el('div', 'ap-nav-grp', group));
          for (const [id, label, ic, color] of shown) {
            const b = el('button', 'ap-nav-item' + (id === tab ? ' on' : ''));
            b.type = 'button';
            b.append(tile(ic, color), document.createTextNode(label));
            b.onclick = () => go(id);
            list.appendChild(b);
          }
        }
      };
      qi.addEventListener('input', () => { navFilter = qi.value; drawNav(); });
      drawNav();
      nav.appendChild(list);
      nav.appendChild(el('div', 'grow'));
      nav.appendChild(ctx.dlWidget());

      // ----- Rechte Seite -----
      const main = el('div', 'ap-main');
      const bar = el('div', 'ap-bar');
      const prev = btn('', () => { hpos--; tab = hist[hpos]; render(); }, 'ap-icon'); prev.innerHTML = icon('chevleft', 16); prev.setAttribute('aria-label', 'Zurück'); prev.disabled = hpos <= 0;
      const next = btn('', () => { hpos++; tab = hist[hpos]; render(); }, 'ap-icon'); next.innerHTML = icon('chevright', 16); next.setAttribute('aria-label', 'Vorwärts'); next.disabled = hpos >= hist.length - 1;
      bar.append(prev, next, el('div', 'ap-bar-t', TITLE[tab]));
      main.appendChild(bar);
      const wide = tab === 'explore' || tab === 'library';
      const scroller = el('div', 'ap-scroll' + (wide ? ' wide' : ''));
      const body = el('div', 'ap-body');
      scroller.appendChild(body);
      main.appendChild(scroller);
      m.append(nav, main);
      if (tab === 'explore') ctx.explore(body);
      else if (tab === 'library') ctx.library(body);
      else if (tab === 'mcp') mountMcp(body, { api, hint: ctx.hint, draft, save, rerender: render });
      else ({ general, profiles, tools, speech, ai, data })[tab](body, st, vstat);
    });
  }

  // ---------- Allgemein ----------
  function general(body) {
    hero(body, 'gear', '#8e8e93', 'Allgemein', 'Aussehen, Schrift und Bedienung der App.');
    const look = section(body, 'Erscheinungsbild');
    const r = el('div', 'ap-row ap-looks');
    r.appendChild(el('div', 'ap-t grow', 'Erscheinungsbild'));
    for (const [v, t] of [['dark', 'Dunkel'], ['light', 'Hell']]) {
      const b = el('button', 'ap-look' + (draft.theme === v ? ' on' : ''));
      b.type = 'button';
      const pv = el('span', 'pv ' + v); pv.appendChild(el('i'));
      b.append(pv, document.createTextNode(t));
      b.onclick = () => { save({ theme: v }, true); render(); };
      r.appendChild(b);
    }
    look.appendChild(r);

    const FONTS = [['', 'Systemschrift'], ...['Arial', 'Calibri', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Cambria', 'Times New Roman', 'Palatino Linotype', 'Book Antiqua', 'Constantia', 'Consolas', 'Courier New', 'Helvetica Neue', 'Avenir Next', 'New York'].map((f) => [f, f])];
    const fontOpts = (cur) => (cur && !FONTS.some(([v]) => v === cur) ? [[cur, cur], ...FONTS] : FONTS);
    const font = section(body, 'Schrift');
    row(font, 'Schriftart der App', 'Menüs, Listen und Einstellungen.', popup(fontOpts(draft.fontUi), draft.fontUi || '', (v) => save({ fontUi: v }), 'Schriftart der App'));
    row(font, 'Schriftart der Antworten', 'Chat-Antworten und Eingabefeld.', popup(fontOpts(draft.fontAnswer), draft.fontAnswer || '', (v) => { save({ fontAnswer: v }); sample.style.fontFamily = v ? `"${v}", serif` : ''; }, 'Schriftart der Antworten'));
    const size = el('span', 'ap-range');
    const sl = el('input'); sl.type = 'range'; sl.min = 13; sl.max = 21; sl.step = 1; sl.value = draft.fontSize; sl.setAttribute('aria-label', 'Textgröße');
    sl.oninput = () => { save({ fontSize: Number(sl.value) }); sample.style.fontSize = sl.value + 'px'; };
    size.append(el('small', null, 'A'), sl, el('big', null, 'A'));
    row(font, 'Textgröße', null, size);
    const pr = el('div', 'ap-row');
    const sample = el('div', 'ap-sample', 'Der schnelle braune Fuchs springt über den faulen Hund 0123');
    sample.style.fontFamily = draft.fontAnswer ? `"${draft.fontAnswer}", serif` : '';
    sample.style.fontSize = draft.fontSize + 'px';
    pr.appendChild(sample);
    font.appendChild(pr);

    const use = section(body, 'Bedienung');
    row(use, 'Enter sendet die Nachricht', `Aus: Enter macht eine neue Zeile, gesendet wird mit ${isMac ? '⌘' : 'Strg'} + Enter.`, toggle(draft.sendOnEnter, (v) => save({ sendOnEnter: v }), 'Enter sendet'));
    row(use, 'Token-Anzeige im Chat', 'Zeigt unter dem Eingabefeld den Kontext (z. B. „1 240 von 16 384 Tokens“) und unter jeder Antwort die Geschwindigkeit (Tokens pro Sekunde).', toggle(draft.showTokens, (v) => save({ showTokens: v }), 'Token-Anzeige im Chat'));
    row(use, 'Cloud-Modelle in der Liste anzeigen', 'Cloud-Modelle senden Deine Daten an fremde Server. Besser aus lassen.', toggle(draft.showCloud, (v) => save({ showCloud: v }), 'Cloud-Modelle anzeigen'));
  }

  // ---------- Profile ----------
  function profiles(body) {
    const box = section(body, 'Profile', 'Die KI benutzt das aktive Profil als Absender beim Schreiben von Briefen, E-Mails und Dokumenten.');
    const colors = ['#0a84ff', '#bf5af2', '#30b0c7', '#ff9f0a', '#ff375f', '#32d74b'];
    draft.profiles.forEach((p, i) => {
      const av = el('span', 'ap-av', (p.label || '?').charAt(0).toUpperCase());
      av.style.background = colors[i % colors.length];
      const r = row(box, p.label || 'Ohne Namen', [p.fullName, p.company].filter(Boolean).join(' · ') || ' ');
      r.insertBefore(av, r.firstChild);
      r.classList.add('ap-click');
      if (p.id === selProfile) r.classList.add('sel');
      r.onclick = (e) => { if (e.target.closest('button')) return; selProfile = p.id; render(); };
      const c = r.querySelector('.ap-ctl');
      if (p.id === draft.activeProfile) c.appendChild(el('span', 'ap-badge', 'Aktiv'));
      else c.appendChild(btn('Als aktiv setzen', () => { save({ activeProfile: p.id }, true); render(); }));
    });
    const addRow = el('div', 'ap-row end');
    addRow.appendChild(btn('Profil hinzufügen …', () => {
      const p = { id: newId(), label: 'Neues Profil', fullName: '', company: '', address: '', email: '', phone: '', signature: '', language: 'de', notes: '' };
      draft.profiles.push(p);
      selProfile = p.id;
      save({ profiles: draft.profiles, activeProfile: draft.activeProfile || p.id }, true);
      render();
    }));
    box.appendChild(addRow);

    const p = draft.profiles.find((x) => x.id === selProfile);
    if (!p) return;
    const ed = section(body, p.label || 'Profil');
    const upd = (k, v) => { p[k] = v; save({ profiles: draft.profiles }); };
    const frow = (label, ctrl, top) => { const r = el('div', 'ap-row' + (top ? ' top' : '')); const l = el('label', 'ap-fl', label); r.append(l, ctrl); ed.appendChild(r); };
    frow('Profilname', field(p.label, { onInput: (v) => upd('label', v), onChange: () => render(), width: '340px' }));
    frow('Vollständiger Name', field(p.fullName, { placeholder: 'Vor- und Nachname', onInput: (v) => upd('fullName', v), width: '340px' }));
    frow('Firma / Organisation', field(p.company, { placeholder: 'optional', onInput: (v) => upd('company', v), width: '340px' }));
    frow('Adresse', area(p.address, 3, (v) => upd('address', v), 'Straße, PLZ Ort'), true);
    frow('E-Mail', field(p.email, { placeholder: 'name@beispiel.de', onInput: (v) => upd('email', v), width: '340px' }));
    frow('Telefon', field(p.phone, { placeholder: 'optional', onInput: (v) => upd('phone', v), width: '340px' }));
    frow('Grußformel / Unterschrift', area(p.signature, 3, (v) => upd('signature', v), 'z. B. „Mit freundlichen Grüßen“'), true);
    frow('Sprache für Schreiben', popup([['de', 'Deutsch'], ['tr', 'Türkisch'], ['auto', 'Wie die Anfrage']], p.language || 'de', (v) => upd('language', v), 'Sprache für Schreiben'));
    frow('Weitere Hinweise', area(p.notes, 2, (v) => upd('notes', v), 'z. B. Anrede-Stil, Branche'), true);
    const act = el('div', 'ap-actions');
    act.append(
      btn('Duplizieren', () => { const c = { ...p, id: newId(), label: (p.label || 'Profil') + ' (Kopie)' }; draft.profiles.push(c); selProfile = c.id; save({ profiles: draft.profiles }, true); render(); }),
      btn('Profil löschen …', () => {
        if (!confirm(`Profil „${p.label}“ löschen?`)) return;
        draft.profiles = draft.profiles.filter((x) => x.id !== p.id);
        const active = draft.activeProfile === p.id ? '' : draft.activeProfile;
        selProfile = (draft.profiles[0] && draft.profiles[0].id) || '';
        save({ profiles: draft.profiles, activeProfile: active }, true);
        render();
      }, 'red'),
    );
    body.appendChild(act);
  }

  // ---------- Internet und Agent ----------
  function tools(body) {
    hero(body, 'globe', '#30b0c7', 'Internet und Agent', 'Was die KI außerhalb des Chats darf. Jede Änderung und jeder Befehl braucht Dein „Erlauben“.');
    const t = section(body, 'Werkzeuge der KI');
    row(t, 'Internetsuche und Seiten lesen', 'Im Web suchen, Seiten lesen, Shop-Links bauen. Nur bei Modellen mit Werkzeugen (z. B. gpt-oss, Qwen).', toggle(draft.webTools, (v) => save({ webTools: v }), 'Internetsuche'));
    row(t, 'Agent: Dateien, Befehle und Git', 'Arbeitet im Arbeitsordner wie ein Programmierer. Jede Aktion wird vorher gezeigt und läuft nur nach „Erlauben“. GitHub richtest Du unter MCP ein.', toggle(draft.agentTools, (v) => save({ agentTools: v }), 'Agent'));

    const w = section(body, 'Arbeitsordner');
    const dirRow = row(w, draft.agentDir || 'Noch kein Ordner gewählt', 'Nur hier darf die KI Dateien lesen, schreiben und Befehle ausführen.');
    dirRow.querySelector('.ap-t').classList.add('mono');
    dirRow.insertBefore(tile('folder', '#0a84ff', 28), dirRow.firstChild);
    const dc = dirRow.querySelector('.ap-ctl');
    if (draft.agentDir) dc.appendChild(btn(isMac ? 'Im Finder zeigen' : 'Im Explorer zeigen', () => api.agent.openDir()));
    dc.appendChild(btn(draft.agentDir ? 'Ändern …' : 'Ordner wählen …', async () => { const n = await api.agent.pickDir(); draft.agentDir = n.agentDir; ctx.settings.agentDir = n.agentDir; render(); }));
    if (draft.agentDir) dc.appendChild(moreMenu([['Ordner entfernen', async () => { const n = await api.agent.clearDir(); draft.agentDir = n.agentDir; ctx.settings.agentDir = n.agentDir; render(); }, true]], 'Arbeitsordner'));
    const git = row(w, 'Git', null, el('span', 'ap-d', 'prüfe …'));
    const node = row(w, 'Node', 'Nur nötig, wenn die KI JavaScript-Projekte ausführen soll.', el('span', 'ap-d', 'prüfe …'));
    api.agent.check().then((r) => {
      const set = (rw, ok, miss) => { const c = rw.querySelector('.ap-ctl'); c.innerHTML = ''; c.appendChild(ok ? okBadge('Gefunden') : el('span', 'ap-warn', miss)); };
      set(git, r.git, isMac ? 'Fehlt – Xcode-Werkzeuge installieren' : 'Fehlt – „Git für Windows“ installieren');
      set(node, r.node, 'Nicht gefunden');
    }).catch(() => {});

    // ----- E-Mail -----
    const mail = section(body, 'E-Mail');
    row(mail, 'KI darf meine E-Mails lesen und (mit Bestätigung) senden', 'Jede Mail zum Senden siehst Du vorher und musst sie erlauben. Anhänge werden nicht gelesen.', toggle(draft.mailTools === true, (v) => save({ mailTools: v }), 'E-Mail für die KI'));
    const PRE = { gmail: ['imap.gmail.com', 993, 'smtp.gmail.com', 465], icloud: ['imap.mail.me.com', 993, 'smtp.mail.me.com', 587], outlook: ['outlook.office365.com', 993, 'smtp-mail.outlook.com', 587], gmx: ['imap.gmx.net', 993, 'mail.gmx.net', 587], webde: ['imap.web.de', 993, 'smtp.web.de', 587] };
    const provOf = () => Object.keys(PRE).find((k) => PRE[k][0] === draft.mailImapHost) || (draft.mailImapHost ? 'own' : '');
    const fImap = field(draft.mailImapHost, { width: '220px', onInput: (v) => save({ mailImapHost: v.trim() }) });
    const fImapP = field(draft.mailImapPort, { width: '64px', type: 'number', onInput: (v) => save({ mailImapPort: parseInt(v, 10) || 993 }) });
    const fSmtp = field(draft.mailSmtpHost, { width: '220px', onInput: (v) => save({ mailSmtpHost: v.trim() }) });
    const fSmtpP = field(draft.mailSmtpPort, { width: '64px', type: 'number', onInput: (v) => save({ mailSmtpPort: parseInt(v, 10) || 465 }) });
    row(mail, 'Anbieter', 'Gmail, iCloud und Outlook brauchen ein App-Passwort (nicht Dein normales Passwort).', popup([['', 'Bitte wählen …'], ['gmail', 'Gmail'], ['icloud', 'iCloud'], ['outlook', 'Outlook / Microsoft'], ['gmx', 'GMX'], ['webde', 'web.de'], ['own', 'Eigener Server']], provOf(), (v) => {
      const p = PRE[v]; if (!p) return;
      fImap.value = p[0]; fImapP.value = p[1]; fSmtp.value = p[2]; fSmtpP.value = p[3];
      save({ mailImapHost: p[0], mailImapPort: p[1], mailSmtpHost: p[2], mailSmtpPort: p[3] });
    }, 'Anbieter'));
    row(mail, 'E-Mail-Adresse', null, field(draft.mailUser, { placeholder: 'name@beispiel.de', width: '280px', onInput: (v) => save({ mailUser: v.trim() }) }));
    row(mail, 'Absender (optional)', null, field(draft.mailFrom, { placeholder: 'Name <name@beispiel.de>', width: '280px', onInput: (v) => save({ mailFrom: v.trim() }) }));
    const pwRow = row(mail, 'App-Passwort', 'Verschlüsselt gespeichert, nie an die KI gegeben.');
    const drawPw = (editing) => {
      const c = pwRow.querySelector('.ap-ctl'); c.innerHTML = '';
      if (draft.mailHasPassword && !editing) { c.append(okBadge('Gespeichert'), btn('Ändern …', () => drawPw(true))); return; }
      const f = field('', { type: 'password', placeholder: 'App-Passwort einfügen', width: '220px' });
      c.append(f, btn('Speichern', async () => { if (!f.value.trim()) return; const n = await api.mail.setPassword(f.value.trim()); draft.mailHasPassword = n.mailHasPassword; drawPw(false); }));
    };
    drawPw(false);
    const adv = el('details', 'ap-details');
    adv.appendChild(el('summary', null, 'Server-Einstellungen'));
    const advBox = el('div', 'ap-box');
    const imapRow = el('div', 'ap-row'); imapRow.append(el('label', 'ap-fl grow', 'Server zum Lesen (IMAP)'), fImap, fImapP);
    const smtpRow = el('div', 'ap-row'); smtpRow.append(el('label', 'ap-fl grow', 'Server zum Senden (SMTP)'), fSmtp, fSmtpP);
    advBox.append(imapRow, smtpRow);
    adv.appendChild(advBox);
    body.appendChild(adv);
    const test = el('div', 'ap-actions');
    const tmsg = el('span', 'ap-d grow', '');
    test.append(tmsg, btn('Verbindung testen', async () => {
      tmsg.textContent = 'Prüfe Anmeldung …';
      save({}, true);
      const r = await api.mail.test();
      tmsg.textContent = r.ok ? 'Anmeldung klappt.' : 'Nicht angemeldet: ' + r.error;
    }));
    body.appendChild(test);
  }

  // ---------- Sprache ----------
  function speech(body, st, vstat) {
    hero(body, 'wave', '#ff375f', 'Sprache', 'Diktieren und Vorlesen. Alles läuft lokal auf diesem Rechner, nach dem Download auch ohne Internet.');
    const vx = st.voxtral || {};
    const ph = st.phonon || { voices: [], langs: [] };

    // ----- Spracheingabe (Voxtral) -----
    const inp = section(body, 'Spracheingabe');
    const vxRow = row(inp, 'Voxtral Mini 4B Realtime', `${vx.approx || '3,6 GB'} · Apache 2.0 · 13 Sprachen, erkennt die Sprache selbst${isMac ? ' · belegt beim Diktieren etwa 4 GB Arbeitsspeicher' : ''}`);
    const vxCtl = vxRow.querySelector('.ap-ctl');
    const runVx = async () => {
      VX.running = true; VX.done = 'Wird geladen … (setzt einen abgebrochenen Download fort)'; render();
      const r = await api.voxtral.setup();
      VX.running = false; ctx.hideProgress();
      VX.done = r.ok ? `Fertig. Voxtral ist bereit (Start ${sec1(r.seconds)} s).` : 'Fehler: ' + r.error;
      render();
    };
    if (VX.running) vxCtl.append(el('span', 'ap-d', 'Lädt …'), btn('Abbrechen', () => api.voxtral.cancel()));
    else if (vx.ready) vxCtl.append(okBadge('Heruntergeladen'), moreMenu([['Neu laden / prüfen', runVx], ['Entfernen', async () => { if (!confirm('Voxtral (3,6 GB) löschen? Diktieren geht dann erst nach erneutem Laden.')) return; await api.voxtral.remove(); VX.done = 'Voxtral wurde entfernt.'; render(); }, true]], 'Voxtral'));
    else vxCtl.append(btn('Herunterladen', runVx, 'blue'));
    if (!vx.engine) vxRow.desc('Die Engine (llama-server) fehlt in dieser Installation.');
    if (VX.done) vxRow.desc(VX.done);

    const micSel = popup([['', isMac ? 'Standard des Systems' : 'Standard von Windows']], draft.micId || '', (v) => save({ micId: v }), 'Mikrofon');
    const micTest = btn('Testen', async () => {
      micTest.disabled = true; micRow.desc('Sprich jetzt …');
      try {
        const { startRecording } = await import('./audio.js');
        const r = await startRecording({ deviceId: draft.micId });
        setTimeout(() => r.stop(), 3000);
        const wav = await r.done;
        micRow.desc(r.peak < 0.006 ? 'Fast nur Stille. Falsches Mikrofon oder zu leise.' : `Signal da (Pegel ${Math.min(100, Math.round(r.peak * 400))} %). Du hörst Deine Aufnahme jetzt zur Kontrolle.`);
        if (wav) { const au = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))); await au.play().catch(() => {}); }
      } catch (e) { micRow.desc('Fehler: ' + (e.message || e)); }
      micTest.disabled = false;
    });
    const micRow = row(inp, 'Mikrofon', 'Bleibt die Wellenform beim Sprechen flach, ist das falsche Mikrofon gewählt.', micSel, micTest);
    (async () => {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true }); tmp.getTracks().forEach((t) => t.stop());
        const sel = micSel.querySelector('select');
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        devs.forEach((d) => { const o = el('option', null, d.label || 'Mikrofon'); o.value = d.deviceId; sel.appendChild(o); });
        sel.value = devs.some((d) => d.deviceId === draft.micId) ? draft.micId : '';
      } catch (e) { micRow.desc('Kein Zugriff auf das Mikrofon: ' + (e.message || e)); }
    })();
    row(inp, 'Diktierten Text sofort senden', 'Aus: Der Text erscheint zuerst im Eingabefeld.', toggle(draft.autoSend, (v) => save({ autoSend: v }), 'Diktierten Text sofort senden'));

    // ----- Sprachausgabe -----
    const out = section(body, 'Sprachausgabe');
    row(out, 'Antworten automatisch vorlesen', 'Auch über das Plus-Menü im Eingabefeld schaltbar. Ein Druck aufs Mikrofon unterbricht das Vorlesen.', toggle(draft.ttsAuto, (v) => save({ ttsAuto: v }), 'Antworten automatisch vorlesen'));
    const engine = !isMac && draft.ttsEngine === 'server' ? 'server' : 'phonon';
    if (!isMac) row(out, 'Stimmen-Motor', 'Türkischen Text liest die Windows-Stimme.', popup([['phonon', 'Phonon'], ['server', 'Meine Stimme (OuteTTS)']], engine, (v) => { save({ ttsEngine: v }, true); render(); }, 'Stimmen-Motor'));

    const phRow = row(out, 'Phonon – mehrsprachige Sprachausgabe', `${ph.approx || '75 MB'} · CC BY-NC 4.0 · Deutsch, Englisch, Französisch, Spanisch, Portugiesisch`);
    const phCtl = phRow.querySelector('.ap-ctl');
    const runPh = async () => {
      if (!draft.hfHasToken && !confirm('Es ist noch kein Hugging-Face-Token gespeichert (unten bei „Downloads“). Phonon ist geschützt und lässt sich ohne Token meist nicht laden. Trotzdem versuchen?')) return;
      PH.running = true; PH.done = ''; render();
      const r = await api.phonon.setup();
      PH.running = false; ctx.hideProgress();
      PH.done = r.ok ? `Fertig. Erster Testsatz: ${sec1(r.seconds)} s.` : 'Fehler: ' + r.error;
      if (r.ok) save({ ttsEngine: 'phonon' }, true);
      render();
    };
    if (PH.running) phCtl.append(el('span', 'ap-d', 'Lädt …'), btn('Abbrechen', () => api.phonon.cancel()));
    else if (ph.ready) phCtl.append(okBadge('Heruntergeladen'), moreMenu([['Neu laden / reparieren', runPh], ['Entfernen', async () => { if (!confirm('Phonon (Modell und Stimmen) löschen?')) return; await api.phonon.remove(); PH.done = 'Phonon wurde entfernt.'; render(); }, true]], 'Phonon'));
    else phCtl.append(btn('Herunterladen', runPh, 'blue'));
    if (!ph.binary) phRow.desc('Das Phonon-Programm fehlt in dieser Installation.');
    if (PH.done) phRow.desc(PH.done);

    if (engine === 'phonon') {
      row(out, 'Textsprache', 'Wird verwendet, um Zahlen und Datumsangaben vor der Sprachausgabe aufzubereiten.', popup([['auto', 'Deutsch'], ...(ph.langs || []).filter(([k]) => k !== 'de')], draft.ttsPhononLang || 'auto', (v) => save({ ttsPhononLang: v }), 'Textsprache'));
      const vsel = popup((ph.voices || []).map((v) => [v.key, v.name]), draft.ttsPhononVoice || 'anton', (v) => save({ ttsPhononVoice: v }), 'Stimme');
      const prev = btn('Vorschau', null);
      prev.insertAdjacentHTML('afterbegin', icon('speaker', 13));
      prev.disabled = !ph.ready;
      prev.onclick = async () => {
        prev.disabled = true;
        try {
          const wav = await api.phonon.preview({ voice: draft.ttsPhononVoice || 'anton', lang: draft.ttsPhononLang });
          const { playPreview } = await import('./audio.js');
          await playPreview(wav, draft.ttsSpeed || 1);
        } catch (e) { ctx.hint('Vorschau: ' + cleanErr(e), 0); }
        prev.disabled = false;
      };
      row(out, 'Stimme', null, vsel, prev);
    } else {
      // „Meine Stimme“ (OuteTTS, nur Windows)
      const sRow = row(out, 'Stimmprobe', draft.ttsSampleFile || 'Noch keine gewählt. Eine saubere Aufnahme von 10 bis 18 Sekunden (WAV) genügt.');
      sRow.querySelector('.ap-ctl').appendChild(btn('Aufnahme wählen …', async () => { const r = await api.speech.pickSample(); if (r) { draft.ttsSampleFile = r.name; sRow.desc(r.name); } }));
      const oRow = row(out, 'Meine Stimme (OuteTTS)', VU.running ? VU.text : (VU.done || (vstat.installed ? 'Eingerichtet.' : 'Einmalige Einrichtung, mehrere GB Download.')));
      oRow.querySelector('.ap-d').id = 'voiceProgText';
      const oc = oRow.querySelector('.ap-ctl');
      if (VU.running) oc.appendChild(btn('Abbrechen', () => api.voice.cancel()));
      else oc.appendChild(btn(vstat.installed ? 'Neu einrichten' : 'Einrichten', async () => {
        if (!draft.ttsSampleFile) { VU.done = 'Bitte zuerst eine Stimmprobe wählen.'; render(); return; }
        VU.running = true; VU.done = ''; VU.text = 'Starte …'; render();
        const r = await api.voice.setup();
        VU.running = false;
        VU.done = r.ok ? `Fertig (${r.device}). Testsatz: ${sec1(r.seconds)} s.` : 'Fehler: ' + r.error;
        if (r.settings) Object.assign(draft, r.settings);
        render();
      }, vstat.installed ? '' : 'blue'));
      if (vstat.oldFiles) row(out, 'Alte Dateien früherer Versionen', 'Mehrere GB Reste (Chatterbox, Grafikkarte).', btn('Löschen', async () => { await api.voice.cleanOld(); render(); }, 'red'));
    }
    row(out, 'Wiedergabegeschwindigkeit', null, popup([['0.75', '0,75×'], ['1', '1×'], ['1.25', '1,25×'], ['1.5', '1,5×']], String(draft.ttsSpeed || 1), (v) => save({ ttsSpeed: Number(v) }), 'Wiedergabegeschwindigkeit'));

    // ----- Downloads (Hugging-Face-Token) -----
    const dl = section(body, 'Downloads');
    const tRow = row(dl, 'Hugging-Face-Token', 'Verschlüsselt gespeichert, nur für Downloads (z. B. Phonon).');
    const drawTok = (editing, msg) => {
      const c = tRow.querySelector('.ap-ctl'); c.innerHTML = '';
      if (msg) tRow.desc(msg);
      if (draft.hfHasToken && !editing) {
        c.append(okBadge('Gespeichert'), btn('Ändern …', () => drawTok(true)), moreMenu([['Token entfernen', async () => { await api.hf.setToken(''); draft.hfHasToken = false; drawTok(false, 'Token entfernt.'); }, true]], 'Token'));
        return;
      }
      const f = field('', { type: 'password', placeholder: 'hf_…', width: '220px' });
      f.autocomplete = 'off';
      c.append(f, btn('Speichern', async () => {
        const r = await api.hf.setToken(f.value);
        if (r.ok) { draft.hfHasToken = !!f.value.trim(); drawTok(false, r.name ? `Gespeichert (Konto: ${r.name}).` : 'Entfernt.'); }
        else tRow.desc('Fehler: ' + r.error);
      }, 'blue'));
    };
    drawTok(false, draft.hfHasToken ? null : 'Für Phonon nötig: auf huggingface.co die Bedingungen von gradium/phonon-40m-multilingual akzeptieren, dann unter Settings → Access Tokens ein Token vom Typ „Lesen“ erstellen.');
  }

  // ---------- Standardwerte ----------
  function ai(body) {
    const sys = section(body, 'Grundanweisung an die KI', 'Gilt für jeden Chat. Die Angaben des aktiven Profils kommen automatisch dazu.');
    const r = el('div', 'ap-row');
    const ta = area(draft.systemPrompt, 5, (v) => save({ systemPrompt: v }));
    ta.classList.add('bare');
    ta.setAttribute('aria-label', 'Grundanweisung an die KI');
    r.appendChild(ta);
    sys.appendChild(r);

    const a = section(body, 'Antworten');
    const ctxOpts = [4096, 8192, 16384, 32768, 65536, 131072];
    const cur = parseInt(draft.numCtx, 10) || 16384;
    row(a, 'Kontextlänge', 'Mehr = längere PDFs, aber langsamer.', popup((ctxOpts.includes(cur) ? ctxOpts : [...ctxOpts, cur].sort((x, y) => x - y)).map((n) => [String(n), n.toLocaleString('de-DE') + ' Tokens']), String(cur), (v) => save({ numCtx: parseInt(v, 10) }), 'Kontextlänge'));
    const tr = el('span', 'ap-range');
    const sl = el('input'); sl.type = 'range'; sl.min = 0; sl.max = 2; sl.step = 0.1; sl.value = draft.temperature; sl.setAttribute('aria-label', 'Kreativität');
    sl.oninput = () => save({ temperature: Number(sl.value) });
    tr.append(el('span', 'ap-d', 'Sachlich'), sl, el('span', 'ap-d', 'Kreativ'));
    row(a, 'Kreativität', null, tr);
    const seg = el('span', 'ap-seg');
    seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Standard-Denktiefe');
    for (const [v, t] of [['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch']]) {
      const b = el('button', draft.think === v ? 'on' : '', t);
      b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(draft.think === v));
      b.onclick = () => { save({ think: v }); seg.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); };
      seg.appendChild(b);
    }
    row(a, 'Standard-Denktiefe', 'Bei Modellen mit Denken. Im Chat jederzeit änderbar.', seg);
    row(a, 'Modell im Speicher halten', 'Danach wird es entladen und beim nächsten Chat neu geladen.', popup([['5m', '5 Minuten'], ['30m', '30 Minuten'], ['2h', '2 Stunden'], ['-1', 'Immer']], draft.keepAlive, (v) => save({ keepAlive: v }), 'Modell im Speicher halten'));

    if (!isMac) {
      const hw = section(body, 'Dein Rechner', 'Für „Passt auf Deine Karte“ in Erkunden.');
      row(hw, 'Grafikspeicher', null, field(draft.vramGb, { type: 'number', width: '72px', onInput: (v) => save({ vramGb: Math.max(2, parseInt(v, 10) || 16) }) }), el('span', 'ap-d', 'GB'));
      row(hw, 'Arbeitsspeicher', null, field(draft.ramGb, { type: 'number', width: '72px', onInput: (v) => save({ ramGb: Math.max(4, parseInt(v, 10) || 32) }) }), el('span', 'ap-d', 'GB'));
    }
  }

  // ---------- Daten und Info ----------
  function data(body) {
    const h = el('div', 'ap-box ap-hero');
    const logo = el('img', 'ap-logo'); logo.src = 'logo.svg'; logo.alt = '';
    h.append(logo, el('div', 'ap-hero-t', 'FA KI Desktop'), el('div', 'ap-d', `Version ${info.version}`), el('div', 'ap-d', 'Alle Chats, Einstellungen und Profile liegen nur auf diesem Rechner.'));
    body.appendChild(h);
    const d = section(body, 'Daten');
    const dr = row(d, 'Datenordner', info.dataDir, btn(isMac ? 'Im Finder zeigen' : 'Im Explorer zeigen', () => api.app.openDataDir()));
    dr.querySelector('.ap-d').classList.add('mono');
    row(d, 'Alle Chats löschen', 'Entfernt alle Chats endgültig. Einstellungen und Modelle bleiben.', btn('Alle löschen …', async () => {
      if (!confirm('Wirklich ALLE Chats endgültig löschen?')) return;
      const n = await api.chats.clear();
      ctx.onChatsCleared();
      ctx.hint(`${n} Chats gelöscht.`);
    }, 'red'));
  }

  await render();
}
