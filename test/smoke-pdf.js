// Rauchtest 2: PDF mit Text, PDF-Scan (OCR) und Bild-OCR.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-smoke2-'));
app.setPath('userData', ud);
app.commandLine.appendSwitch('no-sandbox');
fs.mkdirSync(path.join(ud, 'tessdata'));
for (const l of ['deu', 'tur']) fs.copyFileSync(`/tmp/td/${l}.traineddata`, path.join(ud, 'tessdata', l + '.traineddata'));
require('../main.js');
app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await new Promise((r) => setTimeout(r, 1500));
  const b64 = (f) => fs.readFileSync(f).toString('base64');
  const code = `(async()=>{
    const mk=(n,b,t)=>{const u=Uint8Array.from(atob(b),c=>c.charCodeAt(0));return new File([u],n,{type:t});};
    const dt=new DataTransfer();
    dt.items.add(mk('text.pdf','${b64('/tmp/text.pdf')}','application/pdf'));
    dt.items.add(mk('scan.pdf','${b64('/tmp/scan.pdf')}','application/pdf'));
    dt.items.add(mk('scan.png','${b64('/tmp/scan.png')}','image/png'));
    document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
    for(let i=0;i<120;i++){ await new Promise(r=>setTimeout(r,500)); if(document.querySelectorAll('#attachments .att').length>=3) break; }
    return [...document.querySelectorAll('#attachments .att')].map(e=>e.textContent);
  })()`;
  const res = await win.webContents.executeJavaScript(code);
  console.log('ATT', JSON.stringify(res));
  app.exit(0);
});
