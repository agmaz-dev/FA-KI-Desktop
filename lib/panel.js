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
    this.tabs = []; // { id, view, mode: 'web'|'html', title }
    this.active = 0;
    this.seq = 0;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.visible = false;
  }

  _cur() { return this.tabs.find((t) => t.id === this.active) || null; }

  _make(mode) {
    // Eigene Sitzungen: Vorschau ohne Netz (erstellte Seiten können nichts senden), Web mit eigenem Speicher.
    const part = mode === 'html' ? 'fa-preview' : 'persist:fa-panel';
    const ses = session.fromPartition(part);
    if (mode === 'html') ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?|ftp):/i.test(d.url) }));
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const tab = { id: ++this.seq, view, mode, title: '' };
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (mode === 'web' && okUrl(url)) this.newTab(url); return { action: 'deny' }; });
    wc.on('will-navigate', (e, url) => { if (mode === 'html' && !/^data:/i.test(url)) e.preventDefault(); });
    const upd = () => this._state();
    wc.on('did-start-loading', upd); wc.on('did-stop-loading', upd); wc.on('did-navigate', upd); wc.on('did-navigate-in-page', upd); wc.on('page-title-updated', upd);
    const win = this.getWin();
    if (win && !win.isDestroyed()) win.contentView.addChildView(view);
    this.tabs.push(tab);
    return tab;
  }

  _kill(tab) {
    const win = this.getWin();
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view); } catch { /* egal */ }
    try { tab.view.webContents.close(); } catch { /* egal */ }
  }

  _place() {
    const b = this.bounds;
    const show = this.visible && b.width > 20 && b.height > 20;
    for (const t of this.tabs) {
      const on = show && t.id === this.active;
      t.view.setVisible(on);
      if (on) t.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    }
  }

  _state() {
    this._place();
    const cur = this._cur();
    if (!cur) return this.send('panel:state', { open: false, tabs: [] });
    const wc = cur.view.webContents;
    const nh = wc.navigationHistory;
    const tabs = this.tabs.map((t) => ({
      id: t.id, mode: t.mode,
      title: t.mode === 'html' ? (t.title || 'Vorschau') : (t.view.webContents.getTitle() || t.view.webContents.getURL() || 'Neuer Tab'),
    }));
    this.send('panel:state', {
      open: true, mode: cur.mode, active: cur.id, tabs,
      url: cur.mode === 'html' ? '' : wc.getURL(),
      title: cur.title || wc.getTitle() || '',
      loading: wc.isLoading(),
      canBack: cur.mode === 'web' && nh.canGoBack(), canForward: cur.mode === 'web' && nh.canGoForward(),
    });
  }

  setBounds(b, visible) {
    if (b) this.bounds = { x: +b.x || 0, y: +b.y || 0, width: +b.width || 0, height: +b.height || 0 };
    this.visible = !!visible;
    this._place();
  }

  /** Lädt die Adresse im aktuellen Web-Tab (oder legt den ersten an). */
  openUrl(url) {
    if (!okUrl(url)) throw new Error('Nur http- und https-Adressen.');
    let cur = this._cur();
    if (!cur || cur.mode !== 'web') cur = this.newTab();
    cur.view.webContents.loadURL(url);
    this._state();
  }

  /** Neuer Tab; mit Adresse wird sie geladen. */
  newTab(url) {
    if (url && !okUrl(url)) throw new Error('Nur http- und https-Adressen.');
    const tab = this._make('web');
    this.active = tab.id;
    if (url) tab.view.webContents.loadURL(url);
    this._state();
    return tab;
  }

  selectTab(id) {
    if (this.tabs.some((t) => t.id === id)) { this.active = id; this._state(); }
  }

  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    this._kill(t);
    if (this.active === id) this.active = this.tabs.length ? this.tabs[Math.min(i, this.tabs.length - 1)].id : 0;
    this._state();
  }

  /** Vorschau von KI-HTML: ein eigener Tab, der bei jeder neuen Vorschau ersetzt wird. */
  showHtml(html, title) {
    const h = String(html || '');
    if (!h.trim()) throw new Error('Leere Seite.');
    if (h.length > MAX_HTML) throw new Error('Seite ist zu groß für die Vorschau.');
    let tab = this.tabs.find((t) => t.mode === 'html');
    if (!tab) tab = this._make('html');
    tab.title = String(title || 'Vorschau').slice(0, 80);
    this.active = tab.id;
    tab.view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(h));
    this._state();
  }

  nav(what) {
    const cur = this._cur();
    if (!cur) return;
    const wc = cur.view.webContents;
    if (what === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (what === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (what === 'reload') wc.reload();
  }

  currentUrl() { const c = this._cur(); return c && c.mode === 'web' ? c.view.webContents.getURL() : ''; }

  async pdf() {
    const cur = this._cur();
    if (!cur) throw new Error('Nichts geöffnet.');
    return cur.view.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  }

  close() {
    for (const t of this.tabs) this._kill(t);
    this.tabs = []; this.active = 0;
    this.send('panel:state', { open: false, tabs: [] });
  }
}

module.exports = { Panel, okUrl };
