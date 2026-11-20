'use strict';
// CI: echtes Chatten über die eingebaute Engine (lib/engine.js) mit einem kleinen Modell.
// Aufruf: node scripts/chat-probe.js <llama-server> <modell.gguf>
const { Engine } = require('../lib/engine');

const path = require('path');
const [exe, model] = process.argv.slice(2).map((p) => path.resolve(p));
const e = new Engine({ exePath: exe, getSettings: () => ({ keepAlive: '5m' }), resolveModel: () => ({ file: model }), onStatus: (t) => t && console.log('Status:', t) });

(async () => {
  const t0 = Date.now();
  let out = '';
  await e.chatStream({ model: 'probe', messages: [{ role: 'user', content: 'Antworte nur mit: Hallo Welt' }], options: { num_ctx: 4096 } },
    (o) => { if (o.message && o.message.content) out += o.message.content; });
  console.log(`Antwort nach ${Date.now() - t0} ms:`, JSON.stringify(out.slice(0, 120)));
  await e.stop();
  if (!out.trim()) throw new Error('leere Antwort');
  console.log('CHAT OK');
})().catch((err) => { console.error('CHAT FEHLER:', err.message); process.exit(1); });
