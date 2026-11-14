import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { readPdf, prepareImage, isPdf, isImage } from './docs.js';
import { startRecording, speak, stopSpeaking } from './audio.js';
import { fitText, formatBytes } from '../lib/util.js';
import { buildThink } from '../lib/ollama.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const TEMPLATES = {
  reply_de: 'Entwirf eine höfliche, klare Antwort auf Deutsch auf diese E-Mail. Gib nur den Entwurf aus (mit Betreff, falls sinnvoll).\n\nE-Mail:\n',
  reply_tr: 'Bu e-postaya nazik ve net bir Türkçe cevap taslağı yaz. Sadece taslağı ver (gerekirse konu satırıyla).\n\nE-posta:\n',
  summary: 'Fasse diese E-Mail kurz auf Deutsch zusammen: Worum geht es, was wird von mir erwartet, gibt es Fristen? \n\nE-Mail:\n',
  formal: 'Schreibe den folgenden Text höflich und formell um, behalte die Sprache bei:\n\n',
  translate_de: 'Übersetze den folgenden Text ins Deutsche:\n\n',
  translate_tr: 'Aşağıdaki metni Türkçeye çevir:\n\n',
};

const state = {
  settings: null,
  models: [],
  caps: {},
  chat: null,
  chats: [],
  pending: [],      // Anhänge der nächsten Nachricht
  streaming: null,  // { id, msgEl, ... }
  speechStatus: null,
  conv: false,
  rec: null,
  speaking: false,
};

marked.setOptions({ gfm: true, breaks: true });

