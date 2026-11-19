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
  assert.strictEqual(cleanTranscript('[Musik]'), '');
  assert.strictEqual(cleanTranscript('(Applaus) Hallo [Musik] Welt ♪'), 'Hallo Welt');
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
  const sm = new SpeechManager(dir);
  const wav = await sm.synthesizeServer('Hallo', 'tr', { ttsServerUrl: url, ttsServerVoice: 'anna.wav', ttsServerVoiceTr: 'ben.wav' }, 1.2);
  assert.strictEqual(wav.length, 8);
  assert.strictEqual(got.voice, 'ben.wav'); assert.strictEqual(got.language, 'tr'); assert.strictEqual(got.speed, 1.2);
  const v = await sm.serverVoices(url);
  assert.ok(v.ok); assert.deepStrictEqual(v.voices, ['anna.wav', 'ben.wav']);
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

test('Supertonic: Text, Teilstücke, WAV', () => {
  const st = require('../lib/supertonic');
  assert.strictEqual(st.preprocessText('Hallo  Welt', 'de'), '<de>Hallo Welt.</de>');
  assert.strictEqual(st.preprocessText('Merhaba!', 'tr'), '<tr>Merhaba!</tr>');
  assert.throws(() => st.preprocessText('x', 'xx'));
  const ch = st.chunkText('Eins ist da. ' + 'Zwei ist auch da. '.repeat(30), 100);
  assert.ok(ch.length > 3 && ch.every((c) => c.length <= 120));
  const w = st.wavBuffer(Float32Array.from([0, 0.5, -0.5]), 44100);
  assert.strictEqual(w.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(w.readUInt32LE(24), 44100);
  assert.strictEqual(w.length, 44 + 6);
  assert.deepStrictEqual(Object.keys(st.VOICES), ['elena', 'tessa', 'caleb']);
});

test('Supertonic: Ablauf mit nachgebautem onnxruntime', async () => {
  const { Supertonic, MODEL_FILES, VOICES } = require('../lib/supertonic');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-st-'));
  const calls = [];
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const ort = {
    Tensor,
    InferenceSession: {
      create: async (file) => ({
        run: async (f) => {
          const n = path.basename(file, '.onnx');
          calls.push(n);
          if (n === 'duration_predictor') { assert.strictEqual(f.text_ids.type, 'int64'); return { duration: { data: [1.0] } }; }
          if (n === 'text_encoder') return { text_emb: new Tensor('float32', new Float32Array(4), [1, 2, 2]) };
          if (n === 'vector_estimator') {
            assert.ok(f.noisy_latent && f.latent_mask && f.total_step && f.current_step && f.text_emb);
            return { denoised_latent: { data: f.noisy_latent.data } };
          }
          return { wav_tts: { data: new Float32Array(f.latent.dims[2] * 512 * 2).fill(0.1) } };
        },
      }),
    },
  };
  const s = new Supertonic(ud, () => {}, ort);
  assert.strictEqual(s.status().ready, false);
  for (const f of MODEL_FILES) {
    fs.mkdirSync(path.dirname(s.file(f)), { recursive: true });
    fs.writeFileSync(s.file(f), f === 'onnx/tts.json' ? JSON.stringify({ ae: { sample_rate: 1000, base_chunk_size: 10 }, ttl: { chunk_compress_factor: 2, latent_dim: 3 } }) : f === 'onnx/unicode_indexer.json' ? JSON.stringify(Array.from({ length: 400 }, (_, i) => i)) : 'x');
  }
  fs.mkdirSync(path.join(s.dir, 'voice_styles'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'voice_styles', VOICES.elena.id + '.json'), JSON.stringify({ style_ttl: { data: [[[1, 2], [3, 4]]], dims: [1, 2, 2] }, style_dp: { data: [[[1, 2]]], dims: [1, 1, 2] } }));
  assert.strictEqual(s.status().ready, true);
  assert.strictEqual(s.hasVoice('tessa'), false);
  await assert.rejects(s.synthesize('Hallo', 'de', 'tessa', 1, 2), /noch nicht geladen/);
  const wav = await s.synthesize('Guten Tag. Wie geht es Dir?', 'de', 'elena', 1, 2);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), 1000);
  assert.ok(wav.length > 44);
  assert.ok(calls.includes('vocoder') && calls.filter((c) => c === 'vector_estimator').length >= 2);
});

test('Whisper-Ausgabe: Umlaut über Blockgrenze bleibt heil', async () => {
  const { decodeChunks, run } = require('../lib/speech');
  const buf = Buffer.from('Grüße aus München', 'utf8');
  const i = buf.indexOf(0xc3);
  assert.strictEqual(decodeChunks([buf.subarray(0, i + 1), buf.subarray(i + 1)]), 'Grüße aus München');
  // Echter Kindprozess, der das „ü“ in zwei getrennten Schreibvorgängen ausgibt
  const script = "const b=Buffer.from('Grüße','utf8');process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),60);";
  const { out } = await run(process.execPath, ['-e', script], { timeoutMs: 10000 });
  assert.strictEqual(out, 'Grüße');
});

