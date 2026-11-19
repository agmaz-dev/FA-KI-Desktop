'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ModelStore, findOllamaModels, importOllamaModel } = require('../lib/modelstore');
const { downloadModel, targetPath } = require('../lib/download');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fa-mod-'));
const put = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

test('Modellordner: Beschreibungsdatei, lose Dateien, geteilte Dateien, Löschen', () => {
  const root = tmp();
  const st = new ModelStore(() => root);
  put(path.join(root, 'o/r/m-Q4_K_M.gguf'), 'a'.repeat(10));
  put(path.join(root, 'o/r/mmproj-F16.gguf'), 'b'.repeat(4));
  put(path.join(root, 'o/r/.fa-Q4_K_M.json'), JSON.stringify({ name: 'o/r:Q4_K_M', files: ['m-Q4_K_M.gguf'], mmproj: 'mmproj-F16.gguf', features: ['Bilder', 'Werkzeuge'], quant: 'Q4_K_M', parameter: '9B' }));
  put(path.join(root, 'lose/Mein-Modell-7B-Q5_K_M.gguf'), 'c'.repeat(6));
  put(path.join(root, 'geteilt/x-Q8_0-00001-of-00002.gguf'), 'd'.repeat(5));
  put(path.join(root, 'geteilt/x-Q8_0-00002-of-00002.gguf'), 'e'.repeat(5));
  put(path.join(root, 'o2/halb/.fa-Q4_K_M.json'), JSON.stringify({ name: 'o2/halb:Q4_K_M', files: ['fehlt.gguf'] })); // Datei fehlt -> nicht anzeigen
  put(path.join(root, 'boese/.fa-Q4_K_M.json'), JSON.stringify({ name: 'boese:Q4_K_M', files: ['../../etc/passwd'] })); // ausserhalb -> nicht anzeigen
  const l = st.list();
  assert.deepStrictEqual(l.map((m) => m.name).sort(), ['geteilt/x-Q8_0', 'lose/Mein-Modell-7B-Q5_K_M', 'o/r:Q4_K_M']);
  const m = st.find('o/r:Q4_K_M');
  assert.strictEqual(m.size, 14); assert.ok(m.mmproj.endsWith('mmproj-F16.gguf'));
  assert.deepStrictEqual(st.capabilities('o/r:Q4_K_M').sort(), ['tools', 'vision']);
  assert.strictEqual(st.find('geteilt/x-Q8_0').size, 10);
  assert.strictEqual(st.find('lose/Mein-Modell-7B-Q5_K_M').details.parameter_size, '7B');
  st.remove('o/r:Q4_K_M');
  assert.ok(!fs.existsSync(path.join(root, 'o')), 'leere Ordner werden weggeräumt');
  assert.strictEqual(st.find('o/r:Q4_K_M'), null);
  assert.throws(() => st.remove('gibtsnicht'), /nicht gefunden/);
});

test('Ollama-Modelle übernehmen (Hardlink)', async () => {
  const oroot = tmp(); const root = tmp();
  put(path.join(oroot, 'blobs/sha256-aaa'), 'MODELL');
  put(path.join(oroot, 'blobs/sha256-bbb'), 'PROJ');
  put(path.join(oroot, 'manifests/registry.ollama.ai/library/gpt-oss/20b'), JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:aaa' }, { mediaType: 'application/vnd.ollama.image.projector', digest: 'sha256:bbb' }] }));
  put(path.join(oroot, 'manifests/hf.co/own/rep/Q4_K_M'), JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:aaa' }] }));
  const found = findOllamaModels(oroot);
  assert.deepStrictEqual(found.map((m) => m.name), ['gpt-oss:20b', 'own/rep:Q4_K_M']);
  const st = new ModelStore(() => root);
  await importOllamaModel(st, found[0]);
  const m = st.find('gpt-oss:20b');
  assert.ok(m && m.mmproj);
  assert.strictEqual(fs.readFileSync(m.file, 'utf8'), 'MODELL');
  assert.strictEqual(fs.statSync(m.file).ino, fs.statSync(path.join(oroot, 'blobs/sha256-aaa')).ino, 'Hardlink statt Kopie');
});

test('Zielpfad: nur innerhalb des Modellordners', () => {
  const root = tmp();
  assert.ok(targetPath(root, 'o/r', 'a/b.gguf').startsWith(path.resolve(root)));
  for (const bad of ['../x.gguf', 'a/../../x', '/etc/x', 'a\\b.gguf', 'c:x.gguf', '']) assert.throws(() => targetPath(root, 'o/r', bad), /Ungültig/, bad);
});

function fakeHf(files) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, range: opts.headers && opts.headers.Range });
    if (/\/api\/models\//.test(url)) return new Response(JSON.stringify({ id: 'o/r', tags: ['gguf'], siblings: Object.entries(files).map(([n, c]) => ({ rfilename: n, size: c.length })) }));
    const name = decodeURIComponent(url.split('/resolve/main/')[1]);
    const c = files[name];
    if (c == null) return new Response('', { status: 404, statusText: 'Not Found' });
    const m = opts.headers && opts.headers.Range && opts.headers.Range.match(/bytes=(\d+)-/);
    if (m) return new Response(c.slice(+m[1]), { status: 206 });
    return new Response(c);
  };
  f.calls = calls;
  return f;
}

