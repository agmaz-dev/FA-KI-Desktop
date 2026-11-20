'use strict';
// Sprachtest für die CI (Windows und Mac): prüft mit den echten Programmen, ob
//  1) Phonon (ptts) mit lokalem Modellordner, Stimmdatei Anton und Textsprache einen Satz erzeugt und
//  2) Voxtral (llama-server + GGUF) diesen Satz über die Realtime-Schnittstelle wieder als Text liefert.
// Für Phonon wird das freie, gleich aufgebaute phonon-31m-en genommen (das mehrsprachige Modell braucht ein HF-Token).
// Aufruf: node scripts/voice-probe.js <ptts> <llama-server|-> <arbeitsordner>

const fs = require('fs');
const path = require('path');
const { Phonon, MODEL_FILES, voiceOf } = require('../lib/phonon');
const { Voxtral } = require('../lib/voxtral');
const { fetchFile } = require('../lib/download');

const [ptts, llama, work] = process.argv.slice(2);
if (!ptts || !work) { console.error('Aufruf: voice-probe.js <ptts> <llama-server|-> <ordner>'); process.exit(2); }

async function tree(repo, sub = '') {
  const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main${sub ? '/' + sub : ''}`);
  if (!r.ok) throw new Error(`${repo}: ${r.status}`);
  return new Map((await r.json()).filter((f) => f.type === 'file').map((f) => [f.path, (f.lfs && f.lfs.size) || f.size]));
}

(async () => {
  process.env.FA_PTTS = path.resolve(ptts);
  const ph = new Phonon(work, '');
  ph.modelDir = path.join(work, 'phonon-31m-en');
  const sizes = await tree('gradium/phonon-31m-en');
  for (const f of MODEL_FILES) await fetchFile(`https://huggingface.co/gradium/phonon-31m-en/resolve/main/${f}`, path.join(ph.modelDir, f), sizes.get(f), () => {});
  const vs = await tree('gradium/phonon-voices', 'voices');
  for (const k of ['anton', 'nele', 'easton']) {
    const rel = `voices/${voiceOf(k).id}.safetensors`;
    await fetchFile(`https://huggingface.co/gradium/phonon-voices/resolve/main/${rel}`, ph.voiceFile(k), vs.get(rel), () => {});
  }
  console.log('Phonon bereit:', ph.modelReady(), 'Programm:', ph.bin());

  const sentence = 'Hello, this is a short dictation test. The weather is nice today, and the meeting starts at 10:30.';
  let t0 = Date.now();
  const wav = await ph.synthesize(sentence, { lang: 'en', voice: 'easton' });
  console.log(`Phonon: ${wav.length} Bytes WAV in ${Date.now() - t0} ms`);
  if (wav.length < 24000 * 2) throw new Error('Phonon-Ausgabe ist zu kurz.');
  t0 = Date.now();
  const de = await ph.synthesize('Hallo, ich bin Anton. Heute ist der 20. November.', { lang: 'de', voice: 'anton' });
  console.log(`Phonon (Stimme Anton, Textsprache de): ${de.length} Bytes in ${Date.now() - t0} ms`);
  fs.writeFileSync(path.join(work, 'phonon-probe.wav'), wav);

  if (!llama || llama === '-') { console.log('Voxtral übersprungen.'); return; }
  const vx = new Voxtral(work, () => path.resolve(llama), (p) => { if (p.pct != null && p.pct % 10 === 0) process.stdout.write(`\rVoxtral lädt: ${p.pct} %   `); });
  t0 = Date.now();
  await vx.install();
  console.log(`\nVoxtral geladen in ${Math.round((Date.now() - t0) / 1000)} s`);
  t0 = Date.now();
  await vx.ensure();
  console.log(`Voxtral-Server bereit in ${Date.now() - t0} ms`);
  for (let i = 1; i <= 2; i++) {
    t0 = Date.now();
    const text = await vx.transcribe(wav);
    console.log(`Voxtral Durchgang ${i} (${Date.now() - t0} ms): ${text}`);
    if (!/dictation|weather|meeting/i.test(text)) throw new Error('Voxtral hat den Satz nicht erkannt.');
  }
  vx.stop();
})().then(() => { console.log('Sprachtest OK'); process.exit(0); }, (e) => { console.error('Sprachtest FEHLER:', e && e.stack || e); process.exit(1); });
