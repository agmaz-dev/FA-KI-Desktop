import { el, $, icon, formRow, selectOf, input, textarea, switchRow, newId } from './ui.js';

// Aufbau wie bei Bionic: Gruppen links, „Erkunden“ und „Bibliothek“ stehen unter „Lokale Modelle“.
const GROUPS = [
  ['App', [['general', 'Allgemein', 'gear'], ['profiles', 'Profile', 'user']]],
  ['Assistent', [['tools', 'Internet und Agent', 'globe'], ['speech', 'Sprache', 'speaker']]],
  ['Lokale Modelle', [['library', 'Modelle', 'library'], ['ai', 'Standardwerte für lokale Modelle', 'sliders']]],
  ['System', [['data', 'Daten und Info', 'download']]],
];
const TAB_TITLE = { ...Object.fromEntries(GROUPS.flatMap(([, items]) => items.map(([id, label]) => [id, label]))), explore: 'Modelle', library: 'Modelle' };

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

/**
 * ctx: { settings, api, mount(build), close(), explore(root), library(root), apply(draft), hint, showProgress, hideProgress, onSaved(settings), speakSample(text, draft), onChatsCleared() }
 */
export async function openSettings(ctx, startTab = 'general') {
  const draft = JSON.parse(JSON.stringify(ctx.settings));
  if (!Array.isArray(draft.profiles)) draft.profiles = [];
  let tab = startTab;
  const hist = [startTab];
  let hpos = 0;
  const go = (id) => { if (id === tab) return; hist.length = hpos + 1; hist.push(id); hpos++; tab = id; render(); };
  let selProfile = draft.activeProfile || (draft.profiles[0] && draft.profiles[0].id) || '';

  const api = ctx.api;
  const [info] = await Promise.all([api.app.info()]);

  let vstat = { installed: false, busy: false };
  const ST = (window.__stUi = window.__stUi || { running: false, done: '' });
  const VU = (window.__voiceUi = window.__voiceUi || { text: '', pct: null, running: false, done: '' });
  if (!window.__voiceSub) {
    window.__voiceSub = api.voice.onProgress((p) => {
      VU.text = p.text || ''; VU.pct = p.pct;
      const t = document.getElementById('voiceProgText'); if (t) t.textContent = VU.text;
      const f = document.getElementById('voiceProgFill'); if (f) f.style.width = (VU.pct == null ? 5 : VU.pct) + '%';
    });
  }

  async function render() {
    const st = await api.speech.status();
    vstat = await api.voice.status();
    ctx.mount((m) => {
      const nav = el('div', 'set-nav');
      const back = el('button', 'back-btn');
      back.innerHTML = icon('arrowleft', 17) + '<span>Zurück zur App</span>';
      back.onclick = () => { ctx.apply(ctx.settings); ctx.close(); };
      nav.appendChild(back);
      nav.appendChild(el('h2', null, 'Einstellungen'));
      for (const [group, items] of GROUPS) {
        nav.appendChild(el('div', 'nav-group', group));
        for (const [id, label, ic] of items) {
          const b = el('button', id === tab || (id === 'library' && tab === 'explore') ? 'active' : '');
          b.innerHTML = icon(ic, 17) + '<span>' + label + '</span>';
          b.onclick = () => go(id);
          nav.appendChild(b);
        }
      }
      nav.appendChild(el('div', 'grow'));
      nav.appendChild(ctx.dlWidget());
      const main = el('div', 'set-main');
      const bar = el('div', 'set-bar');
      const prev = el('button', 'icon-btn'); prev.innerHTML = icon('chevleft', 16); prev.title = 'Zurück'; prev.disabled = hpos <= 0;
      const next = el('button', 'icon-btn'); next.innerHTML = icon('chevright', 16); next.title = 'Vorwärts'; next.disabled = hpos >= hist.length - 1;
      prev.onclick = () => { hpos--; tab = hist[hpos]; render(); };
      next.onclick = () => { hpos++; tab = hist[hpos]; render(); };
      bar.append(prev, next, el('div', 'set-bar-title', TAB_TITLE[tab] || ''));
      main.appendChild(bar);
      const isModels = tab === 'explore' || tab === 'library';
      const body = el('div', 'set-body' + (isModels ? ' flush' : ''));
      main.appendChild(body);
      const foot = el('div', 'set-foot');
      const saved = el('span', 'msg-saved', '');
      const cancel = el('button', 'btn', 'Zurück zur App');
      cancel.onclick = () => { ctx.apply(ctx.settings); ctx.close(); };
      const save = el('button', 'btn primary', 'Speichern');
      save.onclick = async () => {
        draft.numCtx = Math.max(2048, parseInt(draft.numCtx, 10) || 16384);
        draft.temperature = Math.min(2, Math.max(0, parseFloat(draft.temperature) || 0));
        const next = await api.settings.set(draft);
        saved.textContent = 'Gespeichert ✓';
        ctx.onSaved(next);
        setTimeout(() => { saved.textContent = ''; }, 2500);
      };
      foot.append(saved, cancel, save);
      if (!isModels) main.appendChild(foot);
      m.append(nav, main);

      if (isModels) {
        const strip = el('div', 'seg-tabs');
        for (const [id, label] of [['library', 'Meine Modelle'], ['explore', 'Auf Hugging Face suchen']]) {
          const b = el('button', id === tab ? 'active' : '', label);
          b.onclick = () => go(id);
          strip.appendChild(b);
        }
        body.appendChild(strip);
        const mroot = el('div', 'models-root');
        body.appendChild(mroot);
        if (tab === 'explore') ctx.explore(mroot); else ctx.library(mroot);
      }
      else ({ general, ai, tools, profiles, speech, data })[tab](body, st);
    });
  }

  const bind = (control, key, conv = (v) => v) => {
    const h = () => { draft[key] = conv(control.type === 'checkbox' ? control.checked : control.value); ctx.apply(draft); };
    control.addEventListener('input', h);
    control.addEventListener('change', h);
    return control;
  };

  const bindRender = (control, key) => { control.addEventListener('change', () => { draft[key] = control.value; render(); }); return control; };

  // ---------- Allgemein ----------
  function general(body) {
    body.appendChild(el('h2', null, 'Allgemein'));
    body.appendChild(formRow('Erscheinungsbild', bind(selectOf([['dark', 'Dunkel'], ['light', 'Hell']], draft.theme), 'theme')));
    const FONTS = ['Segoe UI Variable Text', 'Segoe UI', 'Arial', 'Calibri', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Cambria', 'Times New Roman', 'Palatino Linotype', 'Book Antiqua', 'Constantia', 'Consolas', 'Courier New', 'Comic Sans MS'];
    const dl = el('datalist'); dl.id = 'fontList'; FONTS.forEach((f) => { const o = el('option'); o.value = f; dl.appendChild(o); });
    body.appendChild(dl);
    const fontRow = (label, key, note) => {
      const inp = input('text', draft[key] || '', { placeholder: 'Schriftname, z. B. Arial' });
      inp.setAttribute('list', 'fontList');
      inp.addEventListener('input', () => { draft[key] = inp.value.trim(); ctx.apply(draft); });
      inp.addEventListener('focus', () => inp.select());
      const r = formRow(label, inp); r.appendChild(el('div', 'note', note)); r.style.marginTop = '14px';
      const sample = el('div', 'note', 'Der schnelle braune Fuchs springt über den faulen Hund 0123');
      const upd = () => { sample.style.fontFamily = `"${inp.value.replace(/["';{}<>\\]/g, '')}", sans-serif`; sample.style.fontSize = '15px'; };
      inp.addEventListener('input', upd); upd(); r.appendChild(sample);
      return r;
    };
    body.appendChild(fontRow('Schriftart der App', 'fontUi', 'Menüs, Listen und Einstellungen. Wähle aus der Liste oder tippe den Namen einer Schrift ein, die auf Deinem PC installiert ist.'));
    body.appendChild(fontRow('Schriftart der Antworten', 'fontAnswer', 'Chat-Antworten und Eingabe. Gleicher Name wie oben, falls Du überall dieselbe Schrift willst.'));
    const fs = input('range', draft.fontSize, { min: 13, max: 21, step: 1 });
    const fsl = el('div', 'note', `Textgröße: ${draft.fontSize} px`);
    fs.addEventListener('input', () => { draft.fontSize = Number(fs.value); fsl.textContent = `Textgröße: ${fs.value} px`; ctx.apply(draft); });
    const fr = formRow('Textgröße', fs); fr.appendChild(fsl); fr.style.marginTop = '14px';
    body.appendChild(fr);
    const se = switchRow('Enter sendet die Nachricht', 'Aus: Enter macht eine neue Zeile, gesendet wird mit Strg+Enter.', draft.sendOnEnter);
    bind(se.cb, 'sendOnEnter');
    body.appendChild(se.row);
    const sc = switchRow('Cloud-Modelle in der Liste anzeigen', 'Achtung: Cloud-Modelle senden Deine Daten an fremde Server. Besser aus lassen.', draft.showCloud);
    bind(sc.cb, 'showCloud');
    body.appendChild(sc.row);
  }

  // ---------- KI ----------
  function ai(body) {
    body.appendChild(el('h2', null, 'Standardwerte für lokale Modelle'));
    const sys = bind(textarea(draft.systemPrompt, 6), 'systemPrompt');
    body.appendChild(formRow('Grundanweisung an die KI', sys, 'Gilt für jeden Chat. Die Angaben des aktiven Profils werden automatisch dazugegeben.'));
    const two = el('div', 'two');
    two.appendChild(formRow('Kontextlänge (Tokens)', bind(input('number', draft.numCtx, { min: 2048, step: 1024 }), 'numCtx'), 'Mehr = längere PDFs, aber langsamer. 16384 ist ein guter Start.'));
    two.appendChild(formRow('Kreativität (Temperatur)', bind(input('number', draft.temperature, { min: 0, max: 2, step: 0.1 }), 'temperature'), '0 = sachlich, 1 = kreativ.'));
    body.appendChild(two);
    body.appendChild(formRow('Modell im Speicher halten', bind(selectOf([['5m', '5 Minuten'], ['30m', '30 Minuten'], ['2h', '2 Stunden'], ['-1', 'Immer']], draft.keepAlive), 'keepAlive'), 'Danach wird es aus dem Arbeitsspeicher entladen und beim nächsten Chat automatisch neu geladen.'));
    body.appendChild(formRow('Modellordner', el('div', 'note', 'Wird in der Bibliothek geändert (Erkunden → Bibliothek → Modellordner).'), ''));
    body.appendChild(formRow('Standard-Denktiefe', bind(selectOf([['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch']], draft.think), 'think'), 'Bei gpt-oss. Du kannst sie im Chat jederzeit ändern.'));

    body.appendChild(el('h3', null, 'Dein PC (für „Erkunden“)'));
    body.lastChild.style.margin = '22px 0 8px';
    const hw = el('div', 'two');
    hw.appendChild(formRow('Grafikspeicher (GB)', bind(input('number', draft.vramGb, { min: 2, max: 256, step: 1 }), 'vramGb', (v) => Math.max(2, parseInt(v, 10) || 16)), 'Damit „Erkunden“ zeigt, was ganz auf die Karte passt. RX 7800 XT: 16.'));
    hw.appendChild(formRow('Arbeitsspeicher (GB)', bind(input('number', draft.ramGb, { min: 4, max: 1024, step: 1 }), 'ramGb', (v) => Math.max(4, parseInt(v, 10) || 32)), 'Für Modelle, die nur teilweise auf die Karte passen.'));
    body.appendChild(hw);
  }

  // ---------- Internet und Agent ----------
  function tools(body) {
    body.appendChild(el('h2', null, 'Internet und Agent'));
    const wt = switchRow('Internetsuche und Seiten lesen', 'Die KI darf im Web suchen, Seiten lesen und Shop-Links (eBay, Kleinanzeigen …) bauen. Ohne Konto und ohne Schlüssel; die Anfragen gehen direkt von Deinem PC raus. Nur bei Modellen mit Werkzeug-Unterstützung (z. B. gpt-oss, Qwen).', draft.webTools);
    bind(wt.cb, 'webTools');
    body.appendChild(wt.row);
    const gt = switchRow('GitHub lesen', 'Die KI darf Deine Repos, Dateien und Builds auf GitHub lesen.', draft.githubTools);
    bind(gt.cb, 'githubTools');
    body.appendChild(gt.row);
    const at = switchRow('Agent: Dateien, Befehle, Git und GitHub schreiben', 'Die KI arbeitet wie ein Programmierer: Dateien im Arbeitsordner lesen und ändern, Befehle und Tests ausführen, mit Git und GitHub arbeiten (Repos, Dateien, Branches, Pull Requests, Issues). Jede Änderung und jeder Befehl wird Dir vorher gezeigt und läuft nur nach Deinem „Erlauben“. Kein Löschen von Repos.', draft.agentTools);
    bind(at.cb, 'agentTools');
    body.appendChild(at.row);

    body.appendChild(el('h3', null, 'Arbeitsordner'));
    body.lastChild.style.margin = '22px 0 8px';
    const dirNote = el('div', null, draft.agentDir || 'Noch kein Ordner gewählt.');
    dirNote.style.cssText = 'font-family:Consolas,monospace;font-size:13.5px;word-break:break-all;margin-bottom:6px';
    body.appendChild(dirNote);
    body.appendChild(el('div', 'note', 'Nur in diesem Ordner darf die KI Dateien lesen, schreiben und Befehle ausführen. Wähle den Ordner Deines Projekts (oder einen leeren für ein neues).'));
    const dr = el('div'); dr.style.cssText = 'display:flex;gap:8px;margin:8px 0 4px;flex-wrap:wrap';
    const pick = el('button', 'btn small', draft.agentDir ? 'Anderen Ordner wählen …' : 'Ordner wählen …');
    pick.onclick = async () => { const n = await api.agent.pickDir(); draft.agentDir = n.agentDir; ctx.settings.agentDir = n.agentDir; render(); };
    dr.appendChild(pick);
    if (draft.agentDir) {
      const op = el('button', 'btn small', 'Ordner öffnen'); op.onclick = () => api.agent.openDir();
      const cl = el('button', 'btn small', 'Ordner entfernen'); cl.onclick = async () => { const n = await api.agent.clearDir(); draft.agentDir = n.agentDir; ctx.settings.agentDir = n.agentDir; render(); };
      dr.append(op, cl);
    }
    body.appendChild(dr);
    const chk = el('div', 'note', 'Prüfe Git und Node …');
    body.appendChild(chk);
    api.agent.check().then((r) => {
      chk.textContent = (r.git ? 'Git gefunden: ' + r.git : 'Git nicht gefunden – für die Git-Werkzeuge bitte „Git für Windows“ von git-scm.com installieren.') + '   ' + (r.node ? 'Node gefunden: ' + r.node : 'Node nicht gefunden (nur nötig, wenn die KI JavaScript-Projekte ausführen soll).');
    }).catch(() => { chk.textContent = ''; });

    body.appendChild(el('h3', null, 'GitHub-Zugang'));
    body.lastChild.style.margin = '22px 0 8px';
    const tok = input('password', '', { placeholder: draft.githubHasToken ? 'Token ist gespeichert (zum Ersetzen neuen eintragen)' : 'GitHub-Token einfügen', autocomplete: 'off' });
    body.appendChild(formRow('GitHub-Token', tok, 'Auf github.com unter Settings → Developer settings → Personal access tokens erzeugen. Zum Lesen reicht „Contents: Read-only“. Damit die KI auch schreiben darf (Repos anlegen, pushen, Pull Requests): klassisch Haken „repo“ und „workflow“, oder fein „Contents“, „Pull requests“, „Issues“, „Actions“ auf „Read and write“ und „Administration“ zum Anlegen von Repos. Der Token wird verschlüsselt auf diesem PC gespeichert und nie an die KI gegeben. Für öffentliche Repos zum Lesen brauchst Du keinen.'));
    const tstat = el('div', 'note', draft.githubHasToken ? 'Ein Token ist gespeichert.' : 'Kein Token gespeichert.');
    const row = el('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';
    const saveTok = el('button', 'btn small', 'Token speichern und prüfen');
    saveTok.onclick = async () => {
      const v = tok.value.trim();
      if (!v) { tstat.textContent = 'Bitte zuerst einen Token einfügen.'; return; }
      tstat.textContent = 'Prüfe …';
      const r = await api.github.setToken(v);
      if (r.ok) { tok.value = ''; draft.githubHasToken = true; tstat.textContent = 'Gespeichert. Angemeldet als ' + (r.login || '?') + '.'; }
      else tstat.textContent = 'Nicht gespeichert: ' + r.error;
    };
    const delTok = el('button', 'btn small', 'Token entfernen');
    delTok.onclick = async () => { await api.github.setToken(''); draft.githubHasToken = false; tstat.textContent = 'Token entfernt.'; };
    row.append(saveTok, delTok);
    body.appendChild(row);
    body.appendChild(tstat);

    // ----- E-Mail -----
    body.appendChild(el('h3', null, 'E-Mail'));
    body.lastChild.style.margin = '26px 0 8px';
    const mt = switchRow('KI darf meine E-Mails lesen und (mit Bestätigung) senden', 'Lesen und Suchen im Posteingang geht ohne Nachfrage. Jede Mail zum Senden siehst Du vorher mit Empfänger und Text und musst sie jedes Mal erlauben. Anhänge werden nicht gelesen. Mailtexte sind für die KI nur Daten, keine Anweisungen.', draft.mailTools === true);
    bind(mt.cb, 'mailTools');
    body.appendChild(mt.row);
    const prov = selectOf([['', 'Anbieter wählen …'], ['gmail', 'Gmail'], ['icloud', 'iCloud'], ['outlook', 'Outlook / Microsoft'], ['gmx', 'GMX'], ['webde', 'web.de'], ['own', 'Eigener Server']], '');
    const PRE = { gmail: ['imap.gmail.com', 993, 'smtp.gmail.com', 465], icloud: ['imap.mail.me.com', 993, 'smtp.mail.me.com', 587], outlook: ['outlook.office365.com', 993, 'smtp-mail.outlook.com', 587], gmx: ['imap.gmx.net', 993, 'mail.gmx.net', 587], webde: ['imap.web.de', 993, 'smtp.web.de', 587] };
    const fImap = bind(input('text', draft.mailImapHost), 'mailImapHost');
    const fImapP = bind(input('number', draft.mailImapPort, { min: 1, max: 65535 }), 'mailImapPort', (v) => parseInt(v, 10) || 993);
    const fSmtp = bind(input('text', draft.mailSmtpHost), 'mailSmtpHost');
    const fSmtpP = bind(input('number', draft.mailSmtpPort, { min: 1, max: 65535 }), 'mailSmtpPort', (v) => parseInt(v, 10) || 465);
    prov.addEventListener('change', () => {
      const p = PRE[prov.value]; if (!p) return;
      fImap.value = p[0]; fImapP.value = p[1]; fSmtp.value = p[2]; fSmtpP.value = p[3];
      for (const [c, k, v] of [[fImap, 'mailImapHost', p[0]], [fImapP, 'mailImapPort', p[1]], [fSmtp, 'mailSmtpHost', p[2]], [fSmtpP, 'mailSmtpPort', p[3]]]) draft[k] = v;
    });
    body.appendChild(formRow('Anbieter', prov, 'Füllt die Serverangaben aus. Gmail, iCloud und Outlook brauchen ein App-Passwort (nicht Dein normales Passwort).'));
    const mtwo = el('div', 'two');
    mtwo.appendChild(formRow('E-Mail-Adresse (Anmeldename)', bind(input('text', draft.mailUser), 'mailUser')));
    mtwo.appendChild(formRow('Absender (optional)', bind(input('text', draft.mailFrom), 'mailFrom'), 'z. B. Feridun Agmaz <name@example.de>'));
    body.appendChild(mtwo);
    const m2 = el('div', 'two');
    m2.appendChild(formRow('Server zum Lesen (IMAP)', fImap));
    m2.appendChild(formRow('Port', fImapP));
    body.appendChild(m2);
    const m3 = el('div', 'two');
    m3.appendChild(formRow('Server zum Senden (SMTP)', fSmtp));
    m3.appendChild(formRow('Port', fSmtpP, '465 oder 587'));
    body.appendChild(m3);
    const mpw = input('password', '', { placeholder: draft.mailHasPassword ? 'Passwort ist gespeichert (zum Ersetzen neues eintragen)' : 'App-Passwort einfügen', autocomplete: 'off' });
    body.appendChild(formRow('App-Passwort', mpw, 'Wird verschlüsselt auf diesem PC gespeichert und nie an die KI gegeben.'));
    const mrow = el('div', 'chips-row');
    const mstat = el('div', 'note', '');
    const msave = el('button', 'btn small primary', 'Speichern und testen');
    msave.onclick = async () => {
      mstat.textContent = 'Prüfe Anmeldung …';
      await api.settings.set({ mailUser: draft.mailUser, mailFrom: draft.mailFrom, mailImapHost: draft.mailImapHost, mailImapPort: draft.mailImapPort, mailSmtpHost: draft.mailSmtpHost, mailSmtpPort: draft.mailSmtpPort });
      if (mpw.value.trim()) { await api.mail.setPassword(mpw.value.trim()); mpw.value = ''; draft.mailHasPassword = true; }
      const r = await api.mail.test();
      mstat.textContent = r.ok ? 'Anmeldung klappt. Du kannst die KI jetzt nach Deinen Mails fragen (Schalter oben aktivieren und unten auf „Speichern“).' : 'Nicht angemeldet: ' + r.error;
    };
    const mdel = el('button', 'btn small', 'Passwort entfernen');
    mdel.onclick = async () => { await api.mail.setPassword(''); draft.mailHasPassword = false; mstat.textContent = 'Passwort entfernt.'; };
    mrow.append(msave, mdel);
    body.appendChild(mrow);
    body.appendChild(mstat);
  }

  // ---------- Profile ----------
  function profiles(body) {
    body.appendChild(el('h2', null, 'Profile'));
    body.appendChild(el('div', 'note', 'Ein Profil enthält Absenderangaben (Name, Adresse, Unterschrift …). Wenn Du ein Profil wählst, benutzt die KI diese Angaben beim Schreiben von Briefen, E-Mails und Dokumenten. Du kannst mehrere Profile anlegen, auch für andere Personen.'));
    body.lastChild.style.marginBottom = '14px';
    const lay = el('div', 'prof-layout');
    const list = el('div', 'prof-list');
    for (const p of draft.profiles) {
      const b = el('button', 'prof-item' + (p.id === selProfile ? ' active' : ''));
      b.appendChild(el('span', null, p.label || 'Ohne Namen'));
      b.appendChild(el('small', null, (p.id === draft.activeProfile ? 'aktiv · ' : '') + (p.fullName || '')));
      b.onclick = () => { selProfile = p.id; render(); };
      list.appendChild(b);
    }
    const add = el('button', 'btn small', '+ Neues Profil');
    add.style.marginTop = '6px';
    add.onclick = () => {
      const p = { id: newId(), label: 'Neues Profil', fullName: '', company: '', address: '', email: '', phone: '', signature: '', language: 'de', notes: '' };
      draft.profiles.push(p);
      selProfile = p.id;
      if (!draft.activeProfile) draft.activeProfile = p.id;
      render();
    };
    list.appendChild(add);
    lay.appendChild(list);

    const p = draft.profiles.find((x) => x.id === selProfile);
    const ed = el('div');
    if (!p) {
      ed.appendChild(el('div', 'note', 'Noch kein Profil vorhanden. Lege links Dein erstes Profil an, zum Beispiel „Privat“ oder „Firma“.'));
    } else {
      const f = (key, label, ta, note) => {
        const c = ta ? textarea(p[key], ta) : input('text', p[key]);
        c.addEventListener('input', () => { p[key] = c.value; });
        if (key === 'label' || key === 'fullName') c.addEventListener('change', () => render());
        return formRow(label, c, note);
      };
      ed.appendChild(f('label', 'Profilname', 0, 'z. B. Privat, Firma, Emine'));
      const two = el('div', 'two');
      two.appendChild(f('fullName', 'Vollständiger Name'));
      two.appendChild(f('company', 'Firma / Organisation'));
      ed.appendChild(two);
      ed.appendChild(f('address', 'Adresse', 3));
      const two2 = el('div', 'two');
      two2.appendChild(f('email', 'E-Mail'));
      two2.appendChild(f('phone', 'Telefon'));
      ed.appendChild(two2);
      ed.appendChild(f('signature', 'Grußformel / Unterschrift', 3, 'z. B. „Mit freundlichen Grüßen“ und Dein Name'));
      const lang = selectOf([['de', 'Deutsch'], ['tr', 'Türkisch'], ['auto', 'Wie die Anfrage']], p.language || 'de');
      lang.addEventListener('change', () => { p.language = lang.value; });
      ed.appendChild(formRow('Sprache für Schreiben', lang));
      ed.appendChild(f('notes', 'Weitere Hinweise', 3, 'z. B. Anrede-Stil, Branche, was die KI beachten soll'));
      const act = el('div', 'chips-row');
      const mk = el('button', 'btn small', p.id === draft.activeProfile ? 'Ist aktiv ✓' : 'Als aktiv setzen');
      mk.onclick = () => { draft.activeProfile = p.id; render(); };
      const dup = el('button', 'btn small', 'Duplizieren');
      dup.onclick = () => { const c = { ...p, id: newId(), label: (p.label || 'Profil') + ' (Kopie)' }; draft.profiles.push(c); selProfile = c.id; render(); };
      const del = el('button', 'btn small danger', 'Löschen');
      del.onclick = () => {
        if (!confirm(`Profil „${p.label}“ löschen?`)) return;
        draft.profiles = draft.profiles.filter((x) => x.id !== p.id);
        if (draft.activeProfile === p.id) draft.activeProfile = '';
        selProfile = (draft.profiles[0] && draft.profiles[0].id) || '';
        render();
      };
      act.append(mk, dup, del);
      ed.appendChild(act);
    }
    lay.appendChild(ed);
    body.appendChild(lay);
  }

  // ---------- Sprache ----------
  function speech(body, st) {
    body.appendChild(el('h2', null, 'Sprache'));
    body.appendChild(formRow('Stimme beim Vorlesen', bind(selectOf([['auto', 'Automatisch (Deutsch/Türkisch)'], ['de', 'Immer Deutsch'], ['tr', 'Immer Türkisch'], ['windows', 'Nur Windows-Stimme']], draft.ttsVoice), 'ttsVoice')));
    const sp = input('range', draft.ttsSpeed, { min: 0.7, max: 1.5, step: 0.05 });
    const spl = el('div', 'note', `Tempo: ${Number(draft.ttsSpeed).toFixed(2).replace('.', ',')}×`);
    sp.addEventListener('input', () => { draft.ttsSpeed = Number(sp.value); spl.textContent = `Tempo: ${Number(sp.value).toFixed(2).replace('.', ',')}×`; });
    const spr = formRow('Sprechtempo', sp); spr.appendChild(spl);
    body.appendChild(spr);
    const stc = el('div', 'voice-card');
    stc.appendChild(el('h3', null, 'Supertonic – schnelle, natürliche Stimmen (Deutsch und Türkisch)'));
    stc.appendChild(el('div', 'note', 'Läuft direkt in der App, ganz ohne Zusatzprogramme, spricht flüssig und braucht wenig Speicher. Einmaliger Download von ca. 250 MB.'));
    const stState = st.supertonic || { ready: false, voices: {} };
    const stVoice = selectOf([['elena', 'Elena (weiblich)'], ['tessa', 'Tessa (weiblich)'], ['caleb', 'Caleb (männlich)']], draft.ttsStVoice || 'elena');
    stVoice.addEventListener('change', async () => { draft.ttsStVoice = stVoice.value; await api.settings.set({ ttsStVoice: stVoice.value }); });
    stc.appendChild(formRow('Stimme', stVoice));
    const stNote = el('div', 'note', ST.done || (stState.ready ? 'Supertonic ist eingerichtet.' : 'Noch nicht eingerichtet.'));
    const stBtn = el('button', 'btn small primary', stState.ready ? 'Neu laden / reparieren' : 'Supertonic einrichten');
    const stCancel = el('button', 'btn small', 'Abbrechen');
    stCancel.style.display = ST.running ? '' : 'none';
    stBtn.disabled = ST.running;
    stCancel.onclick = () => api.supertonic.cancel();
    stBtn.onclick = async () => {
      ST.running = true; ST.done = 'Wird geladen …';
      render();
      await api.settings.set({ ttsStVoice: draft.ttsStVoice || 'elena' });
      const r = await api.supertonic.setup();
      ST.running = false;
      ctx.hideProgress();
      if (r.ok) {
        Object.assign(draft, r.settings);
        ST.done = `Fertig. Erster Testsatz: ${Number(r.seconds).toFixed(1).replace('.', ',')} s. Supertonic ist jetzt aktiv, Tempo auf 1× gestellt. Klick unten auf „Speichern“.`;
      } else ST.done = 'Fehler: ' + r.error + ' Es spricht die Windows-Stimme.';
      render();
    };
    const stRow = el('div', 'chips-row'); stRow.append(stBtn, stCancel);
    stc.append(stRow, stNote);
    stc.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:6px 0 16px';
    body.appendChild(stc);
    const vc = el('div', 'voice-card');
    vc.appendChild(el('h3', null, 'Meine Stimme (OuteTTS, Deutsch)'));
    vc.appendChild(el('div', 'note', 'Klingt nach Deiner Aufnahme und läuft ganz auf diesem PC. Die Einrichtung ist einmalig (mehrere GB Download). Türkisch spricht Supertonic.'));
    const sInfo = el('div', 'note', draft.ttsSampleFile ? 'Stimmprobe: ' + draft.ttsSampleFile : 'Noch keine Stimmprobe gewählt. Eine saubere Aufnahme von 10 bis 18 Sekunden (WAV) genügt.');
    const bSample = el('button', 'btn small', 'Aufnahme wählen …');
    bSample.onclick = async () => { const r = await api.speech.pickSample(); if (r) { draft.ttsSampleFile = r.name; sInfo.textContent = 'Stimmprobe: ' + r.name; } };
    const bOute = el('button', 'btn small primary', vstat.installed ? 'Neu einrichten / reparieren' : 'Meine Stimme einrichten');
    const bCancel = el('button', 'btn small', 'Abbrechen');
    const pt = el('div', 'note', VU.running ? VU.text : (VU.done || (vstat.installed ? 'Meine Stimme ist eingerichtet.' : '')));
    pt.id = 'voiceProgText';
    const bar = el('div', 'bar'); const fill = el('div'); fill.id = 'voiceProgFill'; fill.style.cssText = 'height:100%;background:var(--accent);width:' + (VU.pct == null ? 5 : VU.pct) + '%'; bar.appendChild(fill);
    bar.style.display = VU.running ? '' : 'none';
    bCancel.style.display = VU.running ? '' : 'none';
    bOute.disabled = VU.running;
    bCancel.onclick = () => api.voice.cancel();
    const runSetup = async () => {
      // Ohne Stimmprobe kann OuteTTS nicht sprechen: vor dem großen Download (mehrere GB) prüfen.
      if (!draft.ttsSampleFile) {
        VU.done = 'Bitte zuerst über „Aufnahme wählen …“ eine Stimmprobe (10–18 Sekunden, WAV) auswählen. Ohne Aufnahme kann „Meine Stimme“ nicht sprechen.';
        render();
        return;
      }
      VU.running = true; VU.done = ''; VU.text = 'Starte …'; VU.pct = 0;
      await api.settings.set({ ttsSampleFile: draft.ttsSampleFile });
      render();
      const r = await api.voice.setup();
      VU.running = false;
      const f = (x) => Number(x).toFixed(1).replace('.', ',');
      if (r.settings) Object.assign(draft, { ttsEngine: r.settings.ttsEngine, ttsServerUrl: r.settings.ttsServerUrl, ttsServerDir: r.settings.ttsServerDir, ttsServerCmd: r.settings.ttsServerCmd, ttsServerAuto: r.settings.ttsServerAuto, ttsServerModel: r.settings.ttsServerModel, ttsServerLangs: r.settings.ttsServerLangs });
      if (r.ok) VU.done = `Fertig (${r.device}). Erster Testsatz: ${f(r.cold)} s, zweiter: ${f(r.seconds)} s. Klick unten auf „Speichern“.`;
      else VU.done = 'Fehler: ' + r.error + ' Es spricht die Windows-Stimme.';
      render();
    };
    bOute.onclick = runSetup;
    const vrow = el('div', 'chips-row'); vrow.append(bSample, bOute, bCancel);
    vc.append(sInfo, vrow, bar, pt);
    if (vstat.oldFiles) {
      const bOld = el('button', 'btn small', 'Alte Dateien löschen (Chatterbox, Grafikkarte)');
      bOld.onclick = async () => { await api.voice.cleanOld(); VU.done = 'Alte Dateien gelöscht.'; render(); };
      vc.appendChild(el('div', 'note', 'Von früheren Versionen liegen noch mehrere GB Reste auf dem PC.'));
      vc.appendChild(bOld);
    }
    vc.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:6px 0 16px';
    body.appendChild(vc);
    body.appendChild(formRow('Stimmen-Motor', bindRender(selectOf([['supertonic', 'Supertonic (Elena, Tessa, Caleb – Deutsch und Türkisch)'], ['server', 'Meine Stimme (OuteTTS, Deutsch)']], draft.ttsEngine === 'server' ? 'server' : 'supertonic'), 'ttsEngine'), 'Bei „Meine Stimme“ spricht Supertonic automatisch Türkisch und springt ein, falls OuteTTS nicht bereit ist.'));
    const test = el('button', 'btn small', 'Stimme testen');
    test.onclick = () => ctx.speakSample('Hallo! Das ist meine Stimme. Ich lese Dir Antworten und Texte vor.', draft);
    const stopT = el('button', 'btn small', 'Stopp');
    stopT.onclick = () => ctx.stopSpeaking();
    const tr = el('div', 'chips-row'); tr.append(test, stopT);
    body.appendChild(tr);

    // ----- Spracherkennung (Whisper) -----
    body.appendChild(el('h3', null, 'Spracherkennung (Whisper)'));
    const wc = el('div', 'voice-card');
    wc.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:6px 0 16px';
    wc.appendChild(el('div', 'note', 'Wandelt Gesprochenes in Text um, für das Diktieren und den Gesprächsmodus. Läuft ganz auf diesem PC. Der Bildschirm bleibt dabei bedienbar.'));
    const wmodel = draft.sttModel in st.info.whisperModels ? draft.sttModel : 'medium';
    const names = { base: 'Schnell', small: 'Ausgewogen', medium: 'Genau' };
    const wsel = selectOf(Object.keys(st.info.whisperModels).map((k) => [k, `${k[0].toUpperCase() + k.slice(1)} · ${names[k] || ''} (${st.info.whisperModels[k].approx})${st.whisperModels[k] ? ' – geladen' : ''}`]), wmodel);
    wsel.addEventListener('change', () => { draft.sttModel = wsel.value; render(); });
    const wtwo = el('div', 'two');
    wtwo.appendChild(formRow('Modell', wsel, 'Medium ist am genauesten, besonders bei Türkisch und Dialekt.'));
    wtwo.appendChild(formRow('Sprache beim Diktieren', bind(selectOf([['de', 'Deutsch'], ['tr', 'Türkisch'], ['auto', 'Automatisch erkennen']], draft.sttLang), 'sttLang')));
    wc.appendChild(wtwo);
    const micSel = selectOf([['', 'Standard von Windows']], draft.micId || '');
    micSel.addEventListener('change', () => { draft.micId = micSel.value; });
    const micRow = formRow('Mikrofon', micSel, 'Wähle hier Dein Mikrofon, falls beim Diktieren nichts oder nur „Musik“ erkannt wird.');
    const micLvl = el('div', 'note', '');
    micRow.appendChild(micLvl);
    const micTest = el('button', 'btn small', 'Mikrofon testen (3 Sekunden)');
    micTest.style.marginTop = '8px';
    micRow.appendChild(micTest);
    (async () => {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true }); tmp.getTracks().forEach((t) => t.stop());
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        devs.forEach((d) => { const o = el('option', null, d.label || 'Mikrofon'); o.value = d.deviceId; micSel.appendChild(o); });
        micSel.value = devs.some((d) => d.deviceId === draft.micId) ? draft.micId : '';
      } catch (e) { micLvl.textContent = 'Kein Zugriff auf das Mikrofon: ' + (e.message || e); }
    })();
    micTest.onclick = async () => {
      micTest.disabled = true; micLvl.textContent = 'Sprich jetzt …';
      try {
        const { startRecording } = await import('./audio.js');
        const r = await startRecording({ deviceId: micSel.value });
        setTimeout(() => r.stop(), 3000);
        await r.done;
        micLvl.textContent = r.peak < 0.006 ? 'Fast nur Stille. Falsches Mikrofon oder zu leise.' : `Signal da (Pegel ${Math.min(100, Math.round(r.peak * 400))} %). Das Mikrofon funktioniert.`;
      } catch (e) { micLvl.textContent = 'Fehler: ' + (e.message || e); }
      micTest.disabled = false;
    };
    wc.appendChild(micRow);
    const ready = !!(st.whisperBinary && st.whisperModels[wmodel]);
    const wrow = el('div', 'chips-row');
    wrow.style.alignItems = 'center';
    wrow.appendChild(el('span', 'badge ' + (ready ? 'ok' : 'warn'), ready ? 'bereit' : 'fehlt'));
    const wb = el('button', 'btn small' + (ready ? '' : ' primary'), ready ? 'Neu laden' : 'Einrichten');
    wb.onclick = async () => {
      wb.disabled = true;
      try { await api.speech.prepareStt(wmodel); ctx.hideProgress(); ctx.hint('Fertig: Spracherkennung (' + wmodel + ')', 5000); }
      catch (e) { ctx.hideProgress(); ctx.hint('Spracherkennung: ' + (e.message || e), 0); }
      render();
    };
    wrow.appendChild(wb);
    wc.appendChild(wrow);
    body.appendChild(wc);
    const as = switchRow('Diktierten Text sofort senden', 'Aus: der Text erscheint zuerst im Eingabefeld.', draft.autoSend);
    bind(as.cb, 'autoSend');
    body.appendChild(as.row);
    const ta = switchRow('Antworten automatisch vorlesen', 'Auch über das Lautsprecher-Symbol unter dem Eingabefeld schaltbar.', draft.ttsAuto);
    bind(ta.cb, 'ttsAuto');
    body.appendChild(ta.row);
  }

  // ---------- Daten ----------
  function data(body) {
    body.appendChild(el('h2', null, 'Daten und Info'));
    body.appendChild(el('div', 'note', 'Alle Chats, Einstellungen und Profile liegen nur auf diesem PC.'));
    const open = el('button', 'btn', 'Datenordner öffnen');
    open.onclick = () => api.app.openDataDir();
    const clr = el('button', 'btn danger', 'Alle Chats löschen');
    clr.onclick = async () => {
      if (!confirm('Wirklich ALLE Chats endgültig löschen?')) return;
      const n = await api.chats.clear();
      ctx.onChatsCleared();
      ctx.hint(`${n} Chats gelöscht.`);
    };
    const row = el('div', 'chips-row'); row.style.margin = '14px 0'; row.append(open, clr);
    body.appendChild(row);
    body.appendChild(el('h3', null, 'Info'));
    body.appendChild(el('div', null, `FA KI Desktop, Version ${info.version}`));
    body.appendChild(el('div', 'note', info.dataDir));
  }

  await render();
}
