'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  ollamaUrl: 'http://127.0.0.1:11434',
  model: '',
  systemPrompt:
    'Du bist ein hilfreicher, genauer Assistent. Antworte immer auf Deutsch. ' +
    'Wenn ich auf Türkisch oder in einer anderen Sprache schreibe, antworte in dieser Sprache. ' +
    'E-Mails schreibst du nur als Entwurf. Erfinde keine Fakten; sage, wenn du etwas nicht weißt.',
  numCtx: 16384,
  think: 'medium',
  showCloud: false,
  temperature: 0.7,
  ttsAuto: false,
  ttsVoice: 'auto',
  sttLang: 'de',
  sttModel: 'small',
  autoSend: false,
  theme: 'system',
  serif: true,
  fontSize: 16,
  thinkLive: false,
  ttsSpeed: 1,
  ttsEngine: 'piper',
  ttsServerUrl: 'http://127.0.0.1:8004',
  ttsServerVoice: '',
  ttsServerVoiceTr: '',
  ttsServerModel: 'tts-1',
  ttsServerDir: '',
  ttsServerCmd: 'python server.py',
  ttsServerAuto: false,
  ttsSampleFile: '',
  ttsServerLangs: 'all', // 'de' = Stimmen-Server nur für Deutsch, Türkisch macht Piper
  autoStartOllama: true,
  sendOnEnter: true,
  keepAlive: '30m',
  profiles: [],
  activeProfile: '',
  sidebarOpen: true,
};

function safeId(id) {
  const s = String(id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error('Ungültige Chat-ID');
  return s;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.settingsFile = path.join(dir, 'settings.json');
    this.chatsDir = path.join(dir, 'chats');
    fs.mkdirSync(this.chatsDir, { recursive: true });
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };
  }

  setSettings(patch) {
    const next = { ...this.getSettings(), ...(patch || {}) };
    writeJsonAtomic(this.settingsFile, next);
    return next;
  }

  listChats() {
    let files = [];
    try { files = fs.readdirSync(this.chatsDir).filter((f) => f.endsWith('.json')); } catch { /* leer */ }
    const out = [];
    for (const f of files) {
      const c = readJson(path.join(this.chatsDir, f), null);
      if (c && c.id) out.push({ id: c.id, title: c.title || 'Neuer Chat', updated: c.updated || 0, model: c.model || '' });
    }
    out.sort((a, b) => b.updated - a.updated);
    return out;
  }

  loadChat(id) {
    return readJson(path.join(this.chatsDir, safeId(id) + '.json'), null);
  }

  saveChat(chat) {
    if (!chat || !chat.id) throw new Error('Chat ohne ID');
    writeJsonAtomic(path.join(this.chatsDir, safeId(chat.id) + '.json'), chat);
    return true;
  }

  clearChats() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(this.chatsDir)) {
        if (f.endsWith('.json')) { fs.unlinkSync(path.join(this.chatsDir, f)); n++; }
      }
    } catch { /* leer */ }
    return n;
  }

  deleteChat(id) {
    try { fs.unlinkSync(path.join(this.chatsDir, safeId(id) + '.json')); } catch { /* schon weg */ }
    return true;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
