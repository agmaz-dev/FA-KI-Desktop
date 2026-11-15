import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { readPdf, prepareImage, isPdf, isImage } from './docs.js';
import { startRecording, speak, stopSpeaking } from './audio.js';
import { fitText, formatBytes } from '../lib/util.js';
import { buildThink } from '../lib/ollama.js';
import { $, el, icon, iconButton, applyIcons, openModal, closeModal, newId } from './ui.js';
import { openSettings, profilePrompt } from './settings.js';

const api = window.api;

const TEMPLATES = [
  ['reply_de', 'Antwort auf Deutsch entwerfen', 'Entwirf eine höfliche, klare Antwort auf Deutsch auf diese E-Mail. Gib nur den Entwurf aus (mit Betreff, falls sinnvoll).\n\nE-Mail:\n'],
  ['reply_tr', 'Antwort auf Türkisch entwerfen', 'Bu e-postaya nazik ve net bir Türkçe cevap taslağı yaz. Sadece taslağı ver (gerekirse konu satırıyla).\n\nE-posta:\n'],
  ['summary', 'E-Mail zusammenfassen', 'Fasse diese E-Mail kurz auf Deutsch zusammen: Worum geht es, was wird von mir erwartet, gibt es Fristen?\n\nE-Mail:\n'],
  ['letter', 'Brief schreiben (mit meinem Profil)', 'Schreibe einen formellen Brief mit meinen Absenderangaben aus dem Profil. Thema und Empfänger:\n\n'],
  ['formal', 'Höflich/formell umschreiben', 'Schreibe den folgenden Text höflich und formell um, behalte die Sprache bei:\n\n'],
  ['translate_de', 'Ins Deutsche übersetzen', 'Übersetze den folgenden Text ins Deutsche:\n\n'],
  ['translate_tr', 'Ins Türkische übersetzen', 'Aşağıdaki metni Türkçeye çevir:\n\n'],
];

const state = {
  settings: null,
  models: [],
  caps: {},
  chat: null,
  chats: [],
  pending: [],
  streaming: null,
  speechStatus: null,
  conv: false,
  rec: null,
  speaking: false,
  search: '',
};

marked.setOptions({ gfm: true, breaks: true });
function renderMd(text) {
  return DOMPurify.sanitize(marked.parse(text || '', { async: false }), { USE_PROFILES: { html: true } });
}

function newChat() {
  return { id: newId(), title: 'Neuer Chat', model: state.settings.model || '', updated: Date.now(), messages: [] };
}

// ---------- Aussehen ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyAppearance(s) {
  const theme = s.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : s.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--fs', (s.fontSize || 16) + 'px');
  document.body.classList.toggle('serif', !!s.serif);
}
darkQuery.addEventListener('change', () => applyAppearance(state.settings));

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
const hideProgress = () => $('progressBar').classList.add('hidden');

api.speech.onProgress((p) => {
  const extra = p.total ? ` (${formatBytes(p.received)} / ${formatBytes(p.total)})` : '';
  showProgress((p.label || 'Download') + extra, p.pct);
});

// ---------- Status & Modelle ----------
async function refreshStatus() {
  const s = await api.ollama.status();
  const box = $('status');
  box.classList.toggle('ok', s.ok);
  box.classList.toggle('bad', !s.ok);
  $('statusText').textContent = s.ok ? `Ollama ${s.version} läuft lokal` : 'Ollama nicht erreichbar';
  if (!s.ok) hint('Ollama ist nicht erreichbar. Die App versucht es zu starten; sonst bitte die Ollama-App öffnen.', 0);
  return s.ok;
}

async function loadModels() {
  try { state.models = await api.ollama.models(); } catch { state.models = []; }
  const sel = $('modelSel');
  sel.innerHTML = '';
  const visible = state.models.filter((m) => state.settings.showCloud || !m.remote);
  if (!visible.length) { const o = el('option', null, 'Kein Modell'); o.value = ''; sel.appendChild(o); }
  for (const m of visible) {
    const o = el('option', null, m.name + (m.remote ? ' (Cloud!)' : ''));
    o.value = m.name;
    o.title = m.size ? formatBytes(m.size) : '';
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
    // Fehler (z. B. Ollama startet noch) nicht merken, sonst bleiben Denken/Bilder bis zum Neustart aus.
    try { state.caps[name] = (await api.ollama.show(name)).capabilities || []; } catch { return []; }
  }
  return state.caps[name];
}

