'use strict';
// Merkt sich die Prozessnummern der selbst gestarteten Engines (llama-server).
// Ist die App einmal abgestürzt oder hart beendet worden, laufen diese weiter und belegen Speicher:
// beim nächsten Start werden sie beendet – aber nur, wenn unter der Nummer wirklich noch llama-server läuft.

const fs = require('fs');
const { execFile } = require('child_process');

class Orphans {
  constructor(file) { this.file = file; this.pids = new Set(); }

  add(pid) { this.pids.add(pid); this._save(); }

  _save() { try { fs.writeFileSync(this.file, JSON.stringify([...this.pids])); } catch { /* egal */ } }

  /** Prozessname zu einer Nummer (leer, wenn keiner läuft). */
  static name(pid) {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => resolve(err ? '' : String(out)));
      } else {
        execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, out) => resolve(err ? '' : String(out)));
      }
    });
  }

  /** Reste vom letzten Lauf beenden. Gibt die Anzahl beendeter Prozesse zurück. */
  async cleanup() {
    let old = [];
    try { old = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* keine Datei */ }
    let n = 0;
    for (const pid of Array.isArray(old) ? old : []) {
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      if (!/llama-server/i.test(await Orphans.name(pid))) continue;
      try { process.kill(pid); n++; } catch { /* schon weg */ }
    }
    this._save();
    return n;
  }

  /** Beim normalen Ende: Liste leeren. */
  clear() { this.pids.clear(); try { fs.rmSync(this.file, { force: true }); } catch { /* egal */ } }
}

module.exports = { Orphans };
