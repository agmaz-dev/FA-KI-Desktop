'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectLang, stripMarkdown, splitSentences, fitText, cleanTranscript } = require('../lib/util');
const { Store } = require('../lib/store');
const { buildThink } = require('../lib/think');
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

test('Diktat-Ausgabe säubern', () => {
  assert.strictEqual(cleanTranscript(' [BLANK_AUDIO] Hallo  Welt '), 'Hallo Welt');
  assert.strictEqual(cleanTranscript('[Musik]'), '');
  assert.strictEqual(cleanTranscript('(Applaus) Hallo [Musik] Welt ♪'), 'Hallo Welt');
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

test('buildThink: Stufen und Ein/Aus je nach Modell', () => {
  assert.strictEqual(buildThink('gpt-oss:20b', ['thinking'], 'high'), 'high');
  assert.strictEqual(buildThink('qwen3', ['thinking'], 'off'), false);
  assert.strictEqual(buildThink('gemma', ['completion'], 'high'), undefined);
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

test('Stimmen-Server (OpenAI-kompatibel)', async () => {
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
  const sm = new SpeechManager();
  const wav = await sm.synthesizeServer('Hallo', 'de', { ttsServerUrl: url, ttsServerVoice: 'anna.wav' }, 1.2);
  assert.strictEqual(wav.length, 8);
  assert.strictEqual(got.voice, 'anna.wav'); assert.strictEqual(got.language, 'de'); assert.strictEqual(got.speed, 1.2);
  void dir;
  srv.close();
});

test('Word-Export erzeugt gültiges DOCX-Paket', () => {
  const { buildDocx } = require('../lib/export');
  const AdmZip = require('adm-zip');
  const z = new AdmZip(buildDocx('# Titel\n\nText **fett** & <b>x</b>\n\n- eins\n- zwei\n', 'T'));
  const names = z.getEntries().map((e) => e.entryName);
  for (const n of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml']) assert.ok(names.includes(n), n);
  const xml = z.readAsText('word/document.xml');
  assert.match(xml, /Heading1/);
  assert.match(xml, /&lt;b&gt;/);
  assert.ok(!/<b>x/.test(xml));
});

test('OuteTTS-Einrichtung: Pfade, Startbefehl, Aufräumen', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { VoiceInstaller, paths } = require('../lib/voiceinstall');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-vi-'));
  const p = paths(ud);
  assert.match(p.py, /python-oute/);
  assert.match(p.serverPy, /oute_server\.py$/);
  const v = new VoiceInstaller(ud, '/tmp/x.py', () => {});
  const c = v.command();
  assert.match(c, /--port 8004/);
  assert.match(c, /--llama/);
  assert.match(c, /OuteTTS-1\.0-0\.6B-Q8_0\.gguf/);
  fs.mkdirSync(path.join(ud, 'voice', 'python-gpu', 'x'), { recursive: true });
  fs.mkdirSync(path.join(ud, 'voice', 'python'), { recursive: true });
  assert.strictEqual(v.status().oldFiles, true);
  assert.strictEqual(v.cleanOld(), 2);
  assert.strictEqual(v.status().oldFiles, false);
});

test('Türkisch-Wörter mit ç/ğ und Satzteile höchstens maxLen', () => {
  assert.strictEqual(detectLang('Bu kitap çok güzel ve ben de var'), 'tr');
  assert.strictEqual(detectLang('Das ist ein ganz normaler deutscher Satz mit ne Menge Wörter.'), 'de');
  for (const t of ['a'.repeat(700), ('wort ').repeat(200), ('x,').repeat(400)]) {
    const parts = splitSentences(t, 280);
    assert.ok(parts.every((p) => p.length <= 280), JSON.stringify(parts.map((p) => p.length)));
    assert.strictEqual(parts.join('').replace(/\s/g, '').length, t.replace(/\s/g, '').length);
  }
});

test('Downloader: Schreibfehler wird gemeldet statt abzustürzen', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-length', 6); res.end('abcdef'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-dlerr-'));
  const dest = path.join(d, 'datei.bin');
  fs.mkdirSync(dest + '.part'); // .part ist ein Ordner -> Schreiben schlägt fehl
  await assert.rejects(downloadFile(`http://127.0.0.1:${srv.address().port}/x`, dest), /EISDIR|illegal operation|EPERM|EACCES/);
  srv.close();
});

test('Prozesse: fehlendes Programm wird sofort gemeldet', async () => {
  const { Procs } = require('../lib/procs');
  const p = new Procs();
  const child = p._spawn('x', 'gibt-es-nicht-fa-ki-12345', []);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(child.spawnError && child.spawnError.code === 'ENOENT');
  assert.strictEqual(await p.freePort('http://127.0.0.1:8004'), false); // ohne eigenen Ordner wird nie etwas beendet
});

test('parseGpuMac liest die Apple-GPU-Auslastung', () => {
  const { parseGpuMac } = require('../lib/sysstats');
  assert.strictEqual(parseGpuMac('"PerformanceStatistics" = {"Device Utilization %"=37,"Renderer Utilization %"=10}'), 37);
  assert.strictEqual(parseGpuMac('nichts'), null);
});
test('hwFor: Mac nutzt gemeinsamen Speicher, Windows die Einstellung', () => {
  const hf = require('../lib/hf');
  const GIB = 1024 ** 3;
  assert.deepStrictEqual(hf.hwFor({ vramGb: 16, ramGb: 32 }, 'win32', 32 * GIB), { vramGb: 16, ramGb: 32 });
  const m = hf.hwFor({}, 'darwin', 16 * GIB);
  assert.ok(m.vramGb > 8 && m.vramGb < 11 && m.ramGb === 0);
  assert.strictEqual(hf.fitFor(14 * GIB, m).fit, 'nein');
  assert.strictEqual(hf.fitFor(5 * GIB, m).fit, 'gpu');
});
