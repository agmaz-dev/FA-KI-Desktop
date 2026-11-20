'use strict';
// Tests für 2.5.1: MCP-Verbindungen, Live-Diktat
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpManager, splitCommand, parsePairs, toolName, resultText, CATALOG } = require('../lib/mcp');
const { LiveSession } = require('../lib/voxtral');
const tools = require('../lib/tools');

test('MCP: Befehl zerlegen, Paare lesen, Werkzeugnamen', () => {
  assert.deepStrictEqual(splitCommand('npx -y "mein server" --port 3'), ['npx', '-y', 'mein server', '--port', '3']);
  assert.deepStrictEqual(splitCommand("node 'C:\\Pfad mit Leer\\s.js'"), ['node', 'C:\\Pfad mit Leer\\s.js']);
  assert.deepStrictEqual(parsePairs('API_KEY=abc\nLEER\nX = 1', '='), { API_KEY: 'abc', X: '1' });
  assert.deepStrictEqual(parsePairs('Authorization: Bearer x:y', ':'), { Authorization: 'Bearer x:y' });
  assert.strictEqual(toolName('linear', 'create-issue'), 'mcp_linear_create_issue');
  assert.ok(toolName('a', 'x'.repeat(100)).length <= 64);
  assert.strictEqual(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }], isError: true }), 'Fehler: a\n[Bild]');
  const ids = CATALOG.map((c) => c.id);
  for (const id of ['github', 'linear', 'notion', 'sentry', 'atlassian', 'cloudflare', 'gdrive']) assert.ok(ids.includes(id), id);
});

test('MCP: eigener Server – Eingaben prüfen, speichern, Geheimnisse verschlüsselt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  const m = new McpManager({ dataDir: dir, secure: { encrypt: (s) => 'X' + Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() } });
  assert.throws(() => m.addCustom({ name: '' }), /Namen/);
  assert.throws(() => m.addCustom({ name: 'a', transport: 'http', url: 'ftp://x' }), /https/);
  assert.throws(() => m.addCustom({ name: 'a', transport: 'stdio', command: '  ' }), /Befehl/);
  const id = m.addCustom({ name: 'Mein MCP', transport: 'http', url: 'https://beispiel.de/mcp', headers: 'Authorization: Bearer geheim' });
  const l = m.list();
  assert.strictEqual(l[0].id, id);
  assert.deepStrictEqual(l[0].headerKeys, ['Authorization']);
  assert.ok(!JSON.stringify(l).includes('geheim'));
  m._setAuth(id, { tokens: { access_token: 'tok123' } });
  const raw = fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8');
  assert.ok(!raw.includes('tok123'));
  assert.strictEqual(m._auth(id).tokens.access_token, 'tok123');
  const k = m.addCatalog('notion');
  assert.strictEqual(m.addCatalog('notion'), k);
  assert.throws(() => m.addCatalog('github'), /Unbekannt/); // GitHub läuft über den Token, nicht über diesen Weg
});

test('MCP: echter Server über die Kommandozeile – Werkzeuge, versteckt bis @Erwähnung, Bestätigung beim Schreiben', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  const m = new McpManager({ dataDir: dir });
  const script = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
  const id = m.addCustom({ name: 'Notizen', description: 'Test', transport: 'stdio', command: `"${process.execPath}" "${script}"`, env: 'FA_TEST_SUFFIX=!' });
  try {
    const r = await m.connect(id);
    assert.strictEqual(r.tools, 2);
    const defs = m.toolsFor('Hallo');
    assert.deepStrictEqual(defs.map((d) => d.function.name).sort(), ['mcp_notizen_echo', 'mcp_notizen_notiz_anlegen']);
    assert.ok(defs[0].function.description.startsWith('[Notizen]'));
    const e = await m.call('mcp_notizen_echo', { text: 'Hi' }, () => { throw new Error('darf nicht fragen'); });
    assert.match(e.text, /Echo: Hi!/);
    let asked = null;
    const no = await m.call('mcp_notizen_notiz_anlegen', { titel: 'X' }, async (req) => { asked = req; return false; });
    assert.ok(asked && /notiz_anlegen/.test(asked.titel));
    assert.match(no.text, /abgelehnt/);
    const yes = await m.call('mcp_notizen_notiz_anlegen', { titel: 'X' }, async () => true);
    assert.match(yes.text, /Notiz angelegt: X/);
    // versteckt: erst nach @Notizen
    m.update(id, { hidden: true });
    assert.strictEqual(m.toolsFor('Hallo').length, 0);
    assert.strictEqual(m.toolsFor('Bitte @Notizen benutzen').length, 2);
    // im Chat: zusätzliche Werkzeuge kommen an, Aufruf läuft über ctx.extra
    const list = tools.toolsFor({ webTools: false, agentTools: false }, m.toolsFor('@notizen'));
    assert.strictEqual(list.length, 2);
    const out = await tools.runTool('mcp_notizen_echo', { text: 'x' }, { extra: { has: (n) => m.has(n), run: (n, a) => m.call(n, a) } });
    assert.match(out.text, /Echo: x/);
  } finally {
    await m.closeAll();
  }
});

test('MCP: fehlerhafter Befehl wird als Fehler gemeldet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  const m = new McpManager({ dataDir: dir });
  const id = m.addCustom({ name: 'Kaputt', transport: 'stdio', command: 'gibt-es-sicher-nicht-12345' });
  await assert.rejects(m.connect(id));
  assert.strictEqual(m.list()[0].status, 'fehler');
  await m.closeAll();
});

