'use strict';
// Seitenfenster neben dem Chat: Webseiten und Vorschau von Seiten/Folien, die die KI schreibt.
// Läuft als eigene, abgeschottete Ansicht (kein Zugriff auf die App, kein Node).

const { WebContentsView, session } = require('electron');

const MAX_HTML = 4 * 1024 * 1024;

const okUrl = (u) => /^https?:\/\//i.test(String(u || ''));

class Panel {
  constructor(getWin, send) {
    this.getWin = getWin;
    this.send = send;
    this.view = null;
    this.mode = 'none'; // 'web' | 'html'
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.visible = false;
    this.title = '';
  }

  _ensure(mode) {
    if (this.view && this.mode === mode) return this.view;
    this._destroy();
    // Eigene Sitzungen: Vorschau ohne Netz (erstellte Seiten können nichts senden), Web mit eigenem Speicher.
    const part = mode === 'html' ? 'fa-preview' : 'persist:fa-panel';
    const ses = session.fromPartition(part);
    if (mode === 'html') ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?|ftp):/i.test(d.url) }));
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (mode === 'web' && okUrl(url)) wc.loadURL(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (mode === 'html' && !/^data:/i.test(url)) e.preventDefault(); });
    const upd = () => this._state();
    wc.on('did-start-loading', upd); wc.on('did-stop-loading', upd); wc.on('did-navigate', upd); wc.on('did-navigate-in-page', upd); wc.on('page-title-updated', upd);
    this.view = view; this.mode = mode;
    const win = this.getWin();
    if (win && !win.isDestroyed()) win.contentView.addChildView(view);
    this._place();
    return view;
  }

  _destroy() {
    if (!this.view) return;
    const win = this.getWin();
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(this.view); } catch { /* egal */ }
    try { this.view.webContents.close(); } catch { /* egal */ }
    this.view = null; this.mode = 'none';
  }

  _place() {
    if (!this.view) return;
    const b = this.bounds;
    const show = this.visible && b.width > 20 && b.height > 20;
    this.view.setVisible(show);
    if (show) this.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  }

  _state() {
    if (!this.view) return this.send('panel:state', { open: false });
    const wc = this.view.webContents;
    const nh = wc.navigationHistory;
    this.send('panel:state', {
      open: true, mode: this.mode,
      url: this.mode === 'html' ? '' : wc.getURL(),
      title: this.title || wc.getTitle() || '',
      loading: wc.isLoading(),
      canBack: this.mode === 'web' && nh.canGoBack(), canForward: this.mode === 'web' && nh.canGoForward(),
    });
  }

  setBounds(b, visible) {
    if (b) this.bounds = { x: +b.x || 0, y: +b.y || 0, width: +b.width || 0, height: +b.height || 0 };
    this.visible = !!visible;
    this._place();
  }

  openUrl(url) {
    if (!okUrl(url)) throw new Error('Nur http- und https-Adressen.');
    this.title = '';
    this._ensure('web').webContents.loadURL(url);
    this._state();
  }

  showHtml(html, title) {
    const h = String(html || '');
    if (!h.trim()) throw new Error('Leere Seite.');
    if (h.length > MAX_HTML) throw new Error('Seite ist zu groß für die Vorschau.');
    this.title = String(title || 'Vorschau').slice(0, 80);
    this._ensure('html').webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(h));
    this._state();
  }

  nav(what) {
    if (!this.view) return;
    const wc = this.view.webContents;
    if (what === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (what === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (what === 'reload') wc.reload();
  }

  currentUrl() { return this.view && this.mode === 'web' ? this.view.webContents.getURL() : ''; }

  async pdf() {
    if (!this.view) throw new Error('Nichts geöffnet.');
    return this.view.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  }

  close() { this._destroy(); this.title = ''; this.send('panel:state', { open: false }); }
}

module.exports = { Panel, okUrl };