test('Supertonic: Stopp verwirft laufende und wartende Sätze', async () => {
  const { Supertonic, MODEL_FILES, VOICES } = require('../lib/supertonic');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-stc-'));
  const calls = [];
  class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
  const ort = {
    Tensor,
    InferenceSession: {
      create: async (file) => ({
        run: async (f) => {
          const n = path.basename(file, '.onnx');
          calls.push(n);
          await new Promise((r) => setTimeout(r, 10));
          if (n === 'duration_predictor') return { duration: { data: [1.0] } };
          if (n === 'text_encoder') return { text_emb: new Tensor('float32', new Float32Array(4), [1, 2, 2]) };
          if (n === 'vector_estimator') return { denoised_latent: { data: f.noisy_latent.data } };
          return { wav_tts: { data: new Float32Array(f.latent.dims[2] * 512 * 2).fill(0.1) } };
        },
      }),
    },
  };
  const s = new Supertonic(ud, () => {}, ort);
  for (const f of MODEL_FILES) {
    fs.mkdirSync(path.dirname(s.file(f)), { recursive: true });
    fs.writeFileSync(s.file(f), f === 'onnx/tts.json' ? JSON.stringify({ ae: { sample_rate: 1000, base_chunk_size: 10 }, ttl: { chunk_compress_factor: 2, latent_dim: 3 } }) : f === 'onnx/unicode_indexer.json' ? JSON.stringify(Array.from({ length: 400 }, (_, i) => i)) : 'x');
  }
  fs.mkdirSync(path.join(s.dir, 'voice_styles'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'voice_styles', VOICES.elena.id + '.json'), JSON.stringify({ style_ttl: { data: [[[1, 2], [3, 4]]], dims: [1, 2, 2] }, style_dp: { data: [[[1, 2]]], dims: [1, 1, 2] } }));
  // Drei vorab angestoßene Sätze (wie beim Vorlesen), dann Stopp mitten im ersten
  const jobs = ['Erster Satz.', 'Zweiter Satz.', 'Dritter Satz.'].map((t) => s.synthesize(t, 'de', 'elena', 1, 8));
  while (!calls.includes('vector_estimator')) await new Promise((r) => setTimeout(r, 2));
  s.cancel();
  const res = await Promise.allSettled(jobs);
  assert.ok(res.every((r) => r.status === 'rejected' && /abgebrochen/.test(r.reason.message)));
  assert.strictEqual(calls.filter((c) => c === 'duration_predictor').length, 1, 'wartende Sätze dürfen nicht starten');
  assert.ok(!calls.includes('vocoder'), 'abgebrochener Satz darf nicht fertig gerechnet werden');
  assert.ok(calls.filter((c) => c === 'vector_estimator').length < 8);
  // Nach dem Stopp funktioniert neues Vorlesen wieder
  const wav = await s.synthesize('Neu.', 'de', 'elena', 1, 2);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
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

test('Whisper: Audio-Kontext passend zur Aufnahmelänge', () => {
  const { audioCtxFor, wavSeconds } = require('../lib/speech');
  assert.strictEqual(audioCtxFor(2), 768);
  assert.strictEqual(audioCtxFor(11), 768);
  assert.ok(audioCtxFor(20) >= (20 + 2.5) * 50);
  assert.strictEqual(audioCtxFor(29), 0);
  assert.strictEqual(audioCtxFor(0), 0);
  assert.strictEqual(wavSeconds(Buffer.alloc(44 + 32000 * 3)), 3);
});

test('Whisper-Server: bleibt geladen, Umlaute heil, Rückfall auf CLI', { skip: process.platform === 'win32' }, async () => {
  const { SpeechManager } = require('../lib/speech');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ws-'));
  const bundled = path.join(ud, 'bundled');
  fs.mkdirSync(path.join(bundled, 'whisper'), { recursive: true });
  const log = path.join(ud, 'spawns.log');
  // Nachgebauter whisper-server: zählt Starts, antwortet mit „Grüße“, Mehrbyte-Zeichen über zwei Pakete verteilt
  const fake = path.join(bundled, 'whisper', 'whisper-server');
  fs.writeFileSync(fake, `#!${process.execPath}
const http = require('http'); const fs = require('fs');
const a = process.argv; const port = Number(a[a.indexOf('--port') + 1]);
fs.appendFileSync(${JSON.stringify(log)}, 'start\\n');
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"status":"ok"}');
  let b = []; req.on('data', (d) => b.push(d)); req.on('end', () => {
    const body = Buffer.concat(b).toString('latin1');
    fs.appendFileSync(${JSON.stringify(log)}, (/name="audio_ctx"\\r\\n\\r\\n(\\d+)/.exec(body) || [])[1] + ' ' + (/name="language"\\r\\n\\r\\n(\\w+)/.exec(body) || [])[1] + '\\n');
    const out = Buffer.from(JSON.stringify({ text: ' Grüße aus München' }), 'utf8');
    const i = out.indexOf(0xc3);
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Length', out.length);
    res.write(out.subarray(0, i + 1)); setTimeout(() => res.end(out.subarray(i + 1)), 30);
  });
}).listen(port, '127.0.0.1');
`);
  fs.chmodSync(fake, 0o755);
  const sm = new SpeechManager(ud, () => {}, bundled);
  fs.mkdirSync(path.dirname(sm.whisperModelPath('small')), { recursive: true });
  fs.writeFileSync(sm.whisperModelPath('small'), 'x');
  try {
    const wav = Buffer.alloc(44 + 32000 * 3);
    assert.strictEqual(await sm.transcribe(wav, 'de', 'small'), 'Grüße aus München');
    assert.strictEqual(sm.lastTiming.path, 'server');
    assert.strictEqual(await sm.transcribe(wav, 'de', 'small'), 'Grüße aus München');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.strictEqual(lines.filter((l) => l === 'start').length, 1, 'Modell darf nur einmal geladen werden');
    assert.ok(lines.includes('undefined de')); // kein audio_ctx mehr: es führte zu Fehlerkennung ("[Musik]")
  } finally {
    sm.stopWhisperServer();
  }
  // Ohne Server und ohne CLI: klare Meldung
  fs.unlinkSync(fake);
  await assert.rejects(sm.transcribe(Buffer.alloc(44 + 32000), 'de', 'small'), /nicht eingerichtet/);
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
