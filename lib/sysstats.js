'use strict';
// Auslastung von CPU, Arbeitsspeicher und Grafikkarte für die Balken links unten.
// CPU/RAM: direkt aus Node. GPU: Windows-Leistungsanzeige (typeperf), gleiche Quelle wie der Task-Manager.

const os = require('os');
const { execFile } = require('child_process');

function cpuTimes() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}

/** Eine CSV-Zeile mit Anführungszeichen in Felder zerlegen. */
function csvLine(line) {
  const out = [];
  const re = /"((?:[^"]|"")*)"|([^,]+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1].replace(/""/g, '"') : m[2]);
  return out;
}

/**
 * Liest die Ausgabe von typeperf für "\GPU Engine(*)\Utilization Percentage".
 * Pro Art (3D, Compute, Copy, Video …) werden alle Prozesse addiert; wie im Task-Manager zählt die größte Art.
 */
function parseGpuEngine(csv) {
  const lines = String(csv).split(/\r?\n/).filter((l) => l.startsWith('"'));
  if (lines.length < 2) return null;
  const head = csvLine(lines[0]);
  const vals = csvLine(lines[1]);
  const byType = {};
  for (let i = 1; i < head.length; i++) {
    const m = head[i].match(/engtype_([A-Za-z0-9_]+)\)/);
    const v = parseFloat(String(vals[i] || '').replace(',', '.'));
    if (!m || !Number.isFinite(v)) continue;
    byType[m[1]] = (byType[m[1]] || 0) + v;
  }
  const all = Object.values(byType);
  if (!all.length) return null;
  return Math.max(0, Math.min(100, Math.round(Math.max(...all))));
}

class SysStats {
  constructor(exec = execFile, platform = process.platform) {
    this.exec = exec;
    this.platform = platform;
    this.prev = cpuTimes();
    this.gpu = null;
    this.busy = false;
    this.last = { cpu: 0, ramUsed: 0, ramTotal: os.totalmem(), gpu: null };
  }

  /** macOS: belegt = aktiv + fest + komprimiert (wie die Aktivitätsanzeige), nicht „total - frei“. */
  pollRam() {
    if (this.platform !== 'darwin' || this.ramBusy) return;
    this.ramBusy = true;
    try {
      this.exec('vm_stat', [], { timeout: 4000 }, (err, out) => {
        this.ramBusy = false;
        if (err) return;
        const page = parseInt((/page size of (\d+) bytes/.exec(out) || [])[1], 10) || 16384;
        const n = (k) => parseInt((new RegExp(k + ':\\s+(\\d+)').exec(out) || [])[1], 10) || 0;
        const pages = n('Pages active') + n('Pages wired down') + n('Pages occupied by compressor');
        if (pages > 0) this.ramMac = pages * page;
      });
    } catch { this.ramBusy = false; }
  }

  pollGpu() {
    if (this.platform !== 'win32' || this.busy) return;
    this.busy = true;
    try {
      this.exec('typeperf', ['\\GPU Engine(*)\\Utilization Percentage', '-sc', '1'], { timeout: 8000, windowsHide: true }, (err, out) => {
        this.busy = false;
        this.gpu = err ? null : parseGpuEngine(out);
      });
    } catch { this.busy = false; this.gpu = null; }
  }

  sample() {
    const now = cpuTimes();
    const dt = now.total - this.prev.total;
    const di = now.idle - this.prev.idle;
    this.prev = now;
    const cpu = dt > 0 ? Math.round((1 - di / dt) * 100) : this.last.cpu;
    const total = os.totalmem();
    this.pollGpu();
    this.pollRam();
    this.last = { cpu: Math.max(0, Math.min(100, cpu)), ramUsed: this.ramMac || (total - os.freemem()), ramTotal: total, gpu: this.gpu };
    return this.last;
  }
}

module.exports = { SysStats, parseGpuEngine, csvLine };