test('GitHub-Werkzeuge nur mit gespeichertem Token (Verbindung unter MCP)', () => {
  const names = (s) => tools.toolsFor(s).map((t) => t.function.name);
  assert.ok(!names({ webTools: false, agentTools: false }).some((n) => n.startsWith('github_')));
  assert.ok(names({ webTools: false, agentTools: false, githubTokenEnc: 'enc:x' }).includes('github_lesen'));
});

/** Nachgebauter Voxtral-Live-Server */
function fakeLiveWs() {
  return class W {
    constructor() { this.sent = []; W.last = this; setImmediate(() => this._srv({ type: 'session.created', session: { audio: { input: { format: { rate: 16000 } } } } })); }
    _srv(m) { this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
    send(s) {
      const m = JSON.parse(s); this.sent.push(m);
      if (m.type === 'input_audio_buffer.append') setImmediate(() => this._srv({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i', delta: ' Wort' + this.sent.length }));
      if (m.type === 'input_audio_buffer.commit') setImmediate(() => { this._srv({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i', transcript: 'Hallo Welt' }); this.onclose && this.onclose({}); });
    }
    close() {}
  };
}

test('Live-Diktat: Audio vor dem Start wird gepuffert, Text kommt laufend, Ende liefert den ganzen Text', async () => {
  const Ws = fakeLiveWs();
  const deltas = [];
  const s = new LiveSession('ws://x', { WebSocketImpl: Ws, onDelta: (t) => deltas.push(t) });
  s.push(new Uint8Array(3200)); // vor session.created
  await new Promise((r) => setTimeout(r, 20));
  s.push(new Uint8Array(3201)); // ungerade Länge wird gekürzt
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(deltas.length >= 2);
  const text = await s.finish();
  assert.strictEqual(text, 'Hallo Welt');
  const appends = Ws.last.sent.filter((m) => m.type === 'input_audio_buffer.append');
  assert.strictEqual(appends.length, 2);
  assert.strictEqual(Buffer.from(appends[1].audio, 'base64').length, 3200);
  assert.deepStrictEqual(Ws.last.sent.at(-1), { type: 'input_audio_buffer.commit', final: true });
});

test('MCP: „Einrichten“ mit Anmeldung (OAuth wie bei Notion/Linear) – Registrierung, Anmeldefenster, Token, Werkzeuge', async () => {
  const http = require('http');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { z } = require('zod');
  const crypto = require('crypto');
  let base = '';
  const codes = new Map();
  let registered = null;
  let issued = '';
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const body = await new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b)); });
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp' || u.pathname === '/.well-known/oauth-protected-resource') return json({ resource: base + '/mcp', authorization_servers: [base] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'] });
    if (u.pathname === '/register') { registered = JSON.parse(body); return json({ ...registered, client_id: 'cid-1' }, 201); }
    if (u.pathname === '/authorize') {
      // „Nutzer meldet sich an“: sofort zurück zur App mit Code
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, u.searchParams.get('code_challenge'));
      res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body);
      const ch = codes.get(p.get('code'));
      const ok = ch && crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url') === ch;
      if (!ok) return json({ error: 'invalid_grant' }, 400);
      issued = 'at-' + crypto.randomBytes(6).toString('hex');
      return json({ access_token: issued, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt' });
    }
    if (u.pathname === '/mcp') {
      if (req.headers.authorization !== 'Bearer ' + issued || !issued) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const mcpSrv = new McpServer({ name: 'oauth-test', version: '1.0.0' });
      mcpSrv.registerTool('suche', { description: 'Sucht', inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } }, async ({ q }) => ({ content: [{ type: 'text', text: 'Treffer für ' + q }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpSrv.connect(t);
      await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  let opened = '';
  // Anmeldefenster = Link aufrufen und der Weiterleitung folgen (wie der Browser im Fenster)
  const openAuth = (url) => { opened = url; fetch(url).catch(() => {}); return () => {}; };
  const m = new McpManager({ dataDir: dir, openAuth });
  // Ein „Katalog“-Dienst, der auf den Testserver zeigt
  m.data.servers.push({ id: 'k_test', catalogId: 'test', name: 'Testdienst', transport: 'http', url: base + '/mcp', enabled: true });
  try {
    // Beim Start (ohne Nachfrage) öffnet sich kein Fenster
    await assert.rejects(m.connect('k_test', { interactive: false }), /Anmeldung/);
    assert.strictEqual(opened, '');
    const r = await m.connect('k_test');
    assert.strictEqual(r.tools, 1);
    assert.match(opened, /\/authorize\?/);
    assert.match(opened, /code_challenge_method=S256/);
    assert.deepStrictEqual(registered.redirect_uris, ['http://127.0.0.1:33418/callback']);
    const out = await m.call('mcp_testdienst_suche', { q: 'abc' });
    assert.match(out.text, /Treffer für abc/);
    // Nach Neustart: Token ist gespeichert, Verbindung ohne Fenster
    await m.closeAll();
    opened = '';
    const m2 = new McpManager({ dataDir: dir, openAuth });
    m2.data.servers = m.data.servers;
    await m2.connect('k_test', { interactive: false });
    assert.strictEqual(opened, '');
    await m2.closeAll();
  } finally {
    await m.closeAll();
    srv.close();
  }
});
