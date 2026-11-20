'use strict';
// Verbindung zum lokalen Stimmen-Server „Meine Stimme“ (OuteTTS, OpenAI-kompatibel).
// Spracherkennung macht seit 2.5.1 nur noch Voxtral (lib/voxtral.js), Vorlesen Phonon (lib/phonon.js).

class SpeechManager {
  constructor() {
    this._srvCtrls = new Set();
  }

  /** Stimmen-Server mit OpenAI-kompatibler Schnittstelle. */
  async synthesizeServer(text, lang, cfg, speed = 1) {
    const base = String(cfg.ttsServerUrl || 'http://127.0.0.1:8004').replace(/\/+$/, '');
    const body = {
      model: cfg.ttsServerModel || 'tts-1',
      input: String(text),
      voice: cfg.ttsServerVoice || cfg.ttsSampleFile || 'alloy',
      response_format: 'wav',
      speed: Math.min(2, Math.max(0.5, Number(speed) || 1)),
      language: lang,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300000);
    this._srvCtrls.add(ctrl);
    try {
      const res = await fetch(base + '/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Stimmen-Server antwortete ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
      this._srvCtrls.delete(ctrl);
    }
  }

  /** Bricht laufende Aufträge beim Stimmen-Server ab (nach „Stopp“), damit der nächste Text nicht wartet. */
  async cancelServer(url) {
    for (const c of this._srvCtrls) { try { c.abort(); } catch { /* egal */ } }
    const base = String(url || 'http://127.0.0.1:8004').replace(/\/+$/, '');
    try { await fetch(base + '/cancel', { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch { /* Server läuft evtl. nicht */ }
    return true;
  }
}

module.exports = { SpeechManager };
