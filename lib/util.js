'use strict';

/** Erkennt grob, ob ein Text Türkisch ('tr') oder Deutsch ('de') ist. */
function detectLang(text) {
  const t = String(text || '');
  if (/[ğĞşŞıİ]/.test(t)) return 'tr';
  // Wortgrenzen per Unicode-Buchstaben: \b kennt ohne u-Flag weder „ç“ noch „ğ“.
  const words = t.match(/(?<!\p{L})(ve|bir|bu|için|ile|değil|çok|gibi|olarak|var|ama|ben|sen|biz|ne|mi|mı)(?!\p{L})/giu);
  if (words && words.length >= 4) return 'tr';
  return 'de';
}

/** Entfernt Markdown, damit der Text natürlich vorgelesen werden kann. */
function stripMarkdown(md) {
  let s = String(md || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+[.)]\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/^[-=_*]{3,}\s*$/gm, ' ');
  s = s.replace(/(\*\*|__|\*|_|~~)/g, '');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Teilt Text in kurze Sätze/Abschnitte (für das Vorlesen in Häppchen). */
function splitSentences(text, maxLen = 280) {
  const parts = String(text || '')
    .split(/(?<=[.!?…;:])\s+|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (p.length > maxLen) {
      if (cur) { out.push(cur); cur = ''; }
      // zu lange Sätze an Kommas oder Leerzeichen teilen
      let rest = p;
      while (rest.length > maxLen) {
        // cut ist der Index des letzten Zeichens im Stück -> höchstens maxLen - 1
        let cut = rest.lastIndexOf(',', maxLen - 1);
        if (cut < maxLen * 0.4) cut = rest.lastIndexOf(' ', maxLen - 1);
        if (cut < 1) cut = maxLen - 1;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
      }
      if (rest) cur = rest;
      continue;
    }
    if ((cur + ' ' + p).trim().length <= maxLen) {
      cur = (cur + ' ' + p).trim();
    } else {
      if (cur) out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Schneidet Text auf eine maximale Zeichenzahl (Anfang + Ende bleiben erhalten). */
function fitText(text, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return { text: t, truncated: false };
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return {
    text: t.slice(0, head) + '\n\n[… Mittelteil wegen der Kontextlänge gekürzt …]\n\n' + t.slice(t.length - tail),
    truncated: true,
  };
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return x.toFixed(x >= 100 ? 0 : 1).replace('.', ',') + ' ' + units[i];
}

/** Bereinigt Whisper-Ausgaben von Platzhaltern wie [BLANK_AUDIO]. */
function cleanTranscript(raw) {
  return String(raw || '')
    .replace(/\[[^\]\n]{1,40}\]/g, ' ')
    .replace(/\((?:Musik|Applaus|Stille|Gel[äa]chter|Ger[äa]usch(?:e)?|music|applause|silence|laughter|noise)\)/gi, ' ')
    .replace(/\*(?:Musik|Applaus|Stille|music)\*/gi, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { detectLang, stripMarkdown, splitSentences, fitText, formatBytes, cleanTranscript };