test('Download: lädt Dateien, schreibt Beschreibung, meldet Fortschritt', async () => {
  const root = tmp();
  const files = { 'r-Q4_K_M.gguf': 'A'.repeat(1000), 'mmproj-F16.gguf': 'B'.repeat(100) };
  const prog = [];
  const r = await downloadModel({ name: 'o/r:Q4_K_M', root, fetchImpl: fakeHf(files), onProgress: (p) => prog.push(p) });
  assert.strictEqual(r, true);
  assert.strictEqual(prog[prog.length - 1].completed, 1100); assert.strictEqual(prog[prog.length - 1].total, 1100);
  const m = new ModelStore(() => root).find('o/r:Q4_K_M');
  assert.ok(m && m.mmproj && m.size === 1100);
  assert.ok(!fs.existsSync(path.join(root, 'o/r/r-Q4_K_M.gguf.part')));
});

test('Download: setzt einen abgebrochenen Download fort', async () => {
  const root = tmp();
  const files = { 'r-Q4_K_M.gguf': 'ABCDEFGHIJ'.repeat(100) };
  put(path.join(root, 'o/r/r-Q4_K_M.gguf.part'), files['r-Q4_K_M.gguf'].slice(0, 400));
  const f = fakeHf(files);
  await downloadModel({ name: 'o/r:Q4_K_M', root, fetchImpl: f, onProgress: () => {} });
  assert.strictEqual(f.calls.find((c) => /resolve/.test(c.url)).range, 'bytes=400-');
  assert.strictEqual(fs.readFileSync(path.join(root, 'o/r/r-Q4_K_M.gguf'), 'utf8'), files['r-Q4_K_M.gguf']);
});

test('Download: Abbruch lässt den Rest liegen, falsche Größe und Fehler werden gemeldet', async () => {
  const root = tmp();
  const files = { 'r-Q4_K_M.gguf': 'Z'.repeat(5000) };
  const c = new AbortController();
  const slow = async (url, opts) => {
    if (/\/api\/models\//.test(url)) return fakeHf(files)(url, opts);
    const stream = new ReadableStream({ async start(ctl) { ctl.enqueue(new TextEncoder().encode('Z'.repeat(1000))); c.abort(); ctl.error(new DOMException('abort', 'AbortError')); } });
    return new Response(stream);
  };
  const r = await downloadModel({ name: 'o/r:Q4_K_M', root, fetchImpl: slow, signal: c.signal, onProgress: () => {} });
  assert.deepStrictEqual(r, { aborted: true });
  assert.ok(fs.existsSync(path.join(root, 'o/r/r-Q4_K_M.gguf.part')));
  assert.strictEqual(new ModelStore(() => root).list().length, 0, 'halbe Modelle werden nicht angezeigt');
  await assert.rejects(downloadModel({ name: 'o/r:Q4_K_M', root: tmp(), fetchImpl: async (u) => (/\/api\/models\//.test(u) ? fakeHf(files)(u) : new Response('', { status: 429 })), onProgress: () => {} }), /zu viele Anfragen/);
  await assert.rejects(downloadModel({ name: 'kaputt', root, onProgress: () => {} }), /Ungültig/);
});
