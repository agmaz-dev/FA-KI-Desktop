// Rauchtest: startet die echte App mit einem Fake-Ollama und prüft einen Chat.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'fa-smoke-')));
app.commandLine.appendSwitch('no-sandbox');

const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.url === '/api/version') return res.end('{"version":"9.9.9"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'gpt-oss:20b', size: 14e9, details: { parameter_size: '20B' } }, { name: 'x:cloud', size: 0, remote_host: 'h' }] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['completion', 'thinking'] }));
    if (req.url === '/api/chat') {
      const j = JSON.parse(b);
      fs.writeFileSync('/tmp/smoke-chat-body.json', b);
      res.write(JSON.stringify({ message: { thinking: 'Ich überlege' } }) + '\n');
      res.write(JSON.stringify({ message: { content: '**Hallo** Feridun!\n\n```js\nx=1\n```' } }) + '\n');
      return res.end(JSON.stringify({ done: true, eval_count: 40, eval_duration: 2e9 }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

srv.listen(11434, '127.0.0.1', () => {
  require('../main.js');
  app.whenReady().then(async () => {
    await new Promise((r) => setTimeout(r, 500));
    const win = BrowserWindow.getAllWindows()[0];
    const logs = [];
    win.webContents.on('console-message', (e, level, msg) => logs.push(msg));
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await new Promise((r) => setTimeout(r, 2000));
    const js = (c) => win.webContents.executeJavaScript(c);
    const out = {};
    out.models = await js("[...document.querySelectorAll('#modelSel option')].map(o=>o.textContent)");
    out.think = await js("[...document.querySelectorAll('#thinkSel option')].map(o=>o.textContent)");
    out.status = await js("document.getElementById('statusText').textContent");
    await js("document.getElementById('input').value='Hallo, wer bist du?'; document.getElementById('btnSend').click();");
    await new Promise((r) => setTimeout(r, 2500));
    out.assistant = await js("document.querySelector('.msg.assistant .bubble').innerText");
    out.hasCode = await js("!!document.querySelector('.msg.assistant pre code')");
    out.chatList = await js("[...document.querySelectorAll('.chat-item .t')].map(e=>e.textContent)");
    await js("document.getElementById('btnSettings').click()");
    await new Promise((r) => setTimeout(r, 600));
    out.settings = await js("document.querySelector('#modal h2').textContent");
    const img = await win.webContents.capturePage();
    fs.writeFileSync('/tmp/smoke.png', img.toPNG());
    out.logs = logs.filter((l) => /error|fail|refused|violat/i.test(l)).slice(0, 10);
    console.log('SMOKE ' + JSON.stringify(out, null, 1));
    srv.close(); app.exit(0);
  });
});
