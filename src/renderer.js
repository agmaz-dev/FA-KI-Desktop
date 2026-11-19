import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { readPdf, prepareImage, isPdf, isImage } from './docs.js';
import { startRecording, speak, stopSpeaking } from './audio.js';
import { fitText, formatBytes } from '../lib/util.js';
import { buildThink } from '../lib/think.js';
import { $, el, icon, iconButton, applyIcons, newId } from './ui.js';
import { openSettings, profilePrompt } from './settings.js';
import { mountExplore, mountLibrary } from './models.js';

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
function applyAppearance(s) {
  const theme = s.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--fs', (s.fontSize || 16) + 'px');
  const stack = (name, fallback) => { const n = String(name || '').replace(/["';{}<>\\]/g, '').trim(); return n ? `"${n}", ${fallback}` : fallback; };
  const root = document.documentElement.style;
  root.setProperty('--font-sans', stack(s.fontUi, 'system-ui, sans-serif'));
  root.setProperty('--font-answer', stack(s.fontAnswer, 'Georgia, serif'));
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
const hideProgress = () => $('progressBar').classList.add('hidden');

api.speech.onProgress((p) => {
  const extra = p.total ? ` (${formatBytes(p.received)} / ${formatBytes(p.total)})` : '';
  showProgress((p.label || 'Download') + extra, p.pct);
});

// ---------- Seitenfenster: Browser und Vorschau neben dem Chat ----------
const panelSt = { open: false, mode: '', canBack: false, canForward: false };
function panelWidth() {
  let w = 520;
  try { w = parseInt(localStorage.getItem('fa.panelW'), 10) || 520; } catch { /* egal */ }
  return Math.min(Math.max(w, 320), Math.max(360, window.innerWidth - 560));
}
function panelSync() {
  const chat = !$('viewChat').classList.contains('hidden');
  const show = panelSt.open && chat;
  $('panel').classList.toggle('hidden', !show);
  $('panelSplit').classList.toggle('hidden', !show);
  if (show) $('panel').style.setProperty('--panelw', panelWidth() + 'px');
  const r = $('panelBody').getBoundingClientRect();
  api.panel.bounds({ rect: { x: r.x, y: r.y, width: r.width, height: r.height }, visible: show });
}
function panelShow() { panelSt.open = true; panelSync(); requestAnimationFrame(panelSync); }
async function openPanelUrl(url) { panelShow(); try { await api.panel.openUrl(url); } catch (e) { hint(cleanErr(e), 0); } }
async function openPanelHtml(html, title) { panelShow(); try { await api.panel.html({ html, title }); } catch (e) { hint(cleanErr(e), 0); } }
function cleanErr(e) { return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
/** Holt ein vollständiges HTML-Dokument aus einer Antwort (```html-Block oder Dokument im Codeblock). */
let liveHtmlAt = 0; let liveHtmlLen = 0;
function extractHtml(md) {
  const re = /```[a-zA-Z]*\s*\n([\s\S]*?)```/g;
  let m; let best = '';
  while ((m = re.exec(md || ''))) if (/^\s*(<!doctype html|<html)/i.test(m[1])) best = m[1];
  return best;
}
function initPanel() {
  api.panel.onState((s) => {
    panelSt.open = !!s.open; panelSt.mode = s.mode || ''; panelSt.canBack = !!s.canBack; panelSt.canForward = !!s.canForward;
    const tabsEl = $('pTabs'); tabsEl.textContent = '';
    (s.tabs || []).forEach((t) => {
      const b = document.createElement('div'); b.className = 'ptab' + (t.id === s.active ? ' on' : ''); b.title = t.title;
      const tt = document.createElement('span'); tt.className = 't'; tt.textContent = t.title;
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Tab schließen';
      x.onclick = (ev) => { ev.stopPropagation(); api.panel.closeTab(t.id); };
      b.onclick = () => api.panel.selectTab(t.id);
      b.append(tt, x); tabsEl.appendChild(b);
    });
    const plus = document.createElement('button'); plus.className = 'ptab-new'; plus.textContent = '+'; plus.title = 'Neuer Tab';
    plus.onclick = () => { api.panel.newTab(''); setTimeout(() => $('pUrl').focus(), 120); };
    tabsEl.appendChild(plus);
    const web = s.mode !== 'html';
    $('pTitle').classList.toggle('hidden', web); $('pUrl').classList.toggle('hidden', !web);
    $('pTitle').textContent = s.open && !web ? (s.title || '') : '';
    if (web && document.activeElement !== $('pUrl')) $('pUrl').value = s.url && s.url !== 'about:blank' ? s.url : '';
    $('pBack').disabled = !s.canBack; $('pFwd').disabled = !s.canForward;
    $('pReload').classList.toggle('hidden', s.mode === 'html');
    $('pBack').classList.toggle('hidden', s.mode === 'html'); $('pFwd').classList.toggle('hidden', s.mode === 'html');
    $('pExt').classList.toggle('hidden', s.mode === 'html');
    panelSync();
  });
  const goUrl = () => {
    let v = $('pUrl').value.trim(); if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = /^[^\s]+\.[a-z]{2,}([\/?#:].*)?$/i.test(v) ? 'https://' + v : 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
    openPanelUrl(v); $('pUrl').blur();
  };
  $('pUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') goUrl(); });
  $('pUrl').addEventListener('focus', () => $('pUrl').select());
  $('btnBrowser').onclick = () => { if (panelSt.open && panelSt.mode === 'web') { $('pUrl').focus(); return; } panelShow(); openPanelUrl('https://duckduckgo.com/'); setTimeout(() => $('pUrl').focus(), 150); };
  $('pBack').onclick = () => api.panel.nav('back');
  $('pFwd').onclick = () => api.panel.nav('forward');
  $('pReload').onclick = () => api.panel.nav('reload');
  $('pExt').onclick = () => api.panel.external();
  $('pClose').onclick = () => { panelSt.open = false; api.panel.close(); panelSync(); };
  $('pPdf').onclick = async () => { try { const p = await api.panel.pdf(); if (p) hint('Gespeichert: ' + p); } catch (e) { hint(cleanErr(e), 0); } };
  const split = $('panelSplit');
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault(); split.setPointerCapture(e.pointerId); split.classList.add('drag');
    const x0 = e.clientX; const w0 = panelWidth();
    const mv = (ev) => {
      const w = Math.min(Math.max(w0 + (x0 - ev.clientX), 320), Math.max(360, window.innerWidth - 560));
      $('panel').style.setProperty('--panelw', w + 'px');
      try { localStorage.setItem('fa.panelW', String(Math.round(w))); } catch { /* egal */ }
      panelSync();
    };
    const up = () => { split.classList.remove('drag'); split.removeEventListener('pointermove', mv); split.removeEventListener('pointerup', up); };
    split.addEventListener('pointermove', mv); split.addEventListener('pointerup', up);
  });
  new ResizeObserver(panelSync).observe($('panelBody'));
  window.addEventListener('resize', panelSync);
}

// ---------- Auslastung (GPU, CPU, RAM) ----------
function setMeter(id, pct, text) {
  $('m' + id).style.width = (pct == null ? 0 : pct) + '%';
  $('m' + id + 'T').textContent = text;
}
function startMeters() {
  const tick = async () => {
    try {
      const s = await api.sys.stats();
      setMeter('Gpu', s.gpu, s.gpu == null ? '–' : s.gpu + ' %');
      setMeter('Cpu', s.cpu, s.cpu + ' %');
      setMeter('Ram', Math.round((s.ramUsed / s.ramTotal) * 100), formatBytes(s.ramUsed));
    } catch { /* egal */ }
  };
  tick();
  setInterval(tick, 2000);
}

// ---------- Status & Modelle ----------
async function refreshStatus() {
  const s = await api.models.status();
  const box = $('status');
  box.classList.toggle('ok', s.ok);
  box.classList.toggle('bad', !s.ok);
  $('statusText').textContent = s.ok ? `Eigene Engine ${s.version || ''} · alles lokal`.replace('  ', ' ') : 'Engine fehlt';
  if (!s.ok) hint(s.error || 'Die Rechen-Engine fehlt.', 0);
  return s.ok;
}

async function loadModels() {
  try { state.models = await api.models.list(); } catch { state.models = []; }
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
  renderModelMenu();
}

// ---------- Modell-Auswahl in der Eingabeleiste ----------
function renderModelMenu() {
  const name = $('modelSel').value;
  $('modelBtnText').textContent = name || 'Kein Modell';
  const f = $('modelFilter').value.trim().toLowerCase();
  const box = $('modelList');
  box.innerHTML = '';
  const visible = state.models.filter((m) => (state.settings.showCloud || !m.remote) && (!f || m.name.toLowerCase().includes(f)));
  if (!visible.length) box.appendChild(el('div', 'note menu-note', state.models.length ? 'Kein Treffer.' : 'Noch kein Modell installiert.'));
  for (const m of visible) {
    const b = el('button', 'model-item' + (m.name === name ? ' active' : ''));
    b.type = 'button';
    b.appendChild(el('span', 'mi-name', m.name + (m.remote ? ' (Cloud!)' : '')));
    b.appendChild(el('span', 'mi-size', m.size ? formatBytes(m.size) : 'Cloud'));
    b.onclick = async () => {
      $('modelSel').value = m.name;
      closeMenus();
      renderModelMenu();
      await onModelChanged(true);
      updateCtxInfo();
    };
    box.appendChild(b);
  }
}

async function getCaps(name) {
  if (!name) return [];
  if (!state.caps[name]) {
    // Fehler (z. B. Engine startet noch) nicht merken, sonst bleiben Denken/Bilder bis zum Neustart aus.
    try { state.caps[name] = (await api.models.show(name)).capabilities || []; } catch { return []; }
  }
  return state.caps[name];
}

async function onModelChanged(save = true) {
  const name = $('modelSel').value;
  const caps = await getCaps(name);
  $('thinkField').classList.toggle('hidden', !caps.includes('thinking'));
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
  $('modelBtnText').textContent = name || 'Kein Modell';
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
  updateCtxInfo();
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
    const open = !!wrap._thinkOpen; // immer zu, außer Du klickst darauf
    d.open = open;
    d.addEventListener('toggle', () => { wrap._thinkOpen = d.open; });
    let label = 'Gedanken';
    if (live && !m.content) {
      if (!m._t0) m._t0 = Date.now();
      label = `Denkt nach … (${Math.round((Date.now() - m._t0) / 1000)} s)`;
    }
    d.appendChild(el('summary', null, label));
    const tt = el('div', 'tt', String(m.thinking).replace(/<\/?think>/gi, ''));
    d.appendChild(tt);
    body.appendChild(d);
    if (open && live) requestAnimationFrame(() => { tt.scrollTop = tt.scrollHeight; });
  }
  if (m.tools && m.tools.length) {
    const tl = el('details', 'think toolfold');
    tl.appendChild(el('summary', null, m.tools.length === 1 ? '1 Werkzeug-Aktion' : m.tools.length + ' Werkzeug-Aktionen'));
    tl.appendChild(el('div', 'tt', m.tools.join('\n')));
    body.appendChild(tl);
  }
  const md = el('div', 'md');
  md.innerHTML = renderMd(m.content);
  md.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code') ? pre.querySelector('code').innerText : pre.innerText;
    if (/^\s*(<!doctype html|<html)/i.test(code)) {
      // Ganze Webseiten/Folien: kein Code im Chat, nur eine kleine Karte; die Seite läuft rechts in der Vorschau.
      const card = el('div', 'htmlcard');
      card.appendChild(el('span', 'hc-t', live && !m.error ? 'Seite wird erstellt …' : 'Webseite / Folien'));
      const pv = el('button', 'btn small', 'Vorschau öffnen');
      pv.onclick = () => openPanelHtml(code, 'Vorschau');
      const cp = el('button', 'btn small', 'Code kopieren');
      cp.onclick = () => { navigator.clipboard.writeText(code); cp.textContent = 'Kopiert ✓'; setTimeout(() => { cp.textContent = 'Code kopieren'; }, 1500); };
      card.append(pv, cp);
      pre.replaceWith(card);
      if (live && Date.now() - (liveHtmlAt || 0) > 2500 && code.length > (liveHtmlLen || 0) + 200) { liveHtmlAt = Date.now(); liveHtmlLen = code.length; openPanelHtml(code, 'Vorschau'); }
      return;
    }
    const b = el('button', 'copybtn', 'Kopieren');
    b.onclick = () => {
      navigator.clipboard.writeText(code);
      b.textContent = 'Kopiert ✓'; setTimeout(() => { b.textContent = 'Kopieren'; }, 1500);
    };
    pre.appendChild(b);
  });
  md.querySelectorAll('a').forEach((a) => {
    a.target = '_blank'; a.rel = 'noreferrer';
    a.addEventListener('click', (e) => {
      if (/^https?:\/\//i.test(a.href) && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); openPanelUrl(a.href); }
    });
  });
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
  parts.push('Soll etwas gezeigt werden (Webseite, Folien, Grafik, Tabelle, Entwurf), schreibe ein vollständiges, eigenständiges HTML-Dokument in genau einem ```html-Block: alles inline (CSS und JavaScript im Dokument), keine Bilder oder Dateien aus dem Internet. Es erscheint sofort als Vorschau rechts neben dem Chat. Folien: jede Folie ein <section> in 16:9 (1280×720), @page{size:1280px 720px;margin:0}, page-break-after:always, Wechsel mit den Pfeiltasten. Danach höchstens zwei Sätze Erklärung.');
  if (s.systemPrompt && s.systemPrompt.trim()) parts.push(s.systemPrompt.trim());
  const pp = profilePrompt(activeProfile());
  if (pp) parts.push(pp);
  return parts.join('\n\n');
}

/**
 * Baut den Verlauf für die Engine und hält ihn innerhalb der Kontextlänge:
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
  if (!model) { hint('Bitte zuerst ein Modell laden (Modelle).'); return showView('settings', 'explore'); }
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
  const body = {
    model,
    messages: history,
    options: { num_ctx: state.settings.numCtx, temperature: state.settings.temperature },
  };
  if (think !== undefined) body.think = think;
  const useTools = caps.includes('tools') && (state.settings.webTools !== false || state.settings.githubTools !== false || state.settings.agentTools !== false);
  api.chat.start({ id, chatId: state.chat.id, body, useTools });
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

api.chat.onTool(({ id, label }) => {
  const s = state.streaming;
  if (!s || s.id !== id) return;
  (s.asst.tools = s.asst.tools || []).push(label);
  scheduleRender();
});

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
  if (s.asst.content && !s.asst.error && !(extra && extra.aborted)) { const h = extractHtml(s.asst.content); if (h) openPanelHtml(h, 'Vorschau'); }
  liveHtmlLen = 0; liveHtmlAt = 0;
  updateCtxInfo();
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
      engine: s.ttsEngine === 'server' ? 'server' : 'supertonic',
      onWarn: (m) => hint((s.ttsEngine === 'supertonic' ? 'Supertonic ist gerade nicht bereit' : 'Meine Stimme (OuteTTS) ist gerade nicht bereit') + ', es spricht die Windows-Stimme: ' + m, 0),
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
  b.querySelector('[data-icon]').innerHTML = icon(state.settings.ttsAuto ? 'speaker' : 'speakerOff', 16);
  $('ttsLabel').textContent = state.settings.ttsAuto ? 'Automatisches Vorlesen ist an (Klick: aus)' : 'Antworten automatisch vorlesen';
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
  api.speech.warmStt(state.settings.sttModel).catch(() => {}); // Modell lädt, während gesprochen wird
  try { stopAllSpeech(); state.rec = await startRecording({ vad: false, deviceId: state.settings.micId }); }
  catch (e) { return hint('Mikrofon nicht verfügbar: ' + (e.message || e), 0); }
  $('btnMic').classList.add('rec');
  hint('Aufnahme läuft … nochmal auf das Mikrofon klicken zum Beenden.', 0);
  const recH = state.rec;
  const wav = await recH.done;
  state.rec = null;
  $('btnMic').classList.remove('rec');
  hint('');
  if (wav && recH.peak < 0.006) return hint('Das Mikrofon liefert fast nur Stille. Wähle unter Einstellungen → Sprache das richtige Mikrofon und prüfe die Lautstärke in Windows.', 0);
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
  api.speech.warmStt(state.settings.sttModel).catch(() => {});
  try { state.rec = await startRecording({ vad: true, deviceId: state.settings.micId }); }
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

// ---------- Seiten: Chat und Einstellungen (Erkunden und Bibliothek liegen darin) ----------
// Download-Verwaltung: gilt für die ganze App, nicht nur für eine Seite
const dl = { state: 'idle', name: '', status: '', completed: 0, total: 0, error: '' };
const dlListeners = new Set();
function dlEmit() { for (const f of [...dlListeners]) f(dl); }
function dlOn(f) { dlListeners.add(f); return () => dlListeners.delete(f); }
function dlPercent() { return dl.total ? Math.min(100, Math.round((dl.completed / dl.total) * 100)) : 0; }
function dlText() {
  if (dl.state === 'running') return dl.total ? `${dlPercent()} % · ${formatBytes(dl.completed)} / ${formatBytes(dl.total)}` : (dl.status || 'Starte …');
  if (dl.state === 'done') return 'Fertig – in der Bibliothek';
  if (dl.state === 'cancelled') return 'Abgebrochen – „Erneut laden“ setzt fort';
  if (dl.state === 'error') return 'Fehler: ' + dl.error;
  return '';
}
async function startPull(name) {
  if (dl.state === 'running') return hint('Es läuft schon ein Download.');
  Object.assign(dl, { state: 'running', name, status: 'Starte Download …', completed: 0, total: 0, error: '' });
  dlEmit();
  try {
    const r = await api.models.download(name);
    dl.state = r && r.aborted ? 'cancelled' : 'done';
    if (dl.state === 'done') { dl.completed = dl.total; await loadModels(); }
  } catch (e) {
    dl.state = 'error';
    dl.error = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  dlEmit();
}
function dlCancel() { api.models.cancel(); }
function dlDismiss() { dl.state = 'idle'; dlEmit(); }
api.models.onProgress((p) => { if (dl.state !== 'running') return; dl.status = p.status; if (p.total) { dl.total = p.total; dl.completed = p.completed; } dlEmit(); });

/** Kleine Download-Anzeige (Seitenleiste und Einstellungs-Navigation) */
function dlWidget() {
  const box = el('div', 'dl-widget hidden');
  const render = () => {
    if (!box.isConnected && box.dataset.live) { off(); return; }
    box.dataset.live = '1';
    box.innerHTML = '';
    box.classList.toggle('hidden', dl.state === 'idle');
    if (dl.state === 'idle') return;
    const nm = el('div', 'dlw-name', dl.name.replace(/^hf\.co\//, ''));
    nm.title = dl.name;
    box.appendChild(nm);
    if (dl.state === 'running') {
      const bar = el('div', 'dl-bar'); const i = document.createElement('i'); i.style.width = (dl.total ? dlPercent() : 5) + '%'; bar.appendChild(i);
      box.appendChild(bar);
    }
    box.appendChild(el('div', 'note', dlText()));
    const row = el('div', 'dlw-row');
    if (dl.state === 'running') { const b = el('button', 'btn small', 'Abbrechen'); b.onclick = dlCancel; row.appendChild(b); }
    else {
      const o = el('button', 'btn small primary', dl.state === 'done' ? 'Zur Bibliothek' : 'Erneut laden');
      o.onclick = () => (dl.state === 'done' ? (dlDismiss(), showView('settings', 'library')) : startPull(dl.name));
      const x = el('button', 'btn small', 'Schließen'); x.onclick = dlDismiss;
      row.append(o, x);
    }
    box.appendChild(row);
  };
  const off = dlOn(render);
  render();
  return box;
}

let pageCleanup = null;
function showView(name, tab) {
  if (pageCleanup) { try { pageCleanup(); } catch { /* egal */ } pageCleanup = null; }
  closeMenus();
  const chat = name === 'chat';
  $('viewChat').classList.toggle('hidden', !chat);
  $('viewPage').className = 'view' + (chat ? ' hidden' : ' page-' + name);
  $('btnSettings').classList.toggle('active', !chat && !/^(library|explore)$/.test(tab || ''));
  setTimeout(panelSync, 0);
  $('navChats').classList.toggle('active', chat);
  $('navModels').classList.toggle('active', !chat && /^(library|explore)$/.test(tab || ''));
  $('app').classList.toggle('in-settings', !chat);
  if (chat) { $('input').focus(); return; }
  showSettings(tab || 'general');
}

function modelsCtx() {
  return {
    api, hint, renderMd,
    dl, dlOn, dlText, dlPercent, startPull, dlCancel, dlDismiss,
    models: () => state.models, refreshModels: loadModels,
    useModel: async (n) => { $('modelSel').value = n; renderModelMenu(); await onModelChanged(true); showView('chat'); hint('Modell gewählt: ' + n); },
    goTab: (id) => showView('settings', id),
    currentModel: () => $('modelSel').value,
  };
}

// ---------- Einstellungen ----------
function showSettings(tab) {
  const page = $('viewPage');
  openSettings({
    get settings() { return state.settings; },
    api,
    mount: (build) => { page.innerHTML = ''; const wrap = el('div', 'settings-page'); page.appendChild(wrap); build(wrap); },
    explore: (root) => { pageCleanup = mountExplore(root, modelsCtx()); },
    library: (root) => { pageCleanup = mountLibrary(root, modelsCtx()); },
    close: () => showView('chat'),
    dlWidget,
    apply: applyAppearance,
    hint, showProgress, hideProgress,
    onSaved: async (next) => {
      state.settings = next;
      applyAppearance(next);
      renderProfileSelect(); renderGreeting(); renderTtsButton(); updateCtxInfo();
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
  const list = $('tplList');
  list.innerHTML = '';
  for (const [, label, prompt] of TEMPLATES) {
    const b = el('button', null, label);
    b.type = 'button';
    b.onclick = () => {
      $('input').value = prompt + $('input').value;
      autosize(); $('input').focus(); closeMenus();
    };
    list.appendChild(b);
  }
}

function closeMenus() {
  for (const id of ['plusMenu', 'modelMenu']) $(id).classList.add('hidden');
}
function toggleMenu(id) {
  const m = $(id);
  const open = m.classList.contains('hidden');
  closeMenus();
  if (open) { m.classList.remove('hidden'); if (id === 'modelMenu') { $('modelFilter').value = ''; renderModelMenu(); $('modelFilter').focus(); } }
}

/** Kontext-Zähler unter dem Eingabefeld: so viele Tokens hat der Chat zuletzt gebraucht. */
function updateCtxInfo() {
  const msgs = (state.chat && state.chat.messages) || [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const st = msgs[i].stats;
    if (msgs[i].role === 'assistant' && st && st.promptCount) { used = st.promptCount + (st.evalCount || 0); break; }
  }
  const max = state.settings.numCtx;
  $('ctxInfo').textContent = used ? `Kontext: ${used.toLocaleString('de-DE')} von ${max.toLocaleString('de-DE')}` : '';
  $('ctxInfo').classList.toggle('full', used > max * 0.85);
}

function wire() {
  $('dlSide').appendChild(dlWidget());
  $('btnSend').onclick = send;
  $('btnStop').onclick = () => state.streaming && api.chat.stop(state.streaming.id);
  $('newChat').onclick = () => openChat(null);
  $('btnSettings').onclick = () => showView('settings');
  $('navChats').onclick = () => showView('chat');
  $('navModels').onclick = () => showView('settings', 'library');
  startMeters();
  initPanel();
  $('btnPlus').onclick = (e) => { e.stopPropagation(); toggleMenu('plusMenu'); };
  $('modelBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('modelMenu'); };
  $('modelFilter').addEventListener('input', renderModelMenu);
  $('modelMore').onclick = () => showView('settings', 'explore');
  for (const id of ['plusMenu', 'modelMenu']) $(id).addEventListener('click', (e) => { if (e.target.closest('select,input')) e.stopPropagation(); });
  $('btnAttach').addEventListener('click', closeMenus);
  $('btnConv').addEventListener('click', closeMenus);
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
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
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
  api.app.onClipImage((png) => addFile('Bild-' + Date.now() + '.png', new Uint8Array(png)));
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
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('plusMenu').classList.contains('hidden') || !$('modelMenu').classList.contains('hidden')) closeMenus();
      else if (!$('viewChat').classList.contains('hidden')) { if (state.speaking) stopAllSpeech(); }
      else showView('chat');
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
  api.app.onTtsStart((r) => { if (r && r.started) hint('Stimmen-Server wurde gestartet.'); else if (r && !r.ok) hint('Stimmen-Server: ' + (r.error || 'nicht gestartet'), 0); });
  state.chat = newChat();
  await refreshStatus();
  await loadModels();
  await refreshChats();
  renderAll();
  setInterval(() => { if (!state.streaming) refreshStatus().catch(() => {}); }, 20000);
}

init().catch((e) => { console.error(e); hint('Startfehler: ' + (e.message || e), 0); });
