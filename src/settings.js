import { el, $, icon, openModal, closeModal, formRow, selectOf, input, textarea, switchRow, newId } from './ui.js';

const TABS = [
  ['general', 'Allgemein', 'sliders'],
  ['ai', 'KI und Modell', 'cpu'],
  ['profiles', 'Profile', 'user'],
  ['speech', 'Sprache', 'speaker'],
  ['data', 'Daten und Info', 'download'],
];

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
 * ctx: { settings, api, apply(draft), hint, showProgress, hideProgress, onSaved(settings), speakSample(text, draft), onChatsCleared() }
 */
export async function openSettings(ctx, startTab = 'general') {
  const draft = JSON.parse(JSON.stringify(ctx.settings));
  if (!Array.isArray(draft.profiles)) draft.profiles = [];
  let tab = startTab;
  let selProfile = draft.activeProfile || (draft.profiles[0] && draft.profiles[0].id) || '';

  const api = ctx.api;
  const [info] = await Promise.all([api.app.info()]);

  async function render() {
    const st = await api.speech.status();
    openModal((m) => {
      const nav = el('div', 'set-nav');
      nav.appendChild(el('h2', null, 'Einstellungen'));
      for (const [id, label, ic] of TABS) {
        const b = el('button', id === tab ? 'active' : '');
        b.innerHTML = icon(ic, 17) + '<span>' + label + '</span>';
        b.onclick = () => { tab = id; render(); };
        nav.appendChild(b);
      }
      const main = el('div', 'set-main');
      const body = el('div', 'set-body');
      main.appendChild(body);
      const foot = el('div', 'set-foot');
      const saved = el('span', 'msg-saved', '');
      const cancel = el('button', 'btn', 'Schließen');
      cancel.onclick = () => { ctx.apply(ctx.settings); closeModal(); };
      const save = el('button', 'btn primary', 'Speichern');
      save.onclick = async () => {
        draft.numCtx = Math.max(2048, parseInt(draft.numCtx, 10) || 16384);
        draft.temperature = Math.min(2, Math.max(0, parseFloat(draft.temperature) || 0));
        draft.ollamaUrl = (draft.ollamaUrl || '').trim() || 'http://127.0.0.1:11434';
        const next = await api.settings.set(draft);
        saved.textContent = 'Gespeichert ✓';
        ctx.onSaved(next);
        setTimeout(() => { saved.textContent = ''; }, 2500);
      };
      foot.append(saved, cancel, save);
      main.appendChild(foot);
      m.append(nav, main);

      ({ general, ai, profiles, speech, data })[tab](body, st);
    }, { wide: true });
  }

  const bind = (control, key, conv = (v) => v) => {
    const h = () => { draft[key] = conv(control.type === 'checkbox' ? control.checked : control.value); ctx.apply(draft); };
    control.addEventListener('input', h);
    control.addEventListener('change', h);
    return control;
  };

  // ---------- Allgemein ----------
  function general(body) {
    body.appendChild(el('h2', null, 'Allgemein'));
    body.appendChild(formRow('Erscheinungsbild', bind(selectOf([['system', 'Wie Windows'], ['light', 'Hell'], ['dark', 'Dunkel']], draft.theme), 'theme')));
    const sf = switchRow('Antworten in Serifenschrift', 'Wie bei Claude: die KI-Antworten erscheinen in einer Buchschrift.', draft.serif);
    bind(sf.cb, 'serif');
    body.appendChild(sf.row);
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
    const url = bind(input('text', draft.ollamaUrl), 'ollamaUrl');
    const ur = formRow('Adresse von Ollama', url, 'Standard: http://127.0.0.1:11434 (bleibt auf diesem PC).');
    ur.style.marginTop = '16px';
    body.appendChild(ur);
  }

  // ---------- KI ----------
  function ai(body) {
    body.appendChild(el('h2', null, 'KI und Modell'));
    const sys = bind(textarea(draft.systemPrompt, 6), 'systemPrompt');
    body.appendChild(formRow('Grundanweisung an die KI', sys, 'Gilt für jeden Chat. Die Angaben des aktiven Profils werden automatisch dazugegeben.'));
    const two = el('div', 'two');
    two.appendChild(formRow('Kontextlänge (Tokens)', bind(input('number', draft.numCtx, { min: 2048, step: 1024 }), 'numCtx'), 'Mehr = längere PDFs, aber langsamer. 16384 ist ein guter Start.'));
    two.appendChild(formRow('Kreativität (Temperatur)', bind(input('number', draft.temperature, { min: 0, max: 2, step: 0.1 }), 'temperature'), '0 = sachlich, 1 = kreativ.'));
    body.appendChild(two);
    body.appendChild(formRow('Modell im Speicher halten', bind(selectOf([['5m', '5 Minuten'], ['30m', '30 Minuten'], ['2h', '2 Stunden'], ['-1', 'Immer']], draft.keepAlive), 'keepAlive'), 'Solange bleibt das Modell geladen, damit die nächste Antwort sofort kommt.'));
    body.appendChild(formRow('Standard-Denktiefe', bind(selectOf([['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch']], draft.think), 'think'), 'Bei gpt-oss. Du kannst sie im Chat jederzeit ändern.'));
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
    const test = el('button', 'btn small', 'Stimme testen');
    test.onclick = () => ctx.speakSample('Hallo! Das ist meine Stimme. Ich lese Dir Antworten und Texte vor.', draft);
    const stopT = el('button', 'btn small', 'Stopp');
    stopT.onclick = () => ctx.stopSpeaking();
    const tr = el('div', 'chips-row'); tr.append(test, stopT);
    body.appendChild(tr);

    body.appendChild(el('h3', null, 'Spracheingabe'));
    const two = el('div', 'two');
    two.appendChild(formRow('Sprache beim Diktieren', bind(selectOf([['de', 'Deutsch'], ['tr', 'Türkisch'], ['auto', 'Automatisch erkennen']], draft.sttLang), 'sttLang')));
    two.appendChild(formRow('Genauigkeit', bind(selectOf([['base', 'Schnell (base)'], ['small', 'Ausgewogen (small)'], ['medium', 'Genau (medium)']], draft.sttModel), 'sttModel')));
    body.appendChild(two);
    const as = switchRow('Diktierten Text sofort senden', 'Aus: der Text erscheint zuerst im Eingabefeld.', draft.autoSend);
    bind(as.cb, 'autoSend');
    body.appendChild(as.row);
    const ta = switchRow('Antworten automatisch vorlesen', 'Auch über das Lautsprecher-Symbol unter dem Eingabefeld schaltbar.', draft.ttsAuto);
    bind(ta.cb, 'ttsAuto');
    body.appendChild(ta.row);

    body.appendChild(el('h3', null, 'Lokale Sprach-Bausteine'));
    const mkRow = (title, ok, sub, btnText, fn) => {
      const r = el('div', 'list-row');
      const g = el('div', 'grow'); g.appendChild(el('div', null, title)); g.appendChild(el('div', 'sub', sub));
      r.appendChild(g);
      r.appendChild(el('span', 'badge ' + (ok ? 'ok' : 'warn'), ok ? 'bereit' : 'fehlt'));
      const b = el('button', 'btn small', ok ? 'Neu laden' : btnText);
      b.onclick = async () => {
        b.disabled = true;
        try { await fn(); ctx.hideProgress(); ctx.hint('Fertig: ' + title, 5000); }
        catch (e) { ctx.hideProgress(); ctx.hint(title + ': ' + (e.message || e), 0); }
        render();
      };
      r.appendChild(b);
      return r;
    };
    const model = draft.sttModel;
    body.appendChild(mkRow('Spracherkennung (Whisper, Modell „' + model + '“)', st.whisperBinary && st.whisperModels[model], 'ca. ' + st.info.whisperModels[model].approx + ' – für Diktieren und Gesprächsmodus', 'Einrichten', () => api.speech.prepareStt(model)));
    for (const k of ['de', 'tr']) {
      body.appendChild(mkRow('Natürliche Stimme: ' + st.info.voices[k].label, st.piperBinary && st.voices[k], 'ca. ' + st.info.voices[k].approx + ' – klingt natürlicher als die Windows-Stimme', 'Laden', () => api.speech.prepareTts(k)));
    }
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
