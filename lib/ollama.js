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
  });
  if (!res.ok) throw new Error('Löschen fehlgeschlagen: ' + (await res.text()));
  return true;
}

/** Liest einen NDJSON-Stream (eine JSON-Zeile pro Block). */
async function readNdjson(res, onObj) {
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      onObj(obj);
    }
  }
  const rest = buf.trim();
  if (rest) {
    try { onObj(JSON.parse(rest)); } catch { /* ignorieren */ }
  }
}

async function streamPost(url, body, onObj, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const t = await res.text(); const j = JSON.parse(t); msg = j.error || t; } catch { /* roh */ }
    throw new Error(`Ollama: ${msg} (${res.status})`);
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

/**
 * Baut den think-Parameter passend zum Modell.
 * gpt-oss kennt nur Stufen (low/medium/high), andere Denk-Modelle true/false.
 */
function buildThink(modelName, capabilities, level) {
  const caps = capabilities || [];
  if (!caps.includes('thinking')) return undefined;
  if (/gpt-oss/i.test(modelName)) {
    return level === 'off' ? 'low' : level || 'medium';
  }
  return level !== 'off';
}

module.exports = { trimUrl, version, tags, show, deleteModel, chatStream, pullStream, readNdjson, buildThink };
