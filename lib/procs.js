'use strict';
// Startet lokale Hintergrundprogramme (Stimmen-Server) und beendet sie wieder.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

async function reachable(url, ms = 2500) {
  try {
    const r = await fetch(String(url).replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(ms) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** Pfad der .exe zu einer Prozess-ID (Windows), sonst ''. */
function processPath(pid) {
  return new Promise((resolve) => {
    const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ExecutablePath`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (e, so) => resolve(e ? '' : String(so || '').trim()));
  });
}

class Procs {
  constructor() {
    this.children = new Map();
  }

  _spawn(key, cmd, args, opts) {
    const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', ...opts });
    child.on('error', (e) => { child.spawnError = e; this.children.delete(key); });
    child.on('exit', () => this.children.delete(key));
    this.children.set(key, child);
    return child;
  }

  /** Startet den lokalen Stimmen-Server (Ordner + Startbefehl aus den Einstellungen). */
  async ensureTtsServer(cfg) {
    const url = cfg.ttsServerUrl || 'http://127.0.0.1:8004';
    if (await reachable(url)) return { ok: true, started: false };
    const dir = String(cfg.ttsServerDir || '').trim();
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Der Ordner des Stimmen-Servers ist nicht eingetragen oder fehlt.' };
    const cmd = String(cfg.ttsServerCmd || 'python server.py').trim();
    try {
      this._spawn('tts', cmd, [], { cwd: dir, shell: true });
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    // Das Laden des Modells dauert, deshalb großzügig warten.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!this.children.has('tts')) return { ok: false, error: 'Der Stimmen-Server hat sich sofort beendet. Prüfe Ordner und Startbefehl.' };
      if (await reachable(url)) return { ok: true, started: true };
    }
    return { ok: false, error: 'Der Stimmen-Server antwortet nicht (Zeitüberschreitung).' };
  }

  /** Beendet ein von uns gestartetes Programm (z. B. den Stimmen-Server) und wartet kurz. */
  async stop(key) {
    const child = this.children.get(key);
    if (!child) return false;
    try {
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill();
    } catch { /* egal */ }
    this.children.delete(key);
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  }

  /**
   * Beendet Programme, die auf dem Port der Adresse lauschen – aber nur, wenn ihre .exe in ownDir liegt
   * (unser eigener Stimmen-Server: portables Python/llama-server in den App-Daten). Fremde Programme bleiben.
   */
  async freePort(url, ownDir) {
    let port;
    try { port = Number(new URL(url).port) || 80; } catch { return false; }
    if (process.platform !== 'win32') return false;
    const out = await new Promise((resolve) => {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, so) => resolve(String(so || '')));
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+:0\s+\S+\s+(\d+)$/i); // lauschend: Gegenstelle :0 (Zustandswort ist sprachabhängig)
      if (m && Number(m[1]) === port && Number(m[2]) > 4) pids.add(m[2]);
    }
    if (!ownDir) return false;
    const own = path.resolve(ownDir).toLowerCase() + path.sep;
    let killed = 0;
    for (const pid of pids) {
      const exe = await processPath(pid);
      if (!exe || !path.resolve(exe).toLowerCase().startsWith(own)) continue;
      await new Promise((r) => execFile('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true }, () => r()));
      killed++;
    }
    if (killed) await new Promise((r) => setTimeout(r, 2500));
    return killed > 0;
  }

  killAll() {
    for (const [key, child] of this.children) {
      // Nur selbst gestartete Programme beenden, nie ein schon vorher laufendes Programm.
      try {
        if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill();
      } catch { /* egal */ }
      this.children.delete(key);
    }
  }
}

module.exports = { Procs, reachable };
