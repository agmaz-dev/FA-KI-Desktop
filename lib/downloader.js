'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Lädt eine Datei herunter (mit Fortschritt). Schreibt zuerst in eine .part-Datei.
 * onProgress({ received, total })
 */
async function downloadFile(url, dest, onProgress, signal) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow', signal, headers: { 'User-Agent': 'FA-KI-Desktop' } });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status}) von ${new URL(url).host}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const part = dest + '.part';
  const out = fs.createWriteStream(part);
  // Schreibfehler (Platte voll, Zugriff verweigert) sonst als unbehandeltes 'error' -> Absturz des Hauptprozesses
  let writeErr = null;
  out.on('error', (e) => { writeErr = e; });
  let received = 0;
  let lastTick = 0;
  let reader = null;
  try {
    reader = res.body.getReader();
    for (;;) {
      if (writeErr) throw writeErr;
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) {
        await new Promise((resolve) => {
          const fin = () => { out.off('drain', fin); out.off('error', fin); resolve(); };
          out.once('drain', fin);
          out.once('error', fin);
        });
      }
      if (writeErr) throw writeErr;
      const now = Date.now();
      if (onProgress && now - lastTick > 250) {
        lastTick = now;
        onProgress({ received, total });
      }
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
    if (writeErr) throw writeErr;
    if (total && !res.headers.get('content-encoding') && received !== total) throw new Error(`Download unvollständig (${received} von ${total} Bytes)`);
  } catch (e) {
    if (reader) reader.cancel().catch(() => {});
    out.destroy();
    try { fs.unlinkSync(part); } catch { /* egal */ }
    throw e;
  }
  fs.renameSync(part, dest);
  if (onProgress) onProgress({ received, total: total || received });
  return dest;
}

/** Sucht eine Datei (Name ohne Beachtung der Groß-/Kleinschreibung) rekursiv. */
function findFile(dir, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (wanted.includes(e.name.toLowerCase())) return p;
    }
  }
  return null;
}

module.exports = { downloadFile, findFile };
