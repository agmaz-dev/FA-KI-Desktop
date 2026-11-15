'use strict';
// Prüft das Einfügen im Eingabefeld: Text (auch mit Bild dabei) wird nicht blockiert, reines Bild wird angehängt.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'fa-paste-')));
require('../main.js');
app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const win = BrowserWindow.getAllWindows()[0];
  const js = (c) => win.webContents.executeJavaScript(c);
  const out = await js(`(() => {
    const el = document.getElementById('input');
    const fire = (withText, withImage) => {
      const dt = new DataTransfer();
      if (withText) dt.items.add('Hallo Text', 'text/plain');
      if (withImage) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, cancelable: true, bubbles: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return { textOnlyBlocked: fire(true, false), textAndImageBlocked: fire(true, true), imageOnlyBlocked: fire(false, true) };
  })()`);
  console.log('PASTE ' + JSON.stringify(out));
  app.exit(!out.textOnlyBlocked && !out.textAndImageBlocked && out.imageOnlyBlocked ? 0 : 1);
});
