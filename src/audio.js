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
let playing = null; // { aborted, audio }
let session = 0;

export function stopSpeaking() {
  session++;
  if (playing && playing.audio) { try { playing.audio.pause(); } catch { /* egal */ } }
  playing = null;
  try { window.speechSynthesis.cancel(); } catch { /* egal */ }
}

export const isSpeaking = () => !!playing;

function pickWindowsVoice(lang) {
  const voices = window.speechSynthesis.getVoices();
  const pref = lang === 'tr' ? /^tr/i : /^de/i;
  const list = voices.filter((v) => pref.test(v.lang));
  // „Natural“/Online-Stimmen klingen am besten, wenn vorhanden
  return list.find((v) => /natural|online/i.test(v.name)) || list[0] || null;
}

function speakWindows(text, lang) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'tr' ? 'tr-TR' : 'de-DE';
    const v = pickWindowsVoice(lang);
    if (v) u.voice = v;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

function playBytes(bytes, token) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const a = new Audio(url);
    playing = { audio: a };
    const end = () => { URL.revokeObjectURL(url); resolve(); };
    a.onended = end; a.onerror = end;
    if (token !== session) return end();
    a.play().catch(end);
  });
}

/**
 * Liest Markdown-Text vor. voicePref: 'auto' | 'de' | 'tr' | 'windows'.
 * Nutzt Piper (lokal, natürlich), sonst die Windows-Stimme.
 */
export async function speak(markdown, { voicePref = 'auto', speechStatus, onState } = {}) {
  stopSpeaking();
  const token = session;
  const plain = stripMarkdown(markdown);
  if (!plain) return;
  const lang = voicePref === 'de' || voicePref === 'tr' ? voicePref : detectLang(plain);
  const piperOk = voicePref !== 'windows' && speechStatus && speechStatus.piperBinary && speechStatus.voices[lang];
  const sentences = splitSentences(plain, piperOk ? 300 : 220);
  onState && onState(true);
  try {
    if (piperOk) {
      let next = window.api.speech.synthesize({ text: sentences[0], voice: lang }).catch(() => null);
      for (let i = 0; i < sentences.length; i++) {
        const cur = await next;
        if (token !== session) return;
        next = i + 1 < sentences.length
          ? window.api.speech.synthesize({ text: sentences[i + 1], voice: lang }).catch(() => null)
          : null;
        if (cur) await playBytes(cur, token);
        else await speakWindows(sentences[i], lang);
        if (token !== session) return;
      }
    } else {
      for (const s of sentences) {
        if (token !== session) return;
        await speakWindows(s, lang);
      }
    }
  } finally {
    if (token === session) { playing = null; onState && onState(false); }
  }
}
