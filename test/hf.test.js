'use strict';
const test = require('node:test');
const assert = require('node:assert');
const hf = require('../lib/hf');

const GB = 1024 ** 3;
const hw = { vramGb: 16, ramGb: 32 };

test('Quantisierungen aus Dateien: geteilte Dateien addiert, mmproj getrennt', () => {
  const { quants, hasMmproj } = hf.quantsFromFiles([
    { rfilename: 'README.md', size: 10 },
    { rfilename: 'm-Q4_K_M.gguf', size: 9 * GB },
    { rfilename: 'm-Q8_0-00001-of-00002.gguf', size: 10 * GB },
    { rfilename: 'm-Q8_0-00002-of-00002.gguf', size: 5 * GB },
    { rfilename: 'm-IQ4_XS.gguf', size: 8 * GB },
    { rfilename: 'mmproj-F16.gguf', size: 1 * GB },
    { rfilename: 'sub/UD-Q5_K_XL.gguf', size: 11 * GB },
    { rfilename: 'm-BF16.gguf', size: 30 * GB },
  ]);
  const by = Object.fromEntries(quants.map((q) => [q.name, q.bytes / GB]));
  assert.strictEqual(by.Q4_K_M, 9);
  assert.strictEqual(by.Q8_0, 15);
  assert.strictEqual(by.IQ4_XS, 8);
  assert.strictEqual(by.Q5_K_XL, 11);
  assert.strictEqual(by.BF16, 30);
  assert.ok(!('F16' in by) && hasMmproj);
  assert.deepStrictEqual(quants.map((q) => q.name), ['IQ4_XS', 'Q4_K_M', 'Q5_K_XL', 'Q8_0', 'BF16']);
});

test('Passt auf die Karte: 16 GB Grafikspeicher, 32 GB Arbeitsspeicher', () => {
  assert.strictEqual(hf.fitFor(9 * GB, hw).fit, 'gpu');
  assert.strictEqual(hf.fitFor(14 * GB, hw).fit, 'gpu');
  assert.strictEqual(hf.fitFor(15 * GB, hw).fit, 'teils');
  assert.strictEqual(hf.fitFor(30 * GB, hw).fit, 'teils');
  assert.strictEqual(hf.fitFor(40 * GB, hw).fit, 'nein');
  assert.strictEqual(hf.fitFor(9 * GB, { vramGb: 8, ramGb: 16 }).fit, 'teils');
});

test('Empfehlung: größte brauchbare Stufe, die ganz auf die Karte passt', () => {
  const q = (name, g) => ({ name, bytes: g * GB });
  assert.strictEqual(hf.recommend([q('Q2_K', 5), q('Q4_K_M', 9), q('Q6_K', 12), q('Q8_0', 15), q('BF16', 30)], hw), 'Q6_K');
  assert.strictEqual(hf.recommend([q('Q4_K_M', 20), q('Q8_0', 35)], hw), 'Q4_K_M');
  assert.strictEqual(hf.recommend([], hw), '');
});

test('Merkmale grob aus Schlagworten', () => {
  assert.ok(hf.featuresOf({ id: 'a/Qwen3-VL-8B-GGUF', tags: ['image-text-to-text'] }).includes('Bilder'));
  assert.ok(hf.featuresOf({ id: 'a/x', tags: ['reasoning'] }).includes('Denken'));
  assert.deepStrictEqual(hf.featuresOf({ id: 'a/base-model', tags: [] }), []);
});

test('Suche und Details mit nachgebauter Hugging-Face-Antwort', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (/\/api\/models\?/.test(url)) return new Response(JSON.stringify([{ id: 'unsloth/gpt-oss-20b-GGUF', downloads: 5, likes: 2, tags: ['gguf'] }, { id: '../böse', downloads: 1 }]));
    if (/\/api\/models\/unsloth/.test(url)) return new Response(JSON.stringify({ id: 'unsloth/gpt-oss-20b-GGUF', siblings: [{ rfilename: 'a-Q4_K_M.gguf', size: 9 * GB }, { rfilename: 'a-Q8_0.gguf', size: 15 * GB }], tags: ['gguf'], gguf: { architecture: 'gptoss', context_length: 131072 } }));
    if (/README/.test(url)) return new Response('---\nlicense: mit\n---\n# Titel\nText');
    return new Response('', { status: 404 });
  };
  const r = await hf.search('gpt-oss', {}, fetchImpl);
  assert.strictEqual(r.length, 1);
  assert.match(urls[0], /filter=gguf.*search=gpt-oss/);
  const d = await hf.details('unsloth/gpt-oss-20b-GGUF', hw, fetchImpl);
  assert.strictEqual(d.quants.length, 2);
  const rec = d.quants.find((x) => x.empfohlen);
  assert.strictEqual(rec.name, 'Q4_K_M'); // Q8_0 hat 15 GB, mit Kontext zu viel für 16 GB
  assert.strictEqual(rec.pull, 'unsloth/gpt-oss-20b-GGUF:Q4_K_M');
  assert.strictEqual(d.quants.find((x) => x.name === 'Q8_0').fit, 'teils');
  assert.ok(d.readme.startsWith('# Titel'));
  await assert.rejects(() => hf.details('../x', hw, fetchImpl), /Ungültig/);
});

test('Modellnamen für den Download sind sauber', () => {
  assert.deepStrictEqual(hf.parsePull('unsloth/gpt-oss-20b-GGUF:q4_k_m'), { id: 'unsloth/gpt-oss-20b-GGUF', quant: 'Q4_K_M' });
  for (const bad of ['', 'a b', '../x:Q4', 'x;rm -rf', 'http://evil/x', '-flag', 'gpt-oss:20b', 'a/b', 'a/b:', 'a/../b:Q4', 'hf.co/a/b:Q4_K_M']) assert.strictEqual(hf.parsePull(bad), null, bad);
});

test('Download-Plan: Dateien einer Stufe, Bildteil, fehlende Stufe', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ id: 'o/r', tags: ['gguf', 'image-text-to-text'], siblings: [
    { rfilename: 'r-Q8_0-00002-of-00002.gguf', size: 5 }, { rfilename: 'r-Q8_0-00001-of-00002.gguf', size: 10 },
    { rfilename: 'r-Q4_K_M.gguf', size: 7 }, { rfilename: 'mmproj-BF16.gguf', size: 3 }, { rfilename: 'mmproj-F16.gguf', size: 2 },
  ] }));
  const p = await hf.plan('o/r', 'q8_0', fetchImpl);
  assert.deepStrictEqual(p.files.map((f) => f.path), ['r-Q8_0-00001-of-00002.gguf', 'r-Q8_0-00002-of-00002.gguf']);
  assert.strictEqual(p.mmproj.path, 'mmproj-F16.gguf');
  assert.ok(p.features.includes('Bilder'));
  await assert.rejects(() => hf.plan('o/r', 'Q2_K', fetchImpl), /gibt es in diesem Repo nicht/);
  await assert.rejects(() => hf.plan('../x', 'Q4', fetchImpl), /Ungültig/);
});
