'use strict';
// huggingface.co direkt in „Erkunden“: die echte Webseite in einer eingebetteten Ansicht.
// Erkennt Modellseiten (für „In FA KI laden“) und fängt Klicks auf .gguf-Dateien ab: die landen in der Download-Reihe der App.

const { WebContentsView, session, shell } = require('electron');
const { repoFromInput, parseResolve } = require('./hf');

const HOME = 'https://huggingface.co/models?library=gguf&sort=trending';
const ALLOWED = /^https:\/\/([a-z0-9-]+\.)?(huggingface\.co|hf\.co)(\/|$)/i;

class HfWeb {
  /** getWin(): Hauptfenster; send(kanal, daten); onGguf({ id, file }) startet den Download. */
  constructor(getWin, send, onGguf) {
    this.getWin = getWin;
    this.send = send;
    this.onGguf = onGguf;
    this.view = null;
    this.visible = false;
  }

  _ensure() {
    if (this.view) return this.view;
    const ses = session.fromPartition('persist:huggingface');
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = view.webContents;
    // Fremde Seiten nicht in der App öffnen, sondern im normalen Browser
    wc.setWindowOpenHandler(({ url }) => {
      if (ALLOWED.test(url)) wc.loadURL(url);
      else if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (!ALLOWED.test(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
    });
    // .gguf-Klicks: nicht im Browser speichern, sondern über die Download-Reihe der App in den Modellordner
    ses.on('will-download', (e, item) => {
      const chain = item.getURLChain ? item.getURLChain() : [item.getURL()];
      const r = chain.map(parseResolve).find(Boolean);
      e.preventDefault();
      if (r && /\.gguf$/i.test(r.file)) this.onGguf(r);
      else this.send('hfweb:notice', { text: 'Nur GGUF-Dateien lassen sich hier laden.' });
    });
    const emit = () => this._state();
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, emit);
    wc.loadURL(HOME);
    this.view = view;
    return view;
  }

  _state() {
    if (!this.view) return;
    const wc = this.view.webContents;
    const url = wc.getURL();
    const nav = wc.navigationHistory;
    this.send('hfweb:state', {
      url, title: wc.getTitle(), loading: wc.isLoading(),
      canBack: nav ? nav.canGoBack() : wc.canGoBack(), canForward: nav ? nav.canGoForward() : wc.canGoForward(),
      repo: repoFromInput(url),
    });
  }

  /** Lage und Sichtbarkeit (die Oberfläche misst den Platz unter ihrer Werkzeugleiste). */
  setBounds(rect, visible) {
    const win = this.getWin();
    if (!win || win.isDestroyed()) return;
    if (!visible) {
      if (this.view && this.visible) { win.contentView.removeChildView(this.view); this.visible = false; }
      return;
    }
    const v = this._ensure();
    if (!this.visible) { win.contentView.addChildView(v); this.visible = true; }
    v.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) });
    this._state();
  }

  nav(what, url) {
    const v = this._ensure();
    const wc = v.webContents;
    const nav = wc.navigationHistory;
    if (what === 'back') (nav ? nav.goBack() : wc.goBack());
    else if (what === 'forward') (nav ? nav.goForward() : wc.goForward());
    else if (what === 'reload') wc.reload();
    else if (what === 'home') wc.loadURL(HOME);
    else if (what === 'open' && url && ALLOWED.test(url)) wc.loadURL(url);
    else if (what === 'external') shell.openExternal(wc.getURL());
  }
}

module.exports = { HfWeb, HOME };
