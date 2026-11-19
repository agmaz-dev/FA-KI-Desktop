'use strict';

function trimUrl(u) {
  return String(u || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

async function jsonFetch(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || text || res.statusText;
      throw new Error(`Ollama: ${msg} (${res.status})`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function version(base) {
  const d = await jsonFetch(trimUrl(base) + '/api/version');
  return d && d.version;
}

async function tags(base) {
  const d = await jsonFetch(trimUrl(base) + '/api/tags');
  return (d && d.models) || [];
}

async function show(base, name) {
  return jsonFetch(trimUrl(base) + '/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name }),
  }, 15000);
}

async function deleteModel(base, name) {
  const res = await fetch(trimUrl(base) + '/api/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Löschen fehlgeschlagen: ' + (await res.text()));
  return true;
}

/**
 * Liest einen NDJSON-Stream (eine JSON-Zeile pro Block).
 * Akzeptiert eine fetch-Response (Web-Stream) oder einen Node-Stream (http.IncomingMessage).
 * Der Stream wird immer geschlossen – auch wenn onObj einen Fehler wirft –, damit Ollama nicht weiterrechnet.
 */
async function readNdjson(src, onObj) {
  const dec = new TextDecoder('utf-8');
  let buf = '';
  const feed = (text) => {
    buf += text;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      onObj(obj);
    }
  };
  if (src && src.body && typeof src.body.getReader === 'function') {
    const reader = src.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(dec.decode(value, { stream: true }));
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } else {
    try {
      for await (const chunk of src) feed(dec.decode(chunk, { stream: true }));
    } finally {
      if (typeof src.destroy === 'function') src.destroy();
    }
  }
  const rest = (buf + dec.decode()).trim(); // Decoder leeren (letztes Mehrbyte-Zeichen)
  if (rest) {
    let obj = null;
    try { obj = JSON.parse(rest); } catch { /* ignorieren */ }
    if (obj) onObj(obj);
  }
}

/**
 * POST über Node-http statt fetch: fetch (undici) bricht nach 300 s ohne Antwort-Header ab.
 * Ollama schickt die Header aber erst nach dem Laden des Modells und dem Lesen des Prompts –
 * bei großen Modellen oder langen PDFs auf dem Prozessor kann das länger dauern.
 * Node-http hat standardmäßig keine solche Zeitgrenze; Abbruch geht über das AbortSignal.
 */
function httpPost(url, body, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      signal,
    }, resolve);
    req.on('error', reject);
    req.end(data);
  });
}

async function readAll(res) {
  const parts = [];
  for await (const c of res) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

async function streamPost(url, body, onObj, signal) {
  const res = await httpPost(url, body, signal);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let msg = res.statusMessage || 'Fehler';
    try { const t = await readAll(res); msg = t || msg; const j = JSON.parse(t); msg = j.error || t; } catch { /* roh */ }
    throw new Error(`Ollama: ${msg} (${res.statusCode})`);
  }
  await readNdjson(res, (o) => {
    if (o.error) throw new Error('Ollama: ' + o.error);
    onObj(o);
  });
}

function chatStream(base, body, onObj, signal) {
  return streamPost(trimUrl(base) + '/api/chat', { ...body, stream: true }, onObj, signal);
}

function pullStream(base, name, onObj, signal) {
  return streamPost(trimUrl(base) + '/api/pull', { model: name, stream: true }, onObj, signal);
}

const { buildThink } = require('./think');

module.exports = { trimUrl, version, tags, show, deleteModel, chatStream, pullStream, readNdjson, buildThink };
