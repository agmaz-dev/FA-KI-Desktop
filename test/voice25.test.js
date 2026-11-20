'use strict';
// Tests für 2.5.0: Download-Warteschlange, Hugging-Face-Link im Suchfeld, Phonon, Voxtral
const test = require('node:test');
const assert = require('node:assert');
const { DownloadQueue } = require('../lib/dlqueue');
const hf = require('../lib/hf');
const phonon = require('../lib/phonon');
const { transcribeRealtime, wavPcm } = require('../lib/voxtral');

const tick = () => new Promise((r) => setImmediate(r));

test('Warteschlange: höchstens 3 gleichzeitig, der Rest wartet und rückt nach', async () => {
  const gates = new Map();
  let maxRun = 0; let run = 0;
  const states = [];
  const q = new DownloadQueue({
    max: 3,
    run: (name) => new Promise((resolve) => { run++; maxRun = Math.max(maxRun, run); gates.set(name, () => { run--; resolve(true); }); }),
    onState: (s) => states.push(`${s.name}:${s.state}`),
  });
  const ps = ['a', 'b', 'c', 'd', 'e'].map((n) => q.add(n));
  await tick();
  assert.deepStrictEqual(q.list().map((j) => j.state), ['running', 'running', 'running', 'queued', 'queued']);
  gates.get('a')();
  await tick(); await tick();
  assert.ok(states.includes('d:running'));
  assert.ok(!states.includes('e:running'));
  for (const n of ['b', 'c', 'd']) gates.get(n)();
  await tick(); await tick();
  gates.get('e')();
  const res = await Promise.all(ps);
  assert.deepStrictEqual(res, [true, true, true, true, true]);
  assert.strictEqual(maxRun, 3);
});

test('Warteschlange: Abbrechen je Name (laufend und wartend), doppelter Name nur einmal', async () => {
  const q = new DownloadQueue({
    max: 1,
    run: (_name, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ aborted: true }))),
  });
  const a = q.add('a');
  const a2 = q.add('a');
  const b = q.add('b');
  assert.strictEqual(a, a2);
  await tick();
  assert.strictEqual(q.cancel('b'), true); // wartend
  assert.deepStrictEqual(await b, { aborted: true });
  q.cancel('a'); // laufend
  assert.deepStrictEqual(await a, { aborted: true });
  assert.strictEqual(q.list().length, 0);
});

test('Warteschlange: Fehler eines Downloads hält die anderen nicht auf', async () => {
  const q = new DownloadQueue({ max: 2, run: async (n) => { if (n === 'x') throw new Error('kaputt'); return true; } });
  const [x, y] = [q.add('x'), q.add('y')];
  await assert.rejects(x, /kaputt/);
  assert.strictEqual(await y, true);
});

test('Suchfeld: Hugging-Face-Link oder autor/name wird als Modell erkannt', () => {
  const r = hf.repoFromInput;
  assert.strictEqual(r('https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF'), 'lmstudio-community/Qwen3.5-9B-GGUF');
  assert.strictEqual(r('huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF/tree/main'), 'lmstudio-community/Qwen3.5-9B-GGUF');
  assert.strictEqual(r('https://hf.co/unsloth/gpt-oss-20b-GGUF?show_file_info=x'), 'unsloth/gpt-oss-20b-GGUF');
  assert.strictEqual(r('https://huggingface.co/bartowski/x-GGUF/blob/main/x-Q4_K_M.gguf'), 'bartowski/x-GGUF');
  assert.strictEqual(r('lmstudio-community/Qwen3.5-9B-GGUF'), 'lmstudio-community/Qwen3.5-9B-GGUF');
  assert.strictEqual(r('unsloth/gpt-oss-20b-GGUF:Q4_K_M'), 'unsloth/gpt-oss-20b-GGUF');
  assert.strictEqual(r('  qwen3 '), '');
  assert.strictEqual(r('qwen 3/9b'), '');
  assert.strictEqual(r('https://huggingface.co/models?search=qwen'), '');
  assert.strictEqual(r('https://huggingface.co/spaces/foo/bar'), '');
  assert.strictEqual(r('../etc/passwd'), '');
});

