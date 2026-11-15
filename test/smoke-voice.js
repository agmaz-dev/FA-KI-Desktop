const { app, BrowserWindow } = require('electron');
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-v-'));
app.setPath('userData', ud);
app.commandLine.appendSwitch('no-sandbox');
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ ttsEngine: 'server', model: 'gpt-oss:latest' }));
const srv = http.createServer((req, res) => {
  if (req.url === '/api/version') return res.end('{"version":"9.9.9"}');
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gpt-oss:latest', size: 13e9, details: {} }] }));
  res.statusCode = 404; res.end('{}');
});
srv.listen(11434, '127.0.0.1', () => {
  require('../main.js');
  app.whenReady().then(async () => {
    await new Promise((r) => setTimeout(r, 800));
    const win = BrowserWindow.getAllWindows()[0];
    const errs = [];
    win.webContents.on('console-message', (e) => { const m = e.message || ''; if (/error|uncaught/i.test(m)) errs.push(m); });
    await new Promise((r) => setTimeout(r, 1500));
    const js = (c) => win.webContents.executeJavaScript(c);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await js("document.getElementById('btnSettings').click()"); await wait(400);
    await js("[...document.querySelectorAll('.set-nav button')].find(b=>/Sprache/.test(b.textContent)).click()"); await wait(500);
    const txt = await js("document.querySelector('.set-body').innerText");
    const need = ['Meine Stimme (OuteTTS, Deutsch)', 'Meine Stimme einrichten', 'Aufnahme wählen', 'Stimmen-Motor', 'Stimme testen', 'Supertonic einrichten', 'Elena (weiblich)', 'Caleb (männlich)'];
    const gone = ['Grafikkarte', 'Startbefehl', 'Ordner des Stimmen-Servers', 'Chatterbox'];
    const missing = need.filter((n) => !txt.toLowerCase().includes(n.toLowerCase())).concat(gone.filter((n) => txt.toLowerCase().includes(n.toLowerCase())).map((n) => 'noch da: ' + n));
    await js("[...document.querySelectorAll('.set-nav button')].find(b=>/Allgemein/.test(b.textContent)).click()"); await wait(400);
    const gen = await js("document.querySelector('.set-body').innerText");
    console.log(JSON.stringify({ missing, ollamaSwitch: gen.includes('Ollama mit der App starten'), errs }));
    app.exit(missing.length || errs.length ? 1 : 0);
  });
});
