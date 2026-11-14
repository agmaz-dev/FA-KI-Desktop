const { app, BrowserWindow } = require('electron');
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ui-')));
app.commandLine.appendSwitch('no-sandbox');
let lastBody = null;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.url === '/api/version') return res.end('{"version":"9.9.9"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gpt-oss:latest', size: 13e9, details: {} }] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'thinking'] }));
    if (req.url === '/api/chat') {
      lastBody = JSON.parse(b);
      res.write(JSON.stringify({ message: { thinking: 'Ich überlege kurz' } }) + '\n');
      res.write(JSON.stringify({ message: { content: 'Sehr geehrte Frau Müller,\n\nvielen Dank.\n\n```\ncode\n```' } }) + '\n');
      return res.end(JSON.stringify({ done: true, eval_count: 40, eval_duration: 2e9 }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
srv.listen(11434, '127.0.0.1', () => {
  require('../main.js');
  app.whenReady().then(async () => {
    await new Promise((r) => setTimeout(r, 800));
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1300, 860);
    const errs = [];
    win.webContents.on('console-message', (e) => { const m = e.message || ''; if (/error|uncaught/i.test(m)) errs.push(m); });
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await new Promise((r) => setTimeout(r, 1800));
    const js = (c) => win.webContents.executeJavaScript(c);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const shot = async (n) => fs.writeFileSync(`/tmp/ui-${n}.png`, (await win.webContents.capturePage()).toPNG());
    const out = {};
    await shot('1-leer-hell');
    // Einstellungen -> Profile
    await js("document.getElementById('btnSettings').click()"); await wait(500);
    await js("[...document.querySelectorAll('.set-nav button')].find(b=>/Profile/.test(b.textContent)).click()"); await wait(500);
    await js("[...document.querySelectorAll('.set-body button')].find(b=>/Neues Profil/.test(b.textContent)).click()"); await wait(400);
    await js(`(()=>{const ins=[...document.querySelectorAll('.set-body input[type=text]')]; const set=(i,v)=>{ins[i].value=v;ins[i].dispatchEvent(new Event('input'));}; set(0,'Privat'); set(1,'Feridun Agmaz'); const ta=[...document.querySelectorAll('.set-body textarea')]; ta[0].value='Musterstr. 1\\n12345 Berlin'; ta[0].dispatchEvent(new Event('input')); ta[1].value='Mit freundlichen Grüßen\\nFeridun Agmaz'; ta[1].dispatchEvent(new Event('input'));})()`);
    await wait(300); await shot('2-profile');
    await js("[...document.querySelectorAll('.set-nav button')].find(b=>/Sprache/.test(b.textContent)).click()"); await wait(600); await shot('3-sprache');
    await js("[...document.querySelectorAll('.set-nav button')].find(b=>/Allgemein/.test(b.textContent)).click()"); await wait(300);
    await js("(()=>{const s=document.querySelector('.set-body select'); s.value='dark'; s.dispatchEvent(new Event('change'));})()"); await wait(300);
    await js("[...document.querySelectorAll('.set-foot button')].find(b=>/Speichern/.test(b.textContent)).click()"); await wait(700);
    await shot('4-allgemein-dunkel');
    await js("[...document.querySelectorAll('.set-foot button')].find(b=>/Schlie/.test(b.textContent)).click()"); await wait(300);
    out.profileOpts = await js("[...document.querySelectorAll('#profileSel option')].map(o=>o.textContent)");
    out.greeting = await js("document.getElementById('greeting').textContent");
    out.theme = await js("document.documentElement.dataset.theme");
    // Chat senden
    await js("document.getElementById('input').value='Schreibe einen Brief'; document.getElementById('btnSend').click();"); await wait(2500);
    out.systemHasProfile = !!(lastBody && /Feridun Agmaz/.test(lastBody.messages[0].content) && /Musterstr/.test(lastBody.messages[0].content));
    out.assistant = await js("document.querySelector('.msg.assistant .bubble').innerText.slice(0,60)");
    out.actions = await js("[...document.querySelectorAll('.msg.assistant .msg-actions button')].map(b=>b.title)");
    await shot('5-chat-dunkel');
    // neu erzeugen
    await js("[...document.querySelectorAll('.msg.assistant .msg-actions button')].find(b=>/neu erzeugen/.test(b.title)).click()"); await wait(2500);
    out.msgCountAfterRegen = await js("document.querySelectorAll('.msg').length");
    // Stopp-Funktion: speak mit Windows-Stimme gibt es hier nicht; prüfe nur, dass Button vorhanden ist
    out.stopBtn = await js("!!document.getElementById('btnStopSpeak')");
    out.errs = errs.slice(0, 5);
    console.log('UI ' + JSON.stringify(out, null, 1));
    srv.close(); app.exit(0);
  });
});
