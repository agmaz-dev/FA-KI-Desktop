'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const eng = require('../lib/engine');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-eng-'));

test('Nachrichten: Werkzeugaufrufe bekommen Ids, Antworten passen zusammen, Bilder werden Teile', () => {
  const out = eng.toOpenAIMessages([
    { role: 'system', content: 's' },
    { role: 'user', content: 'Bild?', images: ['/9j/AAAA'] },
    { role: 'assistant', content: '', thinking: 'x', tool_calls: [{ function: { name: 'a', arguments: { q: 1 } } }, { function: { name: 'b', arguments: {} } }] },
    { role: 'tool', tool_name: 'b', content: 'B' },
    { role: 'tool', tool_name: 'a', content: 'A' },
  ]);
  assert.strictEqual(out[1].content[1].image_url.url, 'data:image/jpeg;base64,/9j/AAAA');
  assert.strictEqual(out[2].tool_calls[0].function.arguments, '{"q":1}');
  assert.strictEqual(out[2].thinking, undefined);
  assert.strictEqual(out[3].tool_call_id, out[2].tool_calls[1].id); // b
  assert.strictEqual(out[4].tool_call_id, out[2].tool_calls[0].id); // a
});

test('Anfrage: Optionen, Denken (Stufe, aus), Werkzeuge', () => {
  const r = eng.buildRequest({ model: 'm', messages: [], options: { temperature: 0.3, num_predict: 50, num_ctx: 9 }, think: 'high', tools: [{ type: 'function', function: { name: 'f' } }] });
  assert.strictEqual(r.temperature, 0.3); assert.strictEqual(r.max_tokens, 50); assert.strictEqual(r.reasoning_effort, 'high');
  assert.strictEqual(r.tools.length, 1); assert.strictEqual(r.stream, true);
  assert.deepStrictEqual(eng.buildRequest({ messages: [], think: false }).chat_template_kwargs, { enable_thinking: false });
  assert.deepStrictEqual(eng.buildRequest({ messages: [], think: true }).chat_template_kwargs, { enable_thinking: true });
  assert.strictEqual(eng.buildRequest({ messages: [] }).chat_template_kwargs, undefined);
});

