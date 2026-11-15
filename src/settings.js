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

  let vstat = { installed: false, busy: false };
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

  const bindRender = (control, key) => { control.addEventListener('change', () => { draft[key] = control.value; render(); }); return control; };

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
    const tl = switchRow('Gedankengang live aufklappen', 'Aus: er bleibt eingeklappt und zeigt nur „Denkt nach …“. Du kannst ihn jederzeit selbst öffnen.', draft.thinkLive);
    bind(tl.cb, 'thinkLive');
    body.appendChild(tl.row);
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
    const ao = switchRow('Ollama mit der App starten', 'Startet Ollama im Hintergrund, falls es nicht läuft (nur bei einer Adresse auf diesem PC).', draft.autoStartOllama);
    bind(ao.cb, 'autoStartOllama');
    body.appendChild(ao.row);
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
    const vc = el('div', 'voice-card');
    vc.appendChild(el('h3', null, 'Eigene Stimme (natürlich, nach Deiner Aufnahme)'));
    vc.appendChild(el('div', 'note', 'Chatterbox spricht Deutsch und Türkisch und klingt nach Deiner Aufnahme. Die Einrichtung ist einmalig: rund 6 GB Download und Speicherplatz, je nach Leitung 20 bis 60 Minuten. Alles läuft auf diesem PC. Es rechnet auf dem Prozessor, deshalb braucht jeder Satz einige Sekunden.'));
    const sInfo = el('div', 'note', draft.ttsSampleFile ? 'Stimmprobe: ' + draft.ttsSampleFile : 'Noch keine Stimmprobe gewählt (ohne Probe spricht eine Standardstimme).');
    const bSample = el('button', 'btn small', 'Aufnahme wählen …');
    bSample.onclick = async () => { const r = await api.speech.pickSample(); if (r) { draft.ttsSampleFile = r.name; sInfo.textContent = 'Stimmprobe: ' + r.name; } };
    const bSetup = el('button', 'btn small primary', vstat.installed ? 'Neu einrichten / reparieren' : 'Stimme jetzt einrichten');
    const bGpu = el('button', 'btn small', vstat.gpuInstalled ? 'Grafikkarten-Version erneut einrichten' : 'Mit Grafikkarte beschleunigen (Versuch)');
    const bCancel = el('button', 'btn small', 'Abbrechen');
    const pt = el('div', 'note', VU.running ? VU.text : (VU.done || (vstat.installed ? 'Eigene Stimme ist installiert.' : '')));
    pt.id = 'voiceProgText';
    const bar = el('div', 'bar'); const fill = el('div'); fill.id = 'voiceProgFill'; fill.style.cssText = 'height:100%;background:var(--accent);width:' + (VU.pct == null ? 5 : VU.pct) + '%'; bar.appendChild(fill);
    bar.style.display = VU.running ? '' : 'none';
    bCancel.style.display = VU.running ? '' : 'none';
    bSetup.disabled = VU.running; bGpu.disabled = VU.running;
    bCancel.onclick = () => api.voice.cancel();
    const runSetup = async (gpu) => {
      VU.running = true; VU.done = ''; VU.text = 'Starte …'; VU.pct = 0;
      await api.settings.set({ ttsSampleFile: draft.ttsSampleFile });
      render();
      const r = await api.voice.setup({ gpu });
      VU.running = false;
      const f = (x) => Number(x).toFixed(1).replace('.', ',');
      if (r.settings) {
        const fresh = r.settings;
        Object.assign(draft, { ttsEngine: fresh.ttsEngine, ttsServerUrl: fresh.ttsServerUrl, ttsServerDir: fresh.ttsServerDir, ttsServerCmd: fresh.ttsServerCmd, ttsServerAuto: fresh.ttsServerAuto, ttsServerModel: fresh.ttsServerModel, ttsServerVoice: fresh.ttsServerVoice, ttsServerVoiceTr: fresh.ttsServerVoiceTr });
      }
      if (r.ok) VU.done = `Fertig (${r.device}). Erster Testsatz: ${f(r.cold)} s, zweiter: ${f(r.seconds)} s. Klick unten auf „Speichern“.`;
      else VU.done = 'Fehler: ' + r.error + (gpu ? ' Die bisherige Stimme bleibt aktiv.' : '');
      render();
    };
    bSetup.onclick = () => runSetup(false);
    bGpu.onclick = () => runSetup(true);
    const vrow = el('div', 'chips-row'); vrow.append(bSample, bSetup, bGpu, bCancel);
    const gnote = el('div', 'note', 'Grafikkarte (AMD Radeon): braucht Windows 11 und den AMD-Treiber 26.2.2 oder neuer, noch einmal mehrere GB Download. Läuft sie dort nicht oder ist der Grafikspeicher durch Ollama belegt, nimmt die Stimme automatisch den Prozessor.');
    vc.append(sInfo, vrow, gnote, bar, pt);
    vc.style.cssText = 'border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:6px 0 16px';
    body.appendChild(vc);
    body.appendChild(formRow('Stimmen-Motor', bindRender(selectOf([['piper', 'Piper (lokal, einfach, solide)'], ['server', 'Eigener Stimmen-Server (beste Qualität)']], draft.ttsEngine), 'ttsEngine'), 'Ein Stimmen-Server (z. B. Chatterbox) klingt viel natürlicher, muss aber separat auf diesem PC laufen. Nutzt eine OpenAI-kompatible Adresse.'));
    if (draft.ttsEngine === 'server') {
      const sv = el('div');
      const url = bind(input('text', draft.ttsServerUrl), 'ttsServerUrl');
      sv.appendChild(formRow('Adresse des Stimmen-Servers', url, 'Standard bei Chatterbox: http://127.0.0.1:8004'));
      const two2 = el('div', 'two');
      two2.appendChild(formRow('Stimme (Deutsch)', bind(input('text', draft.ttsServerVoice, { placeholder: 'Name der Stimme' }), 'ttsServerVoice')));
      two2.appendChild(formRow('Stimme (Türkisch)', bind(input('text', draft.ttsServerVoiceTr, { placeholder: 'leer = wie Deutsch' }), 'ttsServerVoiceTr')));
      sv.appendChild(two2);
      const chk = el('button', 'btn small', 'Verbindung prüfen');
      const res = el('div', 'note', '');
      chk.onclick = async () => {
        res.textContent = 'Prüfe …';
        const r = await api.speech.serverVoices(draft.ttsServerUrl);
        res.textContent = r.ok ? (r.voices.length ? 'Verbunden. Gefundene Stimmen: ' + r.voices.slice(0, 12).join(', ') : 'Verbunden (keine Stimmenliste gefunden, Namen von Hand eintragen).') : 'Nicht erreichbar. Läuft der Stimmen-Server?';
      };
      sv.append(chk, res);
      const sampleRow = el('div', 'form-row');
      sampleRow.appendChild(el('label', null, 'Meine Stimmprobe'));
      const sampleInfo = el('div', 'note', draft.ttsSampleFile ? 'Gewählt: ' + draft.ttsSampleFile : 'Noch keine Probe gewählt. Eine saubere Aufnahme von 10 bis 20 Sekunden (WAV) genügt.');
      const pick = el('button', 'btn small', 'Aufnahme wählen …');
      pick.onclick = async () => {
        const r = await api.speech.pickSample();
        if (!r) return;
        draft.ttsSampleFile = r.name;
        sampleInfo.textContent = 'Gewählt: ' + r.name + '. ' + r.notes.join(' ');
      };
      sampleRow.append(pick, sampleInfo);
      sv.appendChild(sampleRow);
      const dirIn = bind(input('text', draft.ttsServerDir, { placeholder: 'z. B. C:\\Chatterbox-TTS-Server' }), 'ttsServerDir');
      const dirRow = formRow('Ordner des Stimmen-Servers', dirIn, 'Wird für den automatischen Start und zum Ablegen der Stimmprobe genutzt.');
      const dirPick = el('button', 'btn small', 'Ordner wählen …');
      dirPick.onclick = async () => { const f = await api.app.pickFolder(); if (f) { draft.ttsServerDir = f; dirIn.value = f; } };
      dirRow.appendChild(dirPick);
      sv.appendChild(dirRow);
      sv.appendChild(formRow('Startbefehl', bind(input('text', draft.ttsServerCmd, { placeholder: 'python server.py' }), 'ttsServerCmd'), 'Wird im Ordner oben ausgeführt.'));
      const au = switchRow('Stimmen-Server mit der App starten', 'Startet den Server beim Öffnen der App im Hintergrund und beendet ihn beim Schließen.', draft.ttsServerAuto);
      bind(au.cb, 'ttsServerAuto');
      sv.appendChild(au.row);
      const startNow = el('button', 'btn small', 'Server jetzt starten');
      const startRes = el('div', 'note', '');
      startNow.onclick = async () => {
        startRes.textContent = 'Starte … (das erste Laden kann eine Minute dauern)';
        await api.settings.set({ ttsServerDir: draft.ttsServerDir, ttsServerCmd: draft.ttsServerCmd, ttsServerUrl: draft.ttsServerUrl });
        const r = await api.speech.startServer();
        startRes.textContent = r.ok ? (r.started ? 'Server läuft jetzt.' : 'Server lief schon.') : 'Fehler: ' + r.error;
      };
      sv.append(startNow, startRes);
      sv.style.marginBottom = '12px';
      body.appendChild(sv);
    }
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
      body.appendChild(mkRow('Piper-Stimme: ' + st.info.voices[k].label, st.piperBinary && st.voices[k], 'ca. ' + st.info.voices[k].approx + ' – klingt natürlicher als die Windows-Stimme', 'Laden', () => api.speech.prepareTts(k)));
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
