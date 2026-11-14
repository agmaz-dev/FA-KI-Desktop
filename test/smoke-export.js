'use strict';
// Prüft den PDF-Export mit echtem Electron (headless unter xvfb).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const { renderPdf } = require('../lib/export');

app.whenReady().then(async () => {
  try {
    const pdf = await renderPdf(BrowserWindow, '# Überschrift\n\nText mit **fett** und <script>alert(1)</script>.\n\n- a\n- b\n', 'Test');
    fs.writeFileSync('/tmp/export-test.pdf', pdf);
    if (!(pdf.length > 1000 && pdf.slice(0, 4).toString() === '%PDF')) throw new Error('PDF ungültig');
    console.log('PDF OK', pdf.length);
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
