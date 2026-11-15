import { stripMarkdown, detectLang, splitSentences } from '../lib/util.js';

// ---------- Aufnahme ----------
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

async function blobToWav16k(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), rate);
}

/**
 * Startet eine Aufnahme. Mit vad=true endet sie automatisch nach einer Sprechpause.
 * Gibt { stop(), cancel(), done } zurück; done liefert WAV-Bytes (16 kHz, mono) oder null (nichts gesprochen).
 */
export async function startRecording({ vad = false, onLevel } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);

  let spoke = false;
  let lastVoice = Date.now();
  const started = Date.now();
  let cancelled = false;
  let finish;
  const done = new Promise((r) => { finish = r; });

  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    onLevel && onLevel(rms);
    if (rms > 0.02) { spoke = true; lastVoice = Date.now(); }
    if (vad) {
      const now = Date.now();
      if (spoke && now - lastVoice > 1400) stop();
      else if (!spoke && now - started > 9000) { cancelled = true; stop(); }
      else if (now - started > 120000) stop();
    }
  }, 100);

  rec.onstop = async () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ac.close().catch(() => {});
    if (cancelled || (vad && !spoke) || !chunks.length) return finish(null);
    try { finish(await blobToWav16k(new Blob(chunks, { type: rec.mimeType }))); } catch { finish(null); }
  };
  function stop() { if (rec.state !== 'inactive') rec.stop(); }
  function cancel() { cancelled = true; stop(); }
  rec.start(250);
  return { stop, cancel, done };
}

// ---------- Vorlesen ----------
let playing = null; // { audio }
let session = 0;    // wird bei jedem Stopp erhöht: alles Alte ist dann ungültig
let stateCb = null;

function hardCancelSynth() {
  try {
    const ss = window.speechSynthesis;
    ss.cancel();
    ss.resume();
    ss.cancel();
  } catch { /* egal */ }
}

let cancelP = Promise.resolve();
let serverJobs = false;

export function stopSpeaking() {
  session++;
  if (serverJobs && window.api.speech.cancelSynth) {
    serverJobs = false;
    cancelP = window.api.speech.cancelSynth().catch(() => {});
  }
  if (playing && playing.audio) {
    try { playing.audio.pause(); playing.audio.removeAttribute('src'); playing.audio.load(); } catch { /* egal */ }
    if (playing.done) playing.done();
  }
  playing = null;
  hardCancelSynth();
  // Manche Windows-Stimmen reagieren erst verzögert auf cancel – daher mehrfach.
  setTimeout(hardCancelSynth, 80);
  setTimeout(hardCancelSynth, 400);
  if (stateCb) { const cb = stateCb; stateCb = null; cb(false); }
}

export const isSpeaking = () => !!playing || window.speechSynthesis.speaking;

function pickWindowsVoice(lang) {
  const voices = window.speechSynthesis.getVoices();
  const pref = lang === 'tr' ? /^tr/i : /^de/i;
  const list = voices.filter((v) => pref.test(v.lang));
  return list.find((v) => /natural|online/i.test(v.name)) || list[0] || null;
}

function speakWindows(text, lang, rate, token) {
  return new Promise((resolve) => {
    if (token !== session) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'tr' ? 'tr-TR' : 'de-DE';
    u.rate = Math.min(2, Math.max(0.5, rate || 1));
    const v = pickWindowsVoice(lang);
    if (v) u.voice = v;
    let finished = false;
    const end = () => { if (!finished) { finished = true; resolve(); } };
    u.onend = end;
    u.onerror = end;
    // Wurde zwischenzeitlich gestoppt, sofort abbrechen
    u.onboundary = () => { if (token !== session) { hardCancelSynth(); end(); } };
    window.speechSynthesis.speak(u);
  });
}

function playBytes(bytes, token) {
  return new Promise((resolve) => {
    if (token !== session) return resolve();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const a = new Audio(url);
    let finished = false;
    const done = () => { if (!finished) { finished = true; URL.revokeObjectURL(url); resolve(); } };
    playing = { audio: a, done };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}

/**
 * Liest Markdown-Text vor. voicePref: 'auto' | 'de' | 'tr' | 'windows'.
 * Nutzt Piper (lokal, natürlich), sonst die Windows-Stimme. Jeder Stopp macht alles Laufende ungültig.
 */
/** Schneidet den ersten Satz an einem Komma kurz, damit die Stimme früher anfängt. */
function shortFirst(sentences) {
  const f = sentences[0] || '';
  if (f.length <= 90) return sentences;
  const m = f.slice(0, 110).match(/^(.{35,110}?[,;:])\s/);
  if (!m) return sentences;
  return [m[1], f.slice(m[1].length).trim(), ...sentences.slice(1)].filter(Boolean);
}

export async function speak(markdown, { voicePref = 'auto', speechStatus, speed = 1, engine = 'piper', onState, onWarn } = {}) {
  stopSpeaking();
  const token = session;
  await cancelP;
  if (token !== session) return;
  const plain = stripMarkdown(markdown);
  if (!plain) return;
  const lang = voicePref === 'de' || voicePref === 'tr' ? voicePref : detectLang(plain);
  const serverMode = engine === 'server' && voicePref !== 'windows';
  const piperOk = serverMode || (voicePref !== 'windows' && speechStatus && speechStatus.piperBinary && speechStatus.voices[lang]);
  let warned = false;
  const synthOnce = (t) => window.api.speech.synthesize({ text: t, voice: lang, speed });
  const synth = async (t) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (token !== session) return null;
      try {
        return await synthOnce(t);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (attempt === 1 && !/499|abgebrochen/i.test(msg) && token === session) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        if (!warned && onWarn && token === session) { warned = true; onWarn(msg); }
        return null;
      }
    }
    return null;
  };
  let sentences = splitSentences(plain, piperOk ? (serverMode ? 200 : 300) : 200);
  if (serverMode) sentences = shortFirst(sentences);
  stateCb = onState || null;
  onState && onState(true);
  try {
    if (piperOk) {
      // Mehrere Sätze vorab erzeugen, während der aktuelle spricht (Server arbeitet sie nacheinander ab).
      const depth = serverMode ? 3 : 2;
      const jobs = [];
      let started = 0;
      const pump = (upTo) => {
        while (started < sentences.length && started <= upTo) {
          if (serverMode) serverJobs = true;
          jobs[started] = synth(sentences[started]);
          started++;
        }
      };
      for (let i = 0; i < sentences.length; i++) {
        pump(i + depth - 1);
        const cur = await jobs[i];
        if (token !== session) return;
        pump(i + depth);
        if (cur) await playBytes(cur, token);
        else await speakWindows(sentences[i], lang, speed, token);
        if (token !== session) return;
      }
    } else {
      for (const s of sentences) {
        if (token !== session) return;
        await speakWindows(s, lang, speed, token);
      }
    }
  } finally {
    if (token === session) {
      playing = null;
      if (stateCb) { const cb = stateCb; stateCb = null; cb(false); }
    }
  }
}