async function onModelChanged(save = true) {
  const name = $('modelSel').value;
  const caps = await getCaps(name);
  $('thinkField').style.display = caps.includes('thinking') ? '' : 'none';
  const thinkSel = $('thinkSel');
  const prev = thinkSel.value;
  thinkSel.innerHTML = '';
  const three = /gpt-oss/i.test(name);
  const opts = three ? [['low', 'Denken: niedrig'], ['medium', 'Denken: mittel'], ['high', 'Denken: hoch']] : [['off', 'Denken: aus'], ['on', 'Denken: an']];
  for (const [v, t] of opts) { const o = el('option', null, t); o.value = v; thinkSel.appendChild(o); }
  const keep = prev && opts.some(([v]) => v === prev) ? prev : state.settings.think;
  thinkSel.value = opts.some(([v]) => v === keep) ? keep : (three ? 'medium' : 'on');
  if (state.chat) state.chat.model = name;
  if (save && name) state.settings = await api.settings.set({ model: name });
}

// ---------- Profile ----------
const activeProfile = () => (state.settings.profiles || []).find((p) => p.id === state.settings.activeProfile) || null;

function renderProfileSelect() {
  const sel = $('profileSel');
  sel.innerHTML = '';
  const none = el('option', null, 'Profil: keins'); none.value = ''; sel.appendChild(none);
  for (const p of state.settings.profiles || []) {
    const o = el('option', null, 'Profil: ' + (p.label || p.fullName || 'Ohne Namen')); o.value = p.id; sel.appendChild(o);
  }
  sel.value = (state.settings.profiles || []).some((p) => p.id === state.settings.activeProfile) ? state.settings.activeProfile : '';
}

function renderGreeting() {
  const g = $('greeting');
  if (!g) return;
  const h = new Date().getHours();
  const hello = h < 5 ? 'Gute Nacht' : h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
  const p = activeProfile();
  const first = p && p.fullName ? p.fullName.trim().split(/\s+/)[0] : '';
  g.textContent = first ? `${hello}, ${first}` : hello;
}

// ---------- Chatliste ----------
function groupOf(ts) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (ts >= d.getTime()) return 'Heute';
  if (ts >= d.getTime() - day) return 'Gestern';
  if (ts >= d.getTime() - 7 * day) return 'Letzte 7 Tage';
  return 'Älter';
}

