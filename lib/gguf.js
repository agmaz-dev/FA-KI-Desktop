'use strict';
// Liest die Kopfdaten (Schlüssel/Werte) einer GGUF-Datei, ohne die Gewichte zu laden.
// Gebraucht für: Hat das Modell eingebaute MTP-Köpfe (schnelleres Antworten durch Vorausraten)?

const fs = require('fs');

const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 };
const FIXED = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class Reader {
  constructor(fd) { this.fd = fd; this.buf = Buffer.alloc(0); this.pos = 0; this.filePos = 0; }
  _need(n) {
    if (this.buf.length - this.pos >= n) return;
    const rest = this.buf.subarray(this.pos);
    const chunk = Buffer.alloc(Math.max(n, 1 << 20));
    const got = fs.readSync(this.fd, chunk, 0, chunk.length, this.filePos);
    this.filePos += got;
    this.buf = Buffer.concat([rest, chunk.subarray(0, got)]);
    this.pos = 0;
    if (this.buf.length < n) throw new Error('GGUF-Datei zu kurz');
  }
  skip(n) {
    while (n > 0) {
      const have = this.buf.length - this.pos;
      if (have >= n) { this.pos += n; return; }
      n -= have; this.pos = this.buf.length;
      // Große Blöcke direkt überspringen
      if (n > (1 << 20)) { this.filePos += n; n = 0; this.buf = Buffer.alloc(0); this.pos = 0; return; }
      this._need(Math.min(n, 1 << 20));
    }
  }
  u32() { this._need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() { this._need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v); }
  str() { const n = this.u64(); if (n > 1 << 24) throw new Error('GGUF: ungültige Länge'); this._need(n); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; }
  value(type) {
    if (type === T.STRING) return this.str();
    if (type === T.ARRAY) {
      const it = this.u32(); const n = this.u64();
      if (FIXED[it] != null) { this.skip(FIXED[it] * n); return null; } // Zahlenlisten brauchen wir nicht
      if (it === T.STRING) { for (let i = 0; i < n; i++) this.skip(this.u64()); return null; }
      for (let i = 0; i < n; i++) this.value(it);
      return null;
    }
    const size = FIXED[type];
    if (size == null) throw new Error('GGUF: unbekannter Typ ' + type);
    this._need(size);
    const b = this.buf; const p = this.pos; this.pos += size;
    switch (type) {
      case T.U8: return b.readUInt8(p); case T.I8: return b.readInt8(p);
      case T.U16: return b.readUInt16LE(p); case T.I16: return b.readInt16LE(p);
      case T.U32: return b.readUInt32LE(p); case T.I32: return b.readInt32LE(p);
      case T.F32: return b.readFloatLE(p); case T.BOOL: return b.readUInt8(p) !== 0;
      case T.U64: return Number(b.readBigUInt64LE(p)); case T.I64: return Number(b.readBigInt64LE(p));
      default: return b.readDoubleLE(p);
    }
  }
}

/** Kopfdaten als Objekt (Listen wie das Vokabular werden ausgelassen). Wirft bei Nicht-GGUF. */
function readMeta(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const r = new Reader(fd);
    r._need(4);
    if (r.buf.toString('latin1', 0, 4) !== 'GGUF') throw new Error('keine GGUF-Datei');
    r.pos = 4;
    const version = r.u32();
    if (version < 2) throw new Error('GGUF-Version zu alt');
    r.u64(); // Anzahl Tensoren
    const kvs = r.u64();
    const meta = {};
    for (let i = 0; i < kvs; i++) {
      const key = r.str();
      const v = r.value(r.u32());
      if (v !== null) meta[key] = v;
    }
    return meta;
  } finally { fs.closeSync(fd); }
}

/** Anzahl eingebauter MTP-Schichten (0 = keine). */
function mtpLayers(file) {
  try {
    const m = readMeta(file);
    for (const [k, v] of Object.entries(m)) if (/\.nextn_predict_layers$/.test(k) && Number(v) > 0) return Number(v);
  } catch { /* nicht lesbar -> kein MTP */ }
  return 0;
}

module.exports = { readMeta, mtpLayers };
