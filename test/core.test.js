'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectLang, stripMarkdown, splitSentences, fitText, cleanTranscript } = require('../lib/util');
const { Store } = require('../lib/store');
const ollama = require('../lib/ollama');
const { pickWhisperAsset } = require('../lib/speech');
const { downloadFile } = require('../lib/downloader');

test('Sprache erkennen', () => {
  assert.strictEqual(detectLang('Merhaba, nasılsın? Bugün çok güzel'), 'tr');
  assert.strictEqual(detectLang('Guten Tag, wie geht es Ihnen?'), 'de');
});

test('Markdown entfernen', () => {
  const t = stripMarkdown('# Titel\n**fett** und `code`\n- Punkt\n```js\nx=1\n```\n[Link](http://a.b)');
  assert.ok(!/[#*`]/.test(t));
  assert.ok(t.includes('Link') && !t.includes('http'));
});

test('Sätze teilen', () => {
  const parts = splitSentences('Eins. Zwei! ' + 'wort '.repeat(100) + '. Drei?', 120);
  assert.ok(parts.every((p) => p.length <= 125));
  assert.ok(parts.length >= 4);
});

test('Text kürzen', () => {
  const r = fitText('a'.repeat(1000), 200);
  assert.ok(r.truncated && r.text.length < 300);
});

test('Whisper-Ausgabe säubern', () => {
  assert.strictEqual(cleanTranscript(' [BLANK_AUDIO] Hallo  Welt '), 'Hallo Welt');
});

test('Whisper-Paket auswählen', () => {
  const a = pickWhisperAsset([
    { name: 'whisper-cublas-12.4.0-bin-x64.zip', browser_download_url: 'u1' },
    { name: 'whisper-bin-Win32.zip', browser_download_url: 'u2' },
    { name: 'whisper-bin-x64.zip', browser_download_url: 'u3' },
    { name: 'whisper-blas-bin-x64.zip', browser_download_url: 'u4' },
  ]);
  assert.strictEqual(a.url, 'u3');
  assert.strictEqual(pickWhisperAsset([{ name: 'x.tar.gz', browser_download_url: 'z' }]), null);
});

test('Store: Chats & Einstellungen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));
  const s = new Store(dir);
  assert.strictEqual(s.getSettings().numCtx, 16384);
  s.setSettings({ model: 'x' });
  assert.strictEqual(new Store(dir).getSettings().model, 'x');
  s.saveChat({ id: 'abc', title: 'T', updated: 5, messages: [] });
  assert.strictEqual(s.listChats().length, 1);
  assert.throws(() => s.loadChat('../evil'));
  s.deleteChat('abc');
  assert.strictEqual(s.listChats().length, 0);
});

test('Ollama: Streaming, Tags, Fehler, think', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'gpt-oss:20b', size: 5 }] })); return; }
    if (req.url === '/api/version') { res.end('{"version":"0.0.1"}'); return; }
    if (req.url === '/api/chat') {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const j = JSON.parse(b);
        if (j.model === 'bad') { res.statusCode = 404; res.end('{"error":"model not found"}'); return; }
        res.write(JSON.stringify({ message: { thinking: 'hm' } }) + '\n');
        res.write(JSON.stringify({ message: { content: 'Hal' } }) + '\n{"message":{"content":"lo"}}\n');
        res.end(JSON.stringify({ done: true, eval_count: 2, eval_duration: 1e9 }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.strictEqual(await ollama.version(base), '0.0.1');
  assert.strictEqual((await ollama.tags(base))[0].name, 'gpt-oss:20b');
  let text = ''; let think = ''; let done = null;
  await ollama.chatStream(base, { model: 'x', messages: [] }, (o) => {
    if (o.message) { text += o.message.content || ''; think += o.message.thinking || ''; }
    if (o.done) done = o;
  });
  assert.strictEqual(text, 'Hallo'); assert.strictEqual(think, 'hm'); assert.strictEqual(done.eval_count, 2);
  await assert.rejects(ollama.chatStream(base, { model: 'bad', messages: [] }, () => {}), /model not found/);
  srv.close();
  assert.strictEqual(ollama.buildThink('gpt-oss:20b', ['thinking'], 'high'), 'high');
  assert.strictEqual(ollama.buildThink('qwen3', ['thinking'], 'off'), false);
  assert.strictEqual(ollama.buildThink('gemma', ['completion'], 'high'), undefined);
});

test('Downloader', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-length', 6); res.end('abcdef'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'a', 'f.bin');
  let last = null;
  await downloadFile(`http://127.0.0.1:${srv.address().port}/x`, dest, (p) => { last = p; });
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'abcdef');
  assert.strictEqual(last.received, 6);
  srv.close();
});

test('Stimmen-Server (OpenAI-kompatibel) und Piper-Stimmenwahl', async () => {
  const { SpeechManager } = require('../lib/speech');
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.url === '/v1/audio/speech') { got = JSON.parse(b); res.end(Buffer.from('RIFFxxxx')); return; }
      if (req.url === '/v1/audio/voices') { res.end(JSON.stringify({ voices: ['anna.wav', { name: 'ben.wav' }] })); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const sm = new SpeechManager(dir);
  const wav = await sm.synthesizeServer('Hallo', 'tr', { ttsServerUrl: url, ttsServerVoice: 'anna.wav', ttsServerVoiceTr: 'ben.wav' }, 1.2);
  assert.strictEqual(wav.length, 8);
  assert.strictEqual(got.voice, 'ben.wav'); assert.strictEqual(got.language, 'tr'); assert.strictEqual(got.speed, 1.2);
  const v = await sm.serverVoices(url);
  assert.ok(v.ok); assert.deepStrictEqual(v.voices, ['anna.wav', 'ben.wav']);
  srv.close();
  fs.mkdirSync(sm.voiceDir, { recursive: true });
  for (const id of ['tr_TR-fettah-medium', 'tr_TR-dfki-medium', 'de_DE-thorsten-medium', 'de_DE-thorsten-high']) {
    fs.writeFileSync(path.join(sm.voiceDir, id + '.onnx'), 'x'); fs.writeFileSync(path.join(sm.voiceDir, id + '.onnx.json'), '{}');
  }
  assert.strictEqual(sm.installedVoice('tr').id, 'tr_TR-dfki-medium');
  assert.strictEqual(sm.installedVoice('de').id, 'de_DE-thorsten-high');
});