test('Phonon: Stimmen Anton und Nele, Aufruf von ptts mit lokalem Ordner, Stimme und Textsprache', () => {
  const keys = phonon.VOICES.map((v) => v.key);
  assert.ok(keys.includes('anton') && keys.includes('nele'));
  assert.strictEqual(phonon.voiceOf('Anton').id, '3ZKKapPOvuWFcw9f');
  assert.strictEqual(phonon.voiceOf('nele').id, '2A2fFf8SkDEJ8nzx');
  assert.strictEqual(phonon.voiceOf('gibtsnicht').key, 'anton');
  const a = phonon.buildArgs({ modelDir: '/m', lang: 'en', voiceFile: '/v/a.safetensors', text: '-5 Grad', out: '/o.wav', threads: 4 });
  assert.deepStrictEqual(a, ['--model', '/m', '--lang', 'en', '--quant', 'q8', '--voice', '/v/a.safetensors', '--threads', '4', '-o', '/o.wav', '--', '-5 Grad']);
  assert.strictEqual(phonon.buildArgs({ modelDir: '/m', lang: 'tr', text: 'x', out: '/o' })[3], 'de'); // unbekannt -> Deutsch
  assert.ok(phonon.MODEL_FILES.includes('model.q8.gguf') && phonon.MODEL_FILES.includes('config.json') && phonon.MODEL_FILES.includes('tokenizer.json'));
});

function wav16k(samples) {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}

test('Voxtral: WAV lesen (Rate, PCM-Daten)', () => {
  const { pcm, rate } = wavPcm(wav16k(16000));
  assert.strictEqual(rate, 16000);
  assert.strictEqual(pcm.length, 32000);
  assert.throws(() => wavPcm(Buffer.from('nein')), /WAV/);
});

/** Nachgebauter Voxtral-Server: so wie llama.cpp ws_realtime antwortet. */
function fakeWs(script) {
  return class FakeWs {
    constructor(url) {
      this.url = url; this.sent = [];
      FakeWs.last = this;
      setImmediate(() => this._srv({ type: 'session.created', session: { audio: { input: { format: { type: 'audio/pcm', rate: script.rate || 16000 } } } } }));
    }
    _srv(m) { if (this.onmessage) this.onmessage({ data: JSON.stringify(m) }); }
    send(s) {
      const m = JSON.parse(s);
      this.sent.push(m);
      if (m.type === 'input_audio_buffer.commit' && m.final) {
        setImmediate(() => {
          for (const d of script.deltas || []) this._srv({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', delta: d });
          if (script.error) this._srv({ type: 'error', error: { message: script.error } });
          else this._srv({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: (script.deltas || []).join('') });
          if (this.onclose) this.onclose({});
        });
      }
    }
    close() {}
  };
}

test('Voxtral: Aufnahme in Stücken senden, final committen, Text einsammeln', async () => {
  const Ws = fakeWs({ deltas: [' Hallo', ' Welt,', ' wie geht es?'] });
  const { pcm, rate } = wavPcm(wav16k(16000 * 2)); // 2 s
  const text = await transcribeRealtime('ws://127.0.0.1:1/v1/realtime', pcm, rate, { WebSocketImpl: Ws });
  assert.strictEqual(text, 'Hallo Welt, wie geht es?');
  const sent = Ws.last.sent;
  const appends = sent.filter((m) => m.type === 'input_audio_buffer.append');
  assert.strictEqual(appends.length, 4); // 2 s in 0,5-s-Stücken
  assert.ok(appends.every((m) => Buffer.from(m.audio, 'base64').length % 2 === 0));
  assert.deepStrictEqual(sent[sent.length - 1], { type: 'input_audio_buffer.commit', final: true });
  assert.ok(!sent.some((m) => m.type === 'session.update')); // Rate passt schon
});

test('Voxtral: andere Abtastrate wird gemeldet, Fehler kommen durch', async () => {
  const Ws = fakeWs({ rate: 24000, deltas: ['x'] });
  const { pcm, rate } = wavPcm(wav16k(1600));
  await transcribeRealtime('ws://x', pcm, rate, { WebSocketImpl: Ws });
  assert.deepStrictEqual(Ws.last.sent[0], { type: 'session.update', session: { audio: { input: { format: { type: 'audio/pcm', rate: 16000 } } } } });
  const Bad = fakeWs({ error: 'kaputt' });
  await assert.rejects(transcribeRealtime('ws://x', pcm, rate, { WebSocketImpl: Bad }), /Voxtral: kaputt/);
});
