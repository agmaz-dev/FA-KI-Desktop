// Misst die Spracherkennung: whisper-cli (alt, Modell pro Aufnahme) gegen whisper-server (Modell bleibt geladen).
// Aufruf unter Windows (im Installationsordner oder Repo):
//   node scripts/bench-whisper.js <aufnahme.wav (16 kHz mono)> [small|base|medium] [Ordner mit whisper-cli.exe/whisper-server.exe]
// Die Modelle werden aus %APPDATA%\FA KI Desktop\whisper\models gelesen.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SpeechManager, run } = require('../lib/speech');

(async () => {
  const [wavFile, model = 'small', binDir] = process.argv.slice(2);
  if (!wavFile) { console.log('Aufruf: node scripts/bench-whisper.js <datei.wav> [small] [bin-ordner]'); process.exit(1); }
  const dataDir = process.env.FA_DATA || path.join(process.env.APPDATA || os.homedir(), 'FA KI Desktop');
  const bundled = binDir ? path.dirname(path.resolve(binDir)) : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'FA KI Desktop', 'resources');
  const sm = new SpeechManager(dataDir, () => {}, bundled);
  const wav = fs.readFileSync(wavFile);
  const mp = sm.whisperModelPath(model);
  const cli = sm.whisperBin();
  console.log('Modell:', mp, '\nCLI:', cli, '\nServer:', sm.whisperServerBin());
  if (cli) {
    const tmp = path.join(os.tmpdir(), 'bench.wav'); fs.writeFileSync(tmp, wav);
    const t0 = Date.now();
    const { out } = await run(cli, ['-m', mp, '-f', tmp, '-l', 'de', '-nt', '-np', '-t', String(sm._threads())], { cwd: path.dirname(cli), timeoutMs: 300000 });
    console.log(`ALT  whisper-cli (Standard, Modell neu laden): ${((Date.now() - t0) / 1000).toFixed(2)} s  „${out.trim().slice(0, 80)}“`);
  }
  let t0 = Date.now();
  const ok = await sm.ensureWhisperServer(model);
  console.log(`whisper-server Start + Modell laden (einmalig): ${((Date.now() - t0) / 1000).toFixed(2)} s`, ok ? '' : '(fehlgeschlagen)');
  for (let i = 1; i <= 3; i++) {
    t0 = Date.now();
    const text = await sm.transcribe(wav, 'de', model);
    console.log(`NEU  Aufnahme ${i} über ${sm.lastTiming.path} (audio_ctx ${sm.lastTiming.audioCtx}): ${((Date.now() - t0) / 1000).toFixed(2)} s  „${text.slice(0, 80)}“`);
  }
  sm.stopWhisperServer();
})().catch((e) => { console.error(e); process.exit(1); });