async function refreshChats() {
  state.chats = await api.chats.list();
  const box = $('chatList');
  box.innerHTML = '';
  const q = state.search.trim().toLowerCase();
  let last = '';
  for (const c of state.chats) {
    if (q && !c.title.toLowerCase().includes(q)) continue;
    const g = groupOf(c.updated);
    if (g !== last) { box.appendChild(el('div', 'group-label', g)); last = g; }
    const row = el('div', 'chat-item' + (state.chat && state.chat.id === c.id ? ' active' : ''));
    const t = el('span', 't', c.title);
    row.appendChild(t);
    const ren = iconButton('edit', 'Umbenennen', 'row-btn', 14);
    ren.onclick = (ev) => {
      ev.stopPropagation();
      const inp = el('input', 't-edit'); inp.type = 'text'; inp.value = c.title;
      row.replaceChild(inp, t);
      inp.focus(); inp.select();
      let done = false;
      const commit = async (ok) => {
        if (done) return; done = true;
        const title = inp.value.trim();
        if (ok && title && title !== c.title) {
          const full = await api.chats.load(c.id);
          if (full) { full.title = title; await api.chats.save(full); }
          if (state.chat && state.chat.id === c.id) state.chat.title = title;
        }
        refreshChats(); updateTitle();
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); };
      inp.onblur = () => commit(true);
      inp.onclick = (e) => e.stopPropagation();
    };
    const del = iconButton('trash', 'Chat löschen', 'row-btn del', 14);
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Chat „${c.title}“ endgültig löschen?`)) return;
      await api.chats.remove(c.id);
      if (state.chat && state.chat.id === c.id) await openChat(null);
      else await refreshChats();
    };
    row.append(ren, del);
    row.onclick = () => openChat(c.id);
    box.appendChild(row);
  }
}

function updateTitle() {
  $('chatTitle').textContent = state.chat && state.chat.messages.length ? state.chat.title : '';
}

async function openChat(id) {
  if (state.streaming) return hint('Bitte warte, bis die Antwort fertig ist (oder klicke auf Stopp).');
  stopAllSpeech();
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
  updateTitle();
  if (!state.chat.messages.length) {
    box.appendChild($('empty') || makeEmpty());
    renderGreeting();
    return;
  }
  const last = state.chat.messages.length - 1;
  state.chat.messages.forEach((m, i) => box.appendChild(buildMsg(m, i === last)));
  box.scrollTop = box.scrollHeight;
}
function makeEmpty() {
  const d = el('div', 'empty'); d.id = 'empty';
  d.innerHTML = '<div class="logo big">FA</div><h1 id="greeting"></h1><p>Alles läuft lokal auf diesem PC.</p>';
  return d;
}

function buildMsg(m, isLast = false) {
  const wrap = el('div', 'msg ' + m.role);
  wrap.appendChild(el('div', 'bubble'));
  fillMsg(wrap, m, false, isLast);
  return wrap;
}

function fillMsg(wrap, m, live = false, isLast = false) {
  const body = wrap.querySelector('.bubble');
  body.innerHTML = '';
  wrap.querySelectorAll('.chips,.msg-actions').forEach((n) => n.remove());
  if (m.role === 'user') {
    body.textContent = m.content;
    if (m.attachments && m.attachments.length) {
      const chips = el('div', 'chips');
      for (const a of m.attachments) {
        const c = el('span', 'chip');
        c.innerHTML = icon(a.note && /Bild/.test(a.note) ? 'image' : 'file', 14);
        c.appendChild(document.createTextNode(a.name + (a.note ? ' · ' + a.note : '')));
        chips.appendChild(c);
      }
      wrap.appendChild(chips);
    }
    return;
  }
  if (m.thinking) {
    const d = el('details', 'think');
    const open = wrap._thinkOpen !== undefined ? wrap._thinkOpen : !!(live && state.settings.thinkLive);
    d.open = open;
    d.addEventListener('toggle', () => { wrap._thinkOpen = d.open; });
    let label = 'Gedankengang anzeigen';
    if (live && !m.content) {
      if (!m._t0) m._t0 = Date.now();
      label = `Denkt nach … (${Math.round((Date.now() - m._t0) / 1000)} s)`;
    }
    d.appendChild(el('summary', null, label));
    const tt = el('div', 'tt', m.thinking);
    d.appendChild(tt);
    body.appendChild(d);
    if (open && live) requestAnimationFrame(() => { tt.scrollTop = tt.scrollHeight; });
  }
  const md = el('div', 'md');
  md.innerHTML = renderMd(m.content);
  md.querySelectorAll('pre').forEach((pre) => {
    const b = el('button', 'copybtn', 'Kopieren');
    b.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText);
      b.textContent = 'Kopiert ✓'; setTimeout(() => { b.textContent = 'Kopieren'; }, 1500);
    };
    pre.appendChild(b);
  });
  md.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
  body.appendChild(md);
  if (m.error) body.appendChild(el('div', 'err', m.error));
  if (m.stats && m.stats.evalCount && m.stats.evalDuration) {
    body.appendChild(el('div', 'stats', `${(m.stats.evalCount / (m.stats.evalDuration / 1e9)).toFixed(1).replace('.', ',')} Token/s`));
  }
  if (!live) {
    const ac = el('div', 'msg-actions');
    const cp = iconButton('copy', 'Kopieren');
    cp.onclick = () => { navigator.clipboard.writeText(m.content); cp.innerHTML = icon('check'); setTimeout(() => { cp.innerHTML = icon('copy'); }, 1500); };
    const sp = iconButton('speaker', 'Vorlesen');
    sp.onclick = () => speakNow(m.content);
    const pdfB = el('button', 'txt-btn', 'PDF'); pdfB.title = 'Als PDF speichern';
    pdfB.onclick = () => saveText(m.content, 'pdf');
    const docB = el('button', 'txt-btn', 'Word'); docB.title = 'Als Word-Datei speichern';
    docB.onclick = () => saveText(m.content, 'docx');
    ac.append(cp, sp, pdfB, docB);
    if (isLast) {
      const rg = iconButton('refresh', 'Antwort neu erzeugen');
      rg.onclick = regenerate;
      ac.appendChild(rg);
    }
    wrap.appendChild(ac);
  }
}

// ---------- Senden ----------
function setBusy(on) {
  $('btnSend').classList.toggle('hidden', on);
  $('btnStop').classList.toggle('hidden', !on);
}

function systemText() {
  const s = state.settings;
  const parts = ['Du bist "FA KI", der persönliche KI-Assistent in der Desktop-App "FA KI Desktop". Du läufst lokal auf dem Computer des Nutzers; seine Daten verlassen den Computer nicht. Wenn jemand fragt, wer du bist, sage das und nenne dich nicht ChatGPT, Claude oder anders.'];
  if (s.systemPrompt && s.systemPrompt.trim()) parts.push(s.systemPrompt.trim());
  const pp = profilePrompt(activeProfile());
  if (pp) parts.push(pp);
  return parts.join('\n\n');
}

/**
 * Baut den Verlauf für Ollama und hält ihn innerhalb der Kontextlänge:
 * Dateien und Bilder gehen nur mit der neuesten Nachricht vollständig mit, ältere werden gekürzt,
 * und die ältesten Runden fallen weg, wenn das Zeichenbudget (≈ num_ctx × 2,6) überschritten wird.
 */
function buildOllamaMessages() {
  const sys = systemText();
  const all = state.chat.messages.filter((m) => m.role !== 'assistant' || m.content);
  const lastUser = all.map((m) => m.role).lastIndexOf('user');
  const budget = Math.max(6000, Math.floor(state.settings.numCtx * 2.6) - 2000) - (sys ? sys.length : 0);
  const out = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    let o;
    if (m.role === 'assistant') o = { role: 'assistant', content: m.content };
    else {
      const ctx = m.ctx ? (i === lastUser ? m.ctx : fitText(m.ctx, 1500).text) : '';
      o = { role: 'user', content: (ctx ? ctx + '\n\n' : '') + m.content };
      if (i === lastUser && m.images && m.images.length) o.images = m.images;
    }
    const len = o.content.length;
    if (out.length && used + len > budget) break; // neueste Nachricht immer mitschicken
    used += len;
    out.unshift(o);
  }
  if (sys) out.unshift({ role: 'system', content: sys });
  return out;
}

async function send() {
  if (state.streaming) return;
  const text = $('input').value.trim();
  if (!text && !state.pending.length) return;
  const model = $('modelSel').value;
  if (!model) return hint('Bitte zuerst ein Modell installieren (links unten „Modelle verwalten“).');
  if (!(await refreshStatus())) return;
  stopAllSpeech();
  if (!state.chat) state.chat = newChat();
  const caps = await getCaps(model);

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
      } else hint('Dieses Modell kann keine Bilder sehen – nutze ein Modell mit Bild-Fähigkeit.');
    }
  }
  const userMsg = {
    role: 'user',
    content: text || 'Bitte lies die angehängte Datei und fasse sie zusammen.',
    attachments, ctx: ctxParts.join('\n\n'), images,
  };
  state.chat.messages.push(userMsg);
  if (state.chat.title === 'Neuer Chat') state.chat.title = (text || attachments[0]?.name || 'Chat').slice(0, 42);
  state.chat.model = model;
  state.pending = [];
  renderPending();
  $('input').value = '';
  autosize();
  $('empty')?.remove();
  $('messages').querySelectorAll('.msg-actions').forEach((n) => n.remove());
  $('messages').appendChild(buildMsg(userMsg));
  await runAssistant();
}

async function runAssistant() {
  const model = $('modelSel').value;
  const caps = await getCaps(model);
  const history = buildOllamaMessages();
  const asst = { role: 'assistant', content: '', thinking: '' };
  state.chat.messages.push(asst);
  const wrap = buildMsg(asst, false);
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
  updateTitle();

  const id = newId();
  state.streaming = { id, asst, wrap };
  setBusy(true);
  const think = buildThink(model, caps, $('thinkSel').value);
  const ka = state.settings.keepAlive;
  const body = {
    model,
    messages: history,
    options: { num_ctx: state.settings.numCtx, temperature: state.settings.temperature },
    keep_alive: ka === '-1' ? -1 : ka,
  };
  if (think !== undefined) body.think = think;
  api.chat.start({ id, body });
  api.chats.save(state.chat);
}

async function regenerate() {
  if (state.streaming) return;
  const msgs = state.chat.messages;
  if (!msgs.length || msgs[msgs.length - 1].role !== 'assistant') return;
  msgs.pop();
  renderAll();
  await runAssistant();
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const s = state.streaming;
    if (!s) return;
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
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
  fillMsg(s.wrap, s.asst, false, true);
  await api.chats.save(state.chat);
  await refreshChats();
  if ((state.settings.ttsAuto || state.conv) && s.asst.content && !s.asst.error && !(extra && extra.aborted)) await speakNow(s.asst.content);
  if (state.conv) convListen();
}
api.chat.onDone(({ id, stats, aborted }) => finishStream(id, { stats, aborted }));
api.chat.onError(({ id, error }) => finishStream(id, { error }));

// ---------- Vorlesen ----------
async function speakNow(text, settingsOverride) {
  const s = settingsOverride || state.settings;
  try {
    state.speechStatus = await api.speech.status();
    await speak(text, {
      voicePref: s.ttsVoice,
      speechStatus: state.speechStatus,
      speed: s.ttsSpeed || 1,
      engine: s.ttsEngine || 'piper',
      serverLangs: s.ttsEngine === 'supertonic' ? 'all' : (s.ttsServerLangs || 'all'),
      onWarn: (m) => hint((s.ttsEngine === 'supertonic' ? 'Supertonic ist gerade nicht bereit' : 'Meine Stimme (OuteTTS) ist gerade nicht bereit') + ', es spricht Piper bzw. die Windows-Stimme: ' + m, 0),
      onState: (on) => { state.speaking = on; $('btnStopSpeak').classList.toggle('hidden', !on); },
    });
  } catch (e) { hint('Vorlesen fehlgeschlagen: ' + (e.message || e)); }
}
function stopAllSpeech() {
  stopSpeaking();
  state.speaking = false;
  $('btnStopSpeak').classList.add('hidden');
}

function renderTtsButton() {
  const b = $('btnTts');
  b.classList.toggle('on', !!state.settings.ttsAuto);
  b.innerHTML = icon(state.settings.ttsAuto ? 'speaker' : 'speakerOff');
  b.title = state.settings.ttsAuto ? 'Antworten werden automatisch vorgelesen (Klick zum Ausschalten)' : 'Antworten automatisch vorlesen';
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

async function transcribeWav(wav) {
  if (!wav) { hint('Es wurde nichts gesprochen.'); return ''; }
  showProgress('Sprache wird erkannt', null);
  try { return await api.speech.transcribe({ wav, lang: state.settings.sttLang, model: state.settings.sttModel }); }
  catch (e) { hint('Erkennung fehlgeschlagen: ' + (e.message || e), 0); return ''; }
  finally { hideProgress(); }
}

async function toggleMic() {
  if (state.rec) { state.rec.stop(); return; }
  if (!(await ensureStt())) return;
  try { stopAllSpeech(); state.rec = await startRecording({ vad: false }); }
  catch (e) { return hint('Mikrofon nicht verfügbar: ' + (e.message || e), 0); }
  $('btnMic').classList.add('rec');
  hint('Aufnahme läuft … nochmal auf das Mikrofon klicken zum Beenden.', 0);
  const wav = await state.rec.done;
  state.rec = null;
  $('btnMic').classList.remove('rec');
  hint('');
  const t = await transcribeWav(wav);
  if (t) {
    const cur = $('input').value;
    $('input').value = (cur ? cur + ' ' : '') + t;
    autosize();
    if (state.settings.autoSend) send();
  }
}

async function convListen() {
  if (!state.conv || state.rec || state.streaming) return;
  try { state.rec = await startRecording({ vad: true }); }
  catch (e) { state.conv = false; $('btnConv').classList.remove('rec'); return hint('Mikrofon nicht verfügbar: ' + (e.message || e), 0); }
  hint('Ich höre zu … sprich einfach.', 0);
  const wav = await state.rec.done;
  state.rec = null;
  if (!state.conv) return;
  if (!wav) return convListen();
  hint('');
  const t = await transcribeWav(wav);
  if (!state.conv) return;
  if (t && t.length > 1) { $('input').value = t; await send(); } else convListen();
}

async function toggleConv() {
  if (state.conv) {
    state.conv = false;
    $('btnConv').classList.remove('rec');
    if (state.rec) state.rec.cancel();
    stopAllSpeech(); hint('Gesprächsmodus beendet.');
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
    a.innerHTML = icon(p.kind === 'image' ? 'image' : 'file', 14);
    a.appendChild(document.createTextNode(p.name + (p.note ? ' · ' + p.note : '')));
    const x = iconButton('x', 'Entfernen', '', 14);
    x.onclick = () => { state.pending.splice(i, 1); renderPending(); };
    a.appendChild(x);
    box.appendChild(a);
  });
}

/** Textdatei dekodieren: UTF-8 (mit/ohne BOM), UTF-16 (BOM) oder Windows-1252 (ANSI, z. B. Excel-CSV). */
function decodeText(u8) {
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { return new TextDecoder('windows-1252').decode(u8); }
}

async function addFile(name, data) {
  try {
    if (isPdf(name)) {
      showProgress('PDF wird gelesen', null);
      const r = await readPdf(data, (t) => showProgress(t, null));
      const note = (r.readPages < r.pageCount ? `nur ${r.readPages} von ${r.pageCount} Seiten` : `${r.readPages} Seiten`) + (r.ocrPages ? `, ${r.ocrPages} per OCR` : '');
      if (r.readPages < r.pageCount) hint(`„${name}“ hat ${r.pageCount} Seiten – gelesen werden nur die ersten ${r.readPages}.`, 0);
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
      const text = decodeText(data instanceof Uint8Array ? data : new Uint8Array(data));
      state.pending.push({ kind: 'doc', name, text, note: `${text.length} Zeichen` });
    }
  } catch (e) { hint(`„${name}“ konnte nicht gelesen werden: ${e.message || e}`, 0); }
  finally { hideProgress(); }
  renderPending();
}
async function pickFiles() {
  for (const f of await api.files.pick()) await addFile(f.name, f.data);
}

// ---------- Modelle-Dialog ----------
async function openModels() {
  const render = async (m) => {
    m.innerHTML = '';
    m.appendChild(el('h2', null, 'Modelle verwalten'));
    let list = [];
    try { list = await api.ollama.models(); } catch { m.appendChild(el('div', 'err', 'Ollama nicht erreichbar.')); }
    m.appendChild(el('h3', null, 'Installiert'));
    if (!list.length) m.appendChild(el('div', 'note', 'Noch keine Modelle installiert.'));
    for (const x of list) {
      const r = el('div', 'list-row');
      const g = el('div', 'grow'); g.appendChild(el('div', null, x.name));
      g.appendChild(el('div', 'sub', (x.size ? formatBytes(x.size) : 'Cloud') + (x.details.parameter_size ? ' · ' + x.details.parameter_size : '')));
      r.appendChild(g);
      if (x.remote) r.appendChild(el('span', 'badge warn', 'Cloud – nicht lokal'));
      const d = el('button', 'btn small danger', 'Löschen');
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
    const go = el('button', 'btn primary', 'Laden');
    inl.append(inp, go);
    m.appendChild(inl);
    const sugg = el('div', 'chips-row');
    for (const s of ['gpt-oss:20b', 'gemma4:12b']) {
      const c = el('button', 'btn small', s); c.onclick = () => { inp.value = s; }; sugg.appendChild(c);
    }
    m.appendChild(sugg);
    const prog = el('div', 'note', ''); prog.style.marginTop = '10px';
    m.appendChild(prog);
    if (m._offPull) m._offPull(); // beim Neuaufbau alten Listener entfernen
    const off = api.ollama.onPull((p) => {
      prog.textContent = p.total ? `${p.name}: ${p.status} – ${Math.round((p.completed / p.total) * 100)} % (${formatBytes(p.completed)} / ${formatBytes(p.total)})` : `${p.name}: ${p.status}`;
    });
    m._offPull = off;
    go.onclick = async () => {
      const name = inp.value.trim();
      if (!name) return;
      if (/cloud/i.test(name) && !confirm('Cloud-Modelle laufen NICHT lokal und senden Daten an fremde Server. Trotzdem laden?')) return;
      go.disabled = true; go.textContent = 'Lädt …';
      try {
        const r = await api.ollama.pull(name);
        if (r && r.aborted) { prog.textContent = 'Download abgebrochen.'; go.disabled = false; go.textContent = 'Laden'; return; }
        await loadModels(); render(m);
      } catch (e) { prog.textContent = 'Fehler: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); go.disabled = false; go.textContent = 'Laden'; }
    };
    const act = el('div', 'actions');
    const stop = el('button', 'btn', 'Download abbrechen'); stop.onclick = () => api.ollama.pullCancel();
    const close = el('button', 'btn primary', 'Schließen'); close.onclick = () => { off(); m._offPull = null; closeModal(); };
    act.append(stop, close);
    m.appendChild(act);
  };
  openModal(render);
}

// ---------- Einstellungen ----------
function showSettings(tab) {
  openSettings({
    get settings() { return state.settings; },
    api,
    apply: applyAppearance,
    hint, showProgress, hideProgress,
    onSaved: async (next) => {
      state.settings = next;
      applyAppearance(next);
      renderProfileSelect(); renderGreeting(); renderTtsButton();
      await refreshStatus(); await loadModels();
    },
    speakSample: (text, draft) => speakNow(text, draft),
    stopSpeaking: stopAllSpeech,
    onChatsCleared: async () => { state.chat = newChat(); renderAll(); await refreshChats(); },
  }, tab);
}

// ---------- Export ----------
async function saveText(markdown, format) {
  try {
    const title = (state.chat && state.chat.title) || 'Antwort';
    const r = await api.chats.export({ title, markdown, format });
    if (r) hint('Gespeichert: ' + r);
  } catch (e) { hint('Speichern fehlgeschlagen: ' + (e.message || e)); }
}

async function exportChat() {
  if (!state.chat || !state.chat.messages.length) return hint('Dieser Chat ist noch leer.');
  const md = `# ${state.chat.title}\n\n` + state.chat.messages.map((m) => `**${m.role === 'user' ? 'Du' : 'KI'}:**\n\n${m.content}`).join('\n\n---\n\n');
  await saveText(md, 'pdf');
}