test('Stream: Text, Denken, Werkzeugaufruf in Stücken, Statistik, Umlaut zwischen zwei Stücken', () => {
  const got = [];
  const t = eng.createSseTranslator((o) => got.push(o));
  const lines = [
    { choices: [{ delta: { reasoning_content: 'hm' } }] },
    { choices: [{ delta: { content: 'Grüße ' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'web_', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '"hi"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 }, timings: { predicted_n: 7, predicted_ms: 140 } },
  ].map((j) => 'data: ' + JSON.stringify(j) + '\n\n').join('') + 'data: [DONE]\n\n';
  const buf = Buffer.from(lines);
  const cut = buf.indexOf(0xc3) + 1; // mitten im ü
  const dec = new TextDecoder('utf-8');
  t.feed(dec.decode(buf.subarray(0, cut), { stream: true }));
  t.feed(dec.decode(buf.subarray(cut), { stream: true }));
  t.end();
  assert.strictEqual(got[0].message.thinking, 'hm');
  assert.strictEqual(got[1].message.content, 'Grüße ');
  const done = got[got.length - 1];
  assert.ok(done.done);
  assert.deepStrictEqual(done.message.tool_calls, [{ function: { name: 'web_search', arguments: { q: 'hi' } } }]);
  assert.strictEqual(done.eval_count, 7); assert.strictEqual(done.eval_duration, 140e6); assert.strictEqual(done.prompt_eval_count, 12);
  assert.strictEqual(done.done_reason, 'tool_calls');
});

test('Fehlertexte: zu langer Text wird verständlich erklärt', () => {
  assert.match(eng.friendlyError(400, '{"error":{"message":"the request exceeds the available context size"}}'), /Kontext/);
  assert.match(eng.friendlyError(500, 'kaputt'), /Engine: kaputt \(500\)/);
});

test('Leerlauf: Einstellung zu Sekunden', () => {
  assert.strictEqual(eng.idleSeconds('5m'), 300); assert.strictEqual(eng.idleSeconds('2h'), 7200); assert.strictEqual(eng.idleSeconds('-1'), -1);
});

// Eine Attrappe von llama-server: Node-Skript mit Shebang
function fakeServer(dir) {
  const f = path.join(dir, 'llama-server');
  fs.writeFileSync(f, `#!/usr/bin/env node
const http = require('http'); const fs = require('fs');
const a = process.argv; const port = +a[a.indexOf('--port') + 1]; const model = fs.readFileSync(a[a.indexOf('-m') + 1], 'utf8');
fs.appendFileSync(process.env.FAKE_LOG, 'start ' + a.join(' ') + '\\n');
if (model.startsWith('crash')) { console.error('kein Speicher'); process.exit(1); }
let ready = false; setTimeout(() => { ready = true; }, 300);
http.createServer((req, res) => {
  if (req.url === '/health') { res.statusCode = ready ? 200 : 503; return res.end('{}'); }
  let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    const j = JSON.parse(b);
    if (j.messages[0].content === 'zu lang') { res.statusCode = 400; return res.end('{"error":{"message":"exceeds the available context size"}}'); }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hal' } }] }) + '\\n\\n');
    if (j.messages[0].content === 'langsam') { const t = setInterval(() => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\\n\\n'), 20); res.on('close', () => { clearInterval(t); fs.appendFileSync(process.env.FAKE_LOG, 'closed\\n'); }); return; }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }) + '\\n\\n');
    res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 }, timings: { predicted_n: 2, predicted_ms: 40 } }) + '\\n\\n');
    res.end('data: [DONE]\\n\\n');
  });
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });
  return f;
}

test('Engine: startet llama-server einmal, startet neu bei anderem Kontext, Fehler, Abbruch', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const log = path.join(dir, 'log.txt');
  process.env.FAKE_LOG = log;
  fs.writeFileSync(path.join(dir, 'ok.gguf'), 'ok');
  fs.writeFileSync(path.join(dir, 'bad.gguf'), 'crash');
  const e = new eng.Engine({
    exePath: fakeServer(dir),
    getSettings: () => ({ numCtx: 4096, keepAlive: '5m' }),
    resolveModel: (n) => (n === 'ok' ? { file: path.join(dir, 'ok.gguf'), mmproj: '' } : n === 'bad' ? { file: path.join(dir, 'bad.gguf'), mmproj: '' } : null),
  });
  const ask = async (content, model = 'ok', ctx) => {
    let text = ''; let done = null;
    await e.chatStream({ model, messages: [{ role: 'user', content }], options: ctx ? { num_ctx: ctx } : {} }, (o) => { text += o.message.content || ''; if (o.done) done = o; });
    return { text, done };
  };
  const r = await ask('hi');
  assert.strictEqual(r.text, 'Hallo'); assert.strictEqual(r.done.eval_count, 2);
  await ask('nochmal');
  assert.strictEqual(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start')).length, 1, 'gleicher Kontext: kein Neustart');
  const startLine = fs.readFileSync(log, 'utf8').split('\n')[0];
  assert.match(startLine, /--jinja/); assert.match(startLine, /--no-webui/); assert.match(startLine, /-c 4096/); assert.match(startLine, /--sleep-idle-seconds 300/); assert.match(startLine, /--host 127\.0\.0\.1/);
  await ask('hi', 'ok', 8192);
  assert.strictEqual(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start')).length, 2, 'anderer Kontext: Neustart');
  await assert.rejects(ask('zu lang'), /Kontext/);
  await assert.rejects(ask('x', 'gibtsnicht'), /nicht in der Bibliothek/);
  await assert.rejects(ask('x', 'bad'), /kein Speicher/);
  // Abbruch schließt die Verbindung
  await ask('hi'); // wieder gesundes Modell
  const c = new AbortController();
  setTimeout(() => c.abort(), 150);
  await assert.rejects(e.chatStream({ model: 'ok', messages: [{ role: 'user', content: 'langsam' }] }, () => {}, c.signal));
  for (let i = 0; i < 60 && !fs.readFileSync(log, 'utf8').includes('closed'); i++) await new Promise((r2) => setTimeout(r2, 20));
  assert.ok(fs.readFileSync(log, 'utf8').includes('closed'), 'Abbruch muss die Verbindung schließen');
  await e.stop();
});

test('Engine: fehlende Datei llama-server wird verständlich gemeldet', async () => {
  const e = new eng.Engine({ exePath: '', getSettings: () => ({}), resolveModel: () => ({ file: 'x', mmproj: '' }) });
  await assert.rejects(e.chatStream({ model: 'x', messages: [] }, () => {}), /llama-server\) fehlt/);
  assert.strictEqual(eng.findServerExe('/nix/gibt/es/nicht', '/auch/nicht'), '');
});
