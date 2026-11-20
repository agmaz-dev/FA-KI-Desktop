'use strict';
// Warteschlange für Modell-Downloads: bis zu `max` laufen gleichzeitig, der Rest wartet.
// Jeder Download hat einen eigenen Abbruch (über seinen Namen).

class DownloadQueue {
  /**
   * run(name, signal) lädt ein Modell und gibt true oder { aborted: true } zurück.
   * onState({ name, state, error }) meldet: queued | running | done | cancelled | error.
   */
  constructor({ max = 3, run, onState } = {}) {
    this.max = max;
    this.run = run;
    this.onState = onState || (() => {});
    this.jobs = new Map(); // name -> { name, state, ctrl, promise, resolve, reject }
    this.waiting = []; // Namen in Reihenfolge
  }

  running() { return [...this.jobs.values()].filter((j) => j.state === 'running').length; }

  list() { return [...this.jobs.values()].map((j) => ({ name: j.name, state: j.state })); }

  /** Reiht ein. Ist derselbe Name schon dabei, kommt dessen Ergebnis zurück. */
  add(name) {
    const have = this.jobs.get(name);
    if (have) return have.promise;
    const job = { name, state: 'queued', ctrl: null };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.set(name, job);
    this.waiting.push(name);
    this.onState({ name, state: 'queued' });
    this._next();
    return job.promise;
  }

  /** Bricht einen laufenden oder wartenden Download ab. */
  cancel(name) {
    const job = this.jobs.get(name);
    if (!job) return false;
    if (job.state === 'queued') {
      this.waiting = this.waiting.filter((n) => n !== name);
      this._finish(job, 'cancelled', { aborted: true });
      return true;
    }
    if (job.ctrl) job.ctrl.abort();
    return true;
  }

  cancelAll() { for (const n of [...this.jobs.keys()]) this.cancel(n); }

  _finish(job, state, value, error) {
    job.state = state;
    this.jobs.delete(job.name);
    this.onState({ name: job.name, state, error: error ? String(error.message || error) : '' });
    if (error) job.reject(error); else job.resolve(value);
  }

  _next() {
    while (this.running() < this.max && this.waiting.length) {
      const name = this.waiting.shift();
      const job = this.jobs.get(name);
      if (!job) continue;
      job.state = 'running';
      job.ctrl = new AbortController();
      this.onState({ name, state: 'running' });
      Promise.resolve()
        .then(() => this.run(name, job.ctrl.signal))
        .then((r) => {
          if ((r && r.aborted) || job.ctrl.signal.aborted) this._finish(job, 'cancelled', { aborted: true });
          else this._finish(job, 'done', r);
        }, (e) => {
          if (job.ctrl.signal.aborted) this._finish(job, 'cancelled', { aborted: true });
          else this._finish(job, 'error', null, e);
        })
        .finally(() => this._next());
    }
  }
}

module.exports = { DownloadQueue };