// ---------- Eingabe ----------
function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(240, t.scrollHeight) + 'px';
}

function toggleSidebar(open) {
  $('sidebar').classList.toggle('closed', !open);
  $('btnSidebarOpen').classList.toggle('hidden', open);
  api.settings.set({ sidebarOpen: open });
}

function buildTemplateMenu() {
  const menu = $('tplMenu');
  menu.innerHTML = '';
  menu.appendChild(el('div', 'menu-h', 'E-Mail- und Schreibhilfe'));
  for (const [, label, prompt] of TEMPLATES) {
    const b = el('button', null, label);
    b.onclick = () => {
      $('input').value = prompt + $('input').value;
      autosize(); $('input').focus(); menu.classList.add('hidden');
    };
    menu.appendChild(b);
  }
}

function wire() {
  $('btnSend').onclick = send;
  $('btnStop').onclick = () => state.streaming && api.chat.stop(state.streaming.id);
  $('newChat').onclick = () => openChat(null);
  $('btnSettings').onclick = () => showSettings('general');
  $('btnModels').onclick = openModels;
  $('btnAttach').onclick = pickFiles;
  $('btnMic').onclick = toggleMic;
  $('btnConv').onclick = toggleConv;
  $('btnExport').onclick = exportChat;
  $('btnStopSpeak').onclick = stopAllSpeech;
  $('btnSidebar').onclick = () => toggleSidebar(false);
  $('btnSidebarOpen').onclick = () => toggleSidebar(true);
  $('chatSearch').oninput = (e) => { state.search = e.target.value; refreshChats(); };
  $('btnTts').onclick = async () => {
    state.settings = await api.settings.set({ ttsAuto: !state.settings.ttsAuto });
    renderTtsButton();
    if (!state.settings.ttsAuto) stopAllSpeech();
  };
  $('btnTpl').onclick = (e) => { e.stopPropagation(); $('tplMenu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('tplMenu').classList.add('hidden'));
  $('modelSel').onchange = () => onModelChanged(true);
  $('thinkSel').onchange = async () => { state.settings = await api.settings.set({ think: $('thinkSel').value }); };
  $('profileSel').onchange = async () => {
    state.settings = await api.settings.set({ activeProfile: $('profileSel').value });
    renderGreeting();
    hint($('profileSel').value ? 'Profil gewählt: die KI nutzt jetzt diese Absenderangaben.' : 'Kein Profil aktiv.');
  };
  $('input').addEventListener('input', autosize);
  $('input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const sendOnEnter = state.settings.sendOnEnter !== false;
    if ((sendOnEnter && !e.shiftKey && !e.ctrlKey) || (!sendOnEnter && e.ctrlKey)) { e.preventDefault(); send(); }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) await addFile(f.name, new Uint8Array(await f.arrayBuffer()));
  });
  $('input').addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData.items);
    // Enthält die Zwischenablage auch Text (z. B. aus Word oder Webseiten), wird ganz normal Text eingefügt.
    if (items.some((x) => x.type === 'text/plain' || x.type === 'text/html')) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); await addFile('Bild-' + Date.now() + '.png', new Uint8Array(await f.arrayBuffer())); }
      }
    }
  });
  $('overlay').addEventListener('mousedown', (e) => {
    if (e.target === $('overlay') && !$('modal').classList.contains('wide')) closeModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('overlay').classList.contains('hidden')) closeModal();
      else if (state.speaking) stopAllSpeech();
    }
  });
}

async function init() {
  state.settings = await api.settings.get();
  applyAppearance(state.settings);
  applyIcons();
  buildTemplateMenu();
  renderProfileSelect();
  renderTtsButton();
  if (state.settings.sidebarOpen === false) toggleSidebar(false);
  wire();
  api.app.onOllamaStart((r) => { if (r && r.started) { hint('Ollama wurde automatisch gestartet.'); refreshStatus().then(loadModels).catch(() => {}); } else if (r && !r.ok) hint('Ollama ließ sich nicht automatisch starten: ' + (r.error || ''), 0); });
  api.app.onTtsStart((r) => { if (r && r.started) hint('Stimmen-Server wurde gestartet.'); else if (r && !r.ok) hint('Stimmen-Server: ' + (r.error || 'nicht gestartet'), 0); });
  state.chat = newChat();
  await refreshStatus();
  await loadModels();
  await refreshChats();
  renderAll();
  setInterval(() => { if (!state.streaming) refreshStatus().catch(() => {}); }, 20000);
}

init().catch((e) => { console.error(e); hint('Startfehler: ' + (e.message || e), 0); });