function renderMd(text) {
  const html = marked.parse(text || '', { async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function newChat() {
  return { id: newId(), title: 'Neuer Chat', model: state.settings.model || '', updated: Date.now(), messages: [] };
}

// ---------- Hinweise / Fortschritt ----------
let hintTimer = null;
function hint(text, ms = 6000) {
  $('hint').textContent = text || '';
  clearTimeout(hintTimer);
  if (text && ms) hintTimer = setTimeout(() => { $('hint').textContent = ''; }, ms);
}
function showProgress(label, pct) {
  $('progressBar').classList.remove('hidden');
  $('progressText').textContent = label + (pct != null ? ` – ${pct} %` : ' …');
  const f = $('progressFill');
  f.classList.toggle('indet', pct == null);
  f.style.width = pct != null ? pct + '%' : '';
}
function hideProgress() { $('progressBar').classList.add('hidden'); }

api.speech.onProgress((p) => {
  const label = p.label || 'Download';
  const extra = p.total ? ` (${formatBytes(p.received)} / ${formatBytes(p.total)})` : '';
  showProgress(label + extra, p.pct);
});

// ---------- Status & Modelle ----------
async function refreshStatus() {
  const s = await api.ollama.status();
  const box = $('status');
  box.classList.toggle('ok', s.ok);
  box.classList.toggle('bad', !s.ok);
  $('statusText').textContent = s.ok ? `Ollama ${s.version} läuft lokal` : 'Ollama nicht erreichbar';
  if (!s.ok) hint('Ollama ist nicht erreichbar. Bitte die Ollama-App starten (sie läuft im Hintergrund).', 0);
  return s.ok;
}

async function loadModels() {
  try {
    state.models = await api.ollama.models();
  } catch (e) {
    state.models = [];
  }
  const sel = $('modelSel');
  sel.innerHTML = '';
  const visible = state.models.filter((m) => state.settings.showCloud || !m.remote);
  if (!visible.length) {
    const o = el('option', null, 'Kein Modell installiert'); o.value = ''; sel.appendChild(o);
  }
  for (const m of visible) {
    const o = el('option', null, m.name + (m.remote ? ' (Cloud!)' : '') + (m.size ? ` · ${formatBytes(m.size)}` : ''));
    o.value = m.name;
    sel.appendChild(o);
  }
  const want = (state.chat && state.chat.model) || state.settings.model;
  if (visible.some((m) => m.name === want)) sel.value = want;
  else if (visible.length) sel.value = visible[0].name;
  await onModelChanged(false);
}

async function getCaps(name) {
  if (!name) return [];
  if (!state.caps[name]) {
    try { state.caps[name] = (await api.ollama.show(name)).capabilities; } catch { state.caps[name] = []; }
  }
  return state.caps[name];
}

async function onModelChanged(save = true) {
  const name = $('modelSel').value;
  const caps = await getCaps(name);
  const thinkSel = $('thinkSel');
  const canThink = caps.includes('thinking');
  $('thinkField').style.display = canThink ? '' : 'none';
  const keep = state.settings.think;
  thinkSel.innerHTML = '';
  const opts = /gpt-oss/i.test(name)
    ? [['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch']]
    : [['off', 'Aus'], ['on', 'An']];
  for (const [v, t] of opts) { const o = el('option', null, t); o.value = v; thinkSel.appendChild(o); }
  thinkSel.value = opts.some(([v]) => v === keep) ? keep : (opts.length === 3 ? 'medium' : 'on');
  if (state.chat) state.chat.model = name;
  if (save && name) { state.settings = await api.settings.set({ model: name }); }
}

// ---------- Chatliste ----------
async function refreshChats() {
  state.chats = await api.chats.list();
  const box = $('chatList');
  box.innerHTML = '';
  for (const c of state.chats) {
    const row = el('div', 'chat-item' + (state.chat && state.chat.id === c.id ? ' active' : ''));
    row.appendChild(el('span', 't', c.title));
    const x = el('button', 'x', '✕'); x.title = 'Chat löschen';
    x.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Chat „${c.title}“ endgültig löschen?`)) return;
      await api.chats.remove(c.id);
      if (state.chat && state.chat.id === c.id) await openChat(null);
      else await refreshChats();
    };
    row.appendChild(x);
    row.onclick = () => openChat(c.id);
    box.appendChild(row);
  }
}

async function openChat(id) {
  if (state.streaming) return hint('Bitte warte, bis die Antwort fertig ist (oder klicke auf Stopp).');
  stopSpeaking();
  state.chat = id ? await api.chats.load(id) : newChat();
  if (!state.chat) state.chat = newChat();
  if (state.chat.model && state.models.some((m) => m.name === state.chat.model)) $('modelSel').value = state.chat.model;
  await onModelChanged(false);
  renderAll();
  await refreshChats();
}

// ---------- Nachrichten anzeigen ----------
function renderAll() {
  const box = $('messages');
  box.innerHTML = '';
  if (!state.chat.messages.length) {
    box.appendChild($('empty') || makeEmpty());
    $('empty').classList.remove('hidden');
  } else {
    for (const m of state.chat.messages) box.appendChild(buildMsg(m));
    box.scrollTop = box.scrollHeight;
  }
}
function makeEmpty() {
  const d = el('div', 'empty'); d.id = 'empty';
  d.innerHTML = '<div class="logo big">FA</div><h1>Deine private KI</h1><p>Alles läuft lokal auf diesem PC.</p>';
  return d;
}

function buildMsg(m) {
  const wrap = el('div', 'msg ' + m.role);
  wrap.appendChild(el('div', 'who', m.role === 'user' ? 'Du' : 'KI'));
  const body = el('div', 'bubble');
  wrap.appendChild(body);
  fillMsg(wrap, m);
  return wrap;
}

function fillMsg(wrap, m, live = false) {
  const body = wrap.querySelector('.bubble');
  body.innerHTML = '';
  if (m.role === 'user') {
    body.textContent = m.content;
    if (m.attachments && m.attachments.length) {
      const chips = el('div', 'chips');
      for (const a of m.attachments) chips.appendChild(el('span', 'chip', '📎 ' + a.name + (a.note ? ' · ' + a.note : '')));
      wrap.querySelector('.bubble').after(chips);
    }
    return;
  }
  if (m.thinking) {
    const d = el('details', 'think');
    if (live) d.open = true;
    d.appendChild(el('summary', null, live && !m.content ? 'Denkt nach …' : 'Gedankengang anzeigen'));
    d.appendChild(el('div', 'tt', m.thinking));
    body.appendChild(d);
  }
  const md = el('div', 'md');
  md.innerHTML = renderMd(m.content);
  md.querySelectorAll('pre').forEach((pre) => {
    const b = el('button', 'copybtn', 'Kopieren');
    b.onclick = () => { navigator.clipboard.writeText(pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText); b.textContent = 'Kopiert ✓'; setTimeout(() => { b.textContent = 'Kopieren'; }, 1500); };
    pre.appendChild(b);
  });
  md.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
  body.appendChild(md);
  if (m.error) body.appendChild(el('div', 'err', m.error));
  if (m.stats && m.stats.evalCount && m.stats.evalDuration) {
    body.appendChild(el('div', 'stats', `${(m.stats.evalCount / (m.stats.evalDuration / 1e9)).toFixed(1).replace('.', ',')} Token/s`));
  }
  if (!live) {
    let ac = wrap.querySelector('.msg-actions');
    if (ac) ac.remove();
    ac = el('div', 'msg-actions');
    const cp = el('button', null, 'Kopieren'); cp.onclick = () => { navigator.clipboard.writeText(m.content); cp.textContent = 'Kopiert ✓'; };
    const sp = el('button', null, '🔊 Vorlesen'); sp.onclick = () => speakNow(m.content);
    ac.appendChild(cp); ac.appendChild(sp);
    wrap.appendChild(ac);
  }
}

// ---------- Senden ----------
function setBusy(on) {
  $('btnSend').classList.toggle('hidden', on);
  $('btnStop').classList.toggle('hidden', !on);
  $('input').disabled = false;
}

async function buildOllamaMessages() {
  const s = state.settings;
  const msgs = [];
  if (s.systemPrompt && s.systemPrompt.trim()) msgs.push({ role: 'system', content: s.systemPrompt.trim() });
  for (const m of state.chat.messages) {
    if (m.role === 'assistant') { if (m.content) msgs.push({ role: 'assistant', content: m.content }); continue; }
    const ctx = m.ctx ? m.ctx + '\n\n' : '';
    const o = { role: 'user', content: ctx + m.content };
    if (m.images && m.images.length) o.images = m.images;
    msgs.push(o);
  }
  return msgs;
}

async function send() {
  if (state.streaming) return;
  const text = $('input').value.trim();
  if (!text && !state.pending.length) return;
  const model = $('modelSel').value;
  if (!model) return hint('Bitte zuerst ein Modell installieren (links unten „Modelle verwalten“).');
  if (!(await refreshStatus())) return;
  stopSpeaking();
  if (!state.chat) state.chat = newChat();
  const caps = await getCaps(model);

  // Anhänge verarbeiten
  const attachments = [];
  const images = [];
  const ctxParts = [];
  const budget = Math.max(4000, Math.floor(state.settings.numCtx * 2.6) - 3000);
  const docs = state.pending.filter((p) => p.kind === 'doc');
  const perDoc = docs.length ? Math.floor(budget / docs.length) : budget;
  for (const p of state.pending) {
    if (p.kind === 'doc') {
      const f = fitText(p.text, perDoc);
      ctxParts.push(`[Datei: ${p.name}]\n${f.text}\n[Ende der Datei]`);
      attachments.push({ name: p.name, note: p.note + (f.truncated ? ', gekürzt' : '') });
    } else if (p.kind === 'image') {
      if (caps.includes('vision')) { images.push(p.base64); attachments.push({ name: p.name, note: 'Bild' }); }
      else if (p.ocrText) {
        ctxParts.push(`[Text aus Bild: ${p.name}]\n${fitText(p.ocrText, perDoc).text}\n[Ende]`);
        attachments.push({ name: p.name, note: 'Bild (Text per OCR gelesen)' });
      } else { hint('Dieses Modell kann keine Bilder sehen – nutze ein Modell mit Bild-Fähigkeit.'); }
    }
  }
  const userMsg = {
    role: 'user',
    content: text || 'Bitte lies die angehängte Datei und fasse sie zusammen.',
    attachments,
    ctx: ctxParts.join('\n\n'),
    images,
  };
  state.chat.messages.push(userMsg);
  if (state.chat.title === 'Neuer Chat') state.chat.title = (text || attachments[0]?.name || 'Chat').slice(0, 42);
  state.chat.model = model;
  state.pending = [];
  renderPending();
  $('input').value = '';
  autosize();

  const asst = { role: 'assistant', content: '', thinking: '' };
  state.chat.messages.push(asst);
  $('messages').querySelector('#empty')?.remove();
  $('messages').appendChild(buildMsg(userMsg));
  const wrap = buildMsg(asst);
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;

  const id = newId();
  state.streaming = { id, asst, wrap };
  setBusy(true);
  const think = buildThink(model, caps, $('thinkSel').value === 'on' ? 'on' : $('thinkSel').value);
  const body = {
    model,
    messages: await buildOllamaMessages(),
    options: { num_ctx: state.settings.numCtx, temperature: state.settings.temperature },
    keep_alive: '30m',
  };
  if (think !== undefined) body.think = think;
  api.chat.start({ id, body });
  api.chats.save(state.chat);
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const s = state.streaming;
    if (!s) return;
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    fillMsg(s.wrap, s.asst, true);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  });
}

api.chat.onDelta(({ id, content, thinking }) => {
  const s = state.streaming;
  if (!s || s.id !== id) return;
  s.asst.content += content;
  s.asst.thinking += thinking;
  scheduleRender();
});

async function finishStream(id, extra) {
  const s = state.streaming;
  if (!s || s.id !== id) return;
  Object.assign(s.asst, extra || {});
  state.streaming = null;
  setBusy(false);
  if (!s.asst.content && !s.asst.thinking && !s.asst.error) s.asst.content = '_(keine Antwort erhalten)_';
  state.chat.updated = Date.now();
  fillMsg(s.wrap, s.asst, false);
  await api.chats.save(state.chat);
  await refreshChats();
  if ((state.settings.ttsAuto || state.conv) && s.asst.content && !s.asst.error) {
    await speakNow(s.asst.content);
  }
  if (state.conv) convListen();
}

api.chat.onDone(({ id, stats, aborted }) => finishStream(id, { stats, aborted }));
api.chat.onError(({ id, error }) => finishStream(id, { error }));

// ---------- Vorlesen ----------
async function speakNow(text) {
  try {
    state.speechStatus = await api.speech.status();
    await speak(text, {
      voicePref: state.settings.ttsVoice,
      speechStatus: state.speechStatus,
      onState: (on) => { state.speaking = on; $('btnStopSpeak').classList.toggle('hidden', !on); },
    });
  } catch (e) { hint('Vorlesen fehlgeschlagen: ' + (e.message || e)); }
}

// ---------- Mikrofon ----------
async function ensureStt() {
  const st = await api.speech.status();
  const model = state.settings.sttModel;
  if (st.whisperBinary && st.whisperModels[model]) return true;
  if (!confirm(`Für die Spracheingabe muss einmalig ein lokales Spracherkennungs-Modell geladen werden (ca. ${st.info.whisperModels[model].approx}). Jetzt laden?`)) return false;
  try {
    showProgress('Spracherkennung wird eingerichtet', null);
    await api.speech.prepareStt(model);
    hideProgress();
    return true;
  } catch (e) {
    hideProgress();
    hint('Spracherkennung konnte nicht eingerichtet werden: ' + (e.message || e), 0);
    return false;
  }
}

async function transcribeAndFill(wav) {
  if (!wav) { hint('Es wurde nichts gesprochen.'); return ''; }
  showProgress('Sprache wird erkannt', null);
  try {
    const t = await api.speech.transcribe({ wav, lang: state.settings.sttLang, model: state.settings.sttModel });
    return t;
  } catch (e) {
    hint('Erkennung fehlgeschlagen: ' + (e.message || e), 0);
    return '';
  } finally { hideProgress(); }
}

async function toggleMic() {
  if (state.rec) { state.rec.stop(); return; }
  if (!(await ensureStt())) return;
  try {
    stopSpeaking();
    state.rec = await startRecording({ vad: false });
  } catch (e) { return hint('Mikrofon nicht verfügbar: ' + (e.message || e), 0); }
  $('btnMic').classList.add('rec');
  hint('Aufnahme läuft … nochmal auf 🎤 klicken zum Beenden.', 0);
  const wav = await state.rec.done;
  state.rec = null;
  $('btnMic').classList.remove('rec');
  hint('');
  const t = await transcribeAndFill(wav);
  if (t) {
    const cur = $('input').value;
    $('input').value = (cur ? cur + ' ' : '') + t;
    autosize();
    if (state.settings.autoSend) send();
  }
}

async function convListen() {
  if (!state.conv || state.rec || state.streaming) return;
  try {
    state.rec = await startRecording({ vad: true });
  } catch (e) { state.conv = false; $('btnConv').classList.remove('rec'); return hint('Mikrofon nicht verfügbar: ' + (e.message || e), 0); }
  hint('Ich höre zu … sprich einfach.', 0);
  const wav = await state.rec.done;
  state.rec = null;
  if (!state.conv) return;
  if (!wav) return convListen();
  hint('');
  const t = await transcribeAndFill(wav);
  if (!state.conv) return;
  if (t && t.length > 1) { $('input').value = t; await send(); } else convListen();
}

async function toggleConv() {
  if (state.conv) {
    state.conv = false;
    $('btnConv').classList.remove('rec');
    if (state.rec) state.rec.cancel();
    stopSpeaking(); hint('Gesprächsmodus beendet.');
    return;
  }
  if (!(await ensureStt())) return;
  state.conv = true;
  $('btnConv').classList.add('rec');
  convListen();
}

// ---------- Anhänge ----------
function renderPending() {
  const box = $('attachments');
  box.innerHTML = '';
  state.pending.forEach((p, i) => {
    const a = el('div', 'att');
    a.appendChild(el('span', null, (p.kind === 'image' ? '🖼 ' : '📄 ') + p.name + (p.note ? ' · ' + p.note : '')));
    const x = el('button', null, '✕'); x.onclick = () => { state.pending.splice(i, 1); renderPending(); };
    a.appendChild(x);
    box.appendChild(a);
  });
}

async function addFile(name, data) {
  try {
    if (isPdf(name)) {
      showProgress('PDF wird gelesen', null);
      const r = await readPdf(data, (t) => showProgress(t, null));
      const note = `${r.readPages} Seiten` + (r.ocrPages ? `, ${r.ocrPages} per OCR` : '');
      if (!r.text.replace(/---.*?---/g, '').trim()) hint('Aus dieser PDF konnte kein Text gelesen werden.', 0);
      state.pending.push({ kind: 'doc', name, text: r.text, note });
    } else if (isImage(name)) {
      const img = await prepareImage(data);
      const item = { kind: 'image', name, base64: img.base64, note: '' };
      const caps = await getCaps($('modelSel').value);
      if (!caps.includes('vision')) {
        showProgress('Text im Bild wird erkannt (OCR)', null);
        item.ocrText = await api.ocr.run({ image: img.jpeg });
        item.note = 'Text per OCR';
      }
      state.pending.push(item);
    } else {
      const text = new TextDecoder('utf-8').decode(data instanceof Uint8Array ? data : new Uint8Array(data));
      state.pending.push({ kind: 'doc', name, text, note: `${text.length} Zeichen` });
    }
  } catch (e) {
    hint(`„${name}“ konnte nicht gelesen werden: ${e.message || e}`, 0);
  } finally { hideProgress(); }
  renderPending();
}

async function pickFiles() {
  const files = await api.files.pick();
  for (const f of files) await addFile(f.name, f.data);
}

// ---------- Dialoge ----------
function openModal(build) {
  const m = $('modal');
  m.innerHTML = '';
  build(m);
  $('overlay').classList.remove('hidden');
}
function closeModal() { $('overlay').classList.add('hidden'); $('modal').innerHTML = ''; }
$('overlay').addEventListener('mousedown', (e) => { if (e.target === $('overlay')) closeModal(); });

function formRow(label, control, note) {
  const r = el('div', 'form-row');
  r.appendChild(el('label', null, label));
  r.appendChild(control);
  if (note) r.appendChild(el('div', 'note', note));
  return r;
}
function selectOf(options, value) {
  const s = document.createElement('select');
  for (const [v, t] of options) { const o = el('option', null, t); o.value = v; s.appendChild(o); }
  s.value = value;
  return s;
}

async function openSettings() {
  const st = await api.speech.status();
  const info = await api.app.info();
  openModal((m) => {
    const S = state.settings;
    m.appendChild(el('h2', null, 'Einstellungen'));
    const url = el('input'); url.type = 'text'; url.value = S.ollamaUrl;
    const sys = el('textarea'); sys.rows = 4; sys.value = S.systemPrompt;
    const ctx = el('input'); ctx.type = 'number'; ctx.min = 2048; ctx.step = 1024; ctx.value = S.numCtx;
    const temp = el('input'); temp.type = 'number'; temp.min = 0; temp.max = 2; temp.step = 0.1; temp.value = S.temperature;
    const cloud = el('input'); cloud.type = 'checkbox'; cloud.checked = S.showCloud;
    const tts = selectOf([['auto', 'Automatisch (Deutsch/Türkisch)'], ['de', 'Immer Deutsch'], ['tr', 'Immer Türkisch'], ['windows', 'Nur Windows-Stimme']], S.ttsVoice);
    const stt = selectOf([['de', 'Deutsch'], ['tr', 'Türkisch'], ['auto', 'Automatisch erkennen']], S.sttLang);
    const sttm = selectOf([['base', 'Schnell (base)'], ['small', 'Ausgewogen (small)'], ['medium', 'Genau (medium)']], S.sttModel);
    const auto = el('input'); auto.type = 'checkbox'; auto.checked = S.autoSend;

    m.appendChild(formRow('Adresse von Ollama', url, 'Standard: http://127.0.0.1:11434 – bleibt auf diesem PC.'));
    m.appendChild(formRow('Anweisung an die KI (System-Prompt)', sys));
    m.appendChild(formRow('Kontextlänge (Tokens)', ctx, 'Mehr = längere PDFs, aber mehr Speicher/langsamer. 16384 ist ein guter Start.'));
    m.appendChild(formRow('Kreativität (Temperatur)', temp));
    const c1 = el('label', 'check'); c1.append(cloud, ' Cloud-Modelle in der Liste anzeigen (senden Daten an fremde Server!)');
    m.appendChild(c1);
    m.appendChild(el('h3', null, 'Sprache'));
    m.appendChild(formRow('Stimme beim Vorlesen', tts));
    m.appendChild(formRow('Sprache beim Diktieren', stt));
    m.appendChild(formRow('Genauigkeit der Spracherkennung', sttm));
    const c2 = el('label', 'check'); c2.append(auto, ' Diktierten Text sofort senden');
    m.appendChild(c2);

    m.appendChild(el('h3', null, 'Lokale Sprach-Bausteine'));
    const mkRow = (title, ok, sub, btnText, fn) => {
      const r = el('div', 'list-row');
      const g = el('div', 'grow'); g.appendChild(el('div', null, title)); g.appendChild(el('div', 'sub', sub));
      r.appendChild(g);
      r.appendChild(el('span', 'badge ' + (ok ? 'ok' : 'warn'), ok ? 'bereit' : 'fehlt'));
      if (!ok || btnText) {
        const b = el('button', 'small', ok ? 'Neu laden' : btnText); b.onclick = async () => {
          b.disabled = true;
          try { await fn(); hideProgress(); hint('Fertig: ' + title, 5000); } catch (e) { hideProgress(); hint(title + ': ' + (e.message || e), 0); }
          closeModal(); openSettings();
        }; r.appendChild(b);
      }
      return r;
    };
    const sttOk = st.whisperBinary && st.whisperModels[sttm.value];
    m.appendChild(mkRow('Spracherkennung (Whisper)', sttOk, 'Für 🎤 und Gesprächsmodus', 'Einrichten', () => api.speech.prepareStt(sttm.value)));
    for (const k of ['de', 'tr']) {
      m.appendChild(mkRow('Natürliche Stimme: ' + st.info.voices[k].label, st.piperBinary && st.voices[k], 'ca. ' + st.info.voices[k].approx + ' – klingt deutlich natürlicher als die Windows-Stimme', 'Laden', () => api.speech.prepareTts(k)));
    }

    m.appendChild(el('h3', null, 'Info'));
    m.appendChild(el('div', 'sub', `FA KI Desktop Version ${info.version}`));
    const open = el('button', 'small', 'Datenordner öffnen'); open.onclick = () => api.app.openDataDir();
    m.appendChild(open);

    const act = el('div', 'actions');
    const cancel = el('button', null, 'Abbrechen'); cancel.onclick = closeModal;
    const save = el('button', 'primary', 'Speichern');
    save.onclick = async () => {
      state.settings = await api.settings.set({
        ollamaUrl: url.value.trim() || 'http://127.0.0.1:11434',
        systemPrompt: sys.value,
        numCtx: Math.max(2048, parseInt(ctx.value, 10) || 16384),
        temperature: Math.min(2, Math.max(0, parseFloat(temp.value) || 0.7)),
        showCloud: cloud.checked, ttsVoice: tts.value, sttLang: stt.value, sttModel: sttm.value, autoSend: auto.checked,
      });
      closeModal();
      await refreshStatus(); await loadModels();
    };
    act.append(cancel, save);
    m.appendChild(act);
  });
}

async function openModels() {
  const render = async (m) => {
    m.innerHTML = '';
    m.appendChild(el('h2', null, 'Modelle verwalten'));
    let list = [];
    try { list = await api.ollama.models(); } catch (e) { m.appendChild(el('div', 'err', 'Ollama nicht erreichbar.')); }
    m.appendChild(el('h3', null, 'Installiert'));
    if (!list.length) m.appendChild(el('div', 'sub', 'Noch keine Modelle installiert.'));
    for (const x of list) {
      const r = el('div', 'list-row');
      const g = el('div', 'grow'); g.appendChild(el('div', null, x.name));
      g.appendChild(el('div', 'sub', (x.size ? formatBytes(x.size) : 'Cloud') + (x.details.parameter_size ? ' · ' + x.details.parameter_size : '')));
      r.appendChild(g);
      if (x.remote) r.appendChild(el('span', 'badge warn', 'Cloud – nicht lokal'));
      const d = el('button', 'small', 'Löschen');
      d.onclick = async () => {
        if (!confirm(`Modell „${x.name}“ löschen?`)) return;
        await api.ollama.remove(x.name); await loadModels(); render(m);
      };
      r.appendChild(d);
      m.appendChild(r);
    }
    m.appendChild(el('h3', null, 'Neues Modell laden'));
    const inl = el('div', 'inline');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'z. B. gpt-oss:20b';
    const go = el('button', 'primary', 'Laden');
    inl.append(inp, go);
    m.appendChild(inl);
    const sugg = el('div', 'chips');
    for (const s of ['gpt-oss:20b', 'gemma4:12b']) {
      const c = el('button', 'small', s); c.onclick = () => { inp.value = s; }; sugg.appendChild(c);
    }
    m.appendChild(sugg);
    const prog = el('div', 'sub', ''); prog.style.marginTop = '10px';
    m.appendChild(prog);
    const off = api.ollama.onPull((p) => {
      prog.textContent = p.total ? `${p.name}: ${p.status} – ${Math.round((p.completed / p.total) * 100)} % (${formatBytes(p.completed)} / ${formatBytes(p.total)})` : `${p.name}: ${p.status}`;
    });
    go.onclick = async () => {
      const name = inp.value.trim();
      if (!name) return;
      if (/cloud/i.test(name) && !confirm('Cloud-Modelle laufen NICHT lokal und senden Daten an fremde Server. Trotzdem laden?')) return;
      go.disabled = true; go.textContent = 'Lädt …';
      try { await api.ollama.pull(name); await loadModels(); off(); render(m); }
      catch (e) { prog.textContent = 'Fehler: ' + (e.message || e); go.disabled = false; go.textContent = 'Laden'; }
    };
    const act = el('div', 'actions');
    const stop = el('button', null, 'Download abbrechen'); stop.onclick = () => api.ollama.pullCancel();
    const close = el('button', 'primary', 'Schließen'); close.onclick = () => { off(); closeModal(); };
    act.append(stop, close);
    m.appendChild(act);
  };
  openModal(render);
}

// ---------- Export ----------
async function exportChat() {
  if (!state.chat || !state.chat.messages.length) return hint('Dieser Chat ist noch leer.');
  const md = `# ${state.chat.title}\n\n` + state.chat.messages
    .map((m) => `**${m.role === 'user' ? 'Du' : 'KI'}:**\n\n${m.content}`).join('\n\n---\n\n');
  if (await api.chats.export({ title: state.chat.title, markdown: md })) hint('Chat gespeichert.');
}

// ---------- Eingabe ----------
function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(220, t.scrollHeight) + 'px';
}

function wire() {
  $('btnSend').onclick = send;
  $('btnStop').onclick = () => state.streaming && api.chat.stop(state.streaming.id);
  $('newChat').onclick = () => openChat(null);
  $('btnSettings').onclick = openSettings;
  $('btnModels').onclick = openModels;
  $('btnAttach').onclick = pickFiles;
  $('btnMic').onclick = toggleMic;
  $('btnConv').onclick = toggleConv;
  $('btnExport').onclick = exportChat;
  $('btnStopSpeak').onclick = () => { stopSpeaking(); $('btnStopSpeak').classList.add('hidden'); };
  $('modelSel').onchange = () => onModelChanged(true);
  $('thinkSel').onchange = async () => { state.settings = await api.settings.set({ think: $('thinkSel').value }); };
  $('ttsAuto').onchange = async () => { state.settings = await api.settings.set({ ttsAuto: $('ttsAuto').checked }); };
  $('tplSel').onchange = () => {
    const t = TEMPLATES[$('tplSel').value];
    if (t) { $('input').value = t + $('input').value; autosize(); $('input').focus(); }
    $('tplSel').value = '';
  };
  $('input').addEventListener('input', autosize);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // Dateien per Drag & Drop
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) await addFile(f.name, new Uint8Array(await f.arrayBuffer()));
  });
  // Bilder aus der Zwischenablage
  $('input').addEventListener('paste', async (e) => {
    for (const it of e.clipboardData.items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); await addFile('Bild-' + Date.now() + '.png', new Uint8Array(await f.arrayBuffer())); }
      }
    }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

async function init() {
  state.settings = await api.settings.get();
  $('ttsAuto').checked = state.settings.ttsAuto;
  wire();
  state.chat = newChat();
  await refreshStatus();
  await loadModels();
  await refreshChats();
  renderAll();
  setInterval(() => { if (!state.streaming) refreshStatus().catch(() => {}); }, 20000);
}

init().catch((e) => { console.error(e); hint('Startfehler: ' + (e.message || e), 0); });
