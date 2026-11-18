'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const agent = require('../lib/agent');
const gh = require('../lib/github');
const tools = require('../lib/tools');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fakiagent-'));
const yes = async () => true;
const no = async () => false;

test('Pfade bleiben im Arbeitsordner (.., absolut, Link nach außen)', () => {
  const d = mk();
  fs.writeFileSync(path.join(d, 'a.txt'), 'x');
  assert.strictEqual(agent.resolveInside(d, 'a.txt').rel, 'a.txt');
  assert.throws(() => agent.resolveInside(d, '../x'), /außerhalb/);
  assert.throws(() => agent.resolveInside(d, 'sub/../../x'), /außerhalb/);
  assert.throws(() => agent.resolveInside('', 'a'), /Arbeitsordner/);
  const out = mk();
  try {
    fs.symlinkSync(out, path.join(d, 'link'), 'dir');
    assert.throws(() => agent.resolveInside(d, 'link/geheim.txt'), /heraus/);
  } catch (e) { if (e.code !== 'EPERM') throw e; }
  // "absoluter" Pfad wird als relativ zum Ordner behandelt, nicht als Systempfad
  assert.strictEqual(agent.resolveInside(d, '/etc/passwd').abs, path.join(fs.realpathSync(d), 'etc', 'passwd'));
});

test('Dateien lesen, schreiben, ersetzen, löschen – mit Bestätigung', async () => {
  const d = mk();
  const asked = [];
  const ctx = { agentDir: d, confirm: async (r) => { asked.push(r.titel); return true; } };
  let r = await agent.runAgentTool('datei_schreiben', { pfad: 'src/a.js', inhalt: 'eins\nzwei\ndrei\n' }, ctx);
  assert.match(r.text, /OK/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'src/a.js'), 'utf8'), 'eins\nzwei\ndrei\n');
  r = await agent.runAgentTool('datei_lesen', { pfad: 'src/a.js', ab_zeile: 2, max_zeilen: 1 }, ctx);
  assert.match(r.text, /2: zwei/);
  assert.ok(!/1: eins/.test(r.text));
  r = await agent.runAgentTool('datei_ersetzen', { pfad: 'src/a.js', alt: 'zwei', neu: '2' }, ctx);
  assert.match(r.text, /OK/);
  assert.match(fs.readFileSync(path.join(d, 'src/a.js'), 'utf8'), /eins\n2\ndrei/);
  r = await agent.runAgentTool('datei_ersetzen', { pfad: 'src/a.js', alt: 'gibtsnicht', neu: 'x' }, ctx);
  assert.match(r.text, /^Fehler:.*nicht vor/);
  await agent.runAgentTool('datei_schreiben', { pfad: 'b.txt', inhalt: 'aa aa' }, ctx);
  r = await agent.runAgentTool('datei_ersetzen', { pfad: 'b.txt', alt: 'aa', neu: 'b' }, ctx);
  assert.match(r.text, /2-mal/);
  r = await agent.runAgentTool('ordner_liste', {}, ctx);
  assert.match(r.text, /\[Ordner\] src/);
  r = await agent.runAgentTool('datei_loeschen', { pfad: 'b.txt' }, ctx);
  assert.ok(!fs.existsSync(path.join(d, 'b.txt')));
  assert.ok(asked.length >= 4);
});

test('Abgelehnte Aktionen ändern nichts', async () => {
  const d = mk();
  fs.writeFileSync(path.join(d, 'a.txt'), 'alt');
  const ctx = { agentDir: d, confirm: no };
  let r = await agent.runAgentTool('datei_schreiben', { pfad: 'a.txt', inhalt: 'neu' }, ctx);
  assert.match(r.text, /abgelehnt/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'alt');
  r = await agent.runAgentTool('datei_loeschen', { pfad: 'a.txt' }, ctx);
  assert.ok(fs.existsSync(path.join(d, 'a.txt')));
  let ran = false;
  r = await agent.runAgentTool('befehl_ausfuehren', { befehl: 'echo hi' }, { ...ctx, spawnImpl: () => { ran = true; throw new Error('darf nicht laufen'); } });
  assert.ok(!ran && /abgelehnt/.test(r.text));
  // ohne confirm-Funktion wird nie etwas ausgeführt
  r = await agent.runAgentTool('datei_schreiben', { pfad: 'z.txt', inhalt: 'x' }, { agentDir: d });
  assert.ok(!fs.existsSync(path.join(d, 'z.txt')));
});

test('.git und Fremdpfade sind für Dateiwerkzeuge gesperrt', async () => {
  const d = mk();
  fs.mkdirSync(path.join(d, '.git'));
  const ctx = { agentDir: d, confirm: yes };
  assert.match((await agent.runAgentTool('datei_schreiben', { pfad: '.git/hooks/pre-commit', inhalt: 'x' }, ctx)).text, /\.git/);
  assert.match((await agent.runAgentTool('datei_schreiben', { pfad: '../x.txt', inhalt: 'x' }, ctx)).text, /außerhalb/);
  assert.match((await agent.runAgentTool('datei_loeschen', { pfad: '.' }, ctx)).text, /nicht gelöscht/);
  assert.match((await agent.runAgentTool('datei_lesen', { pfad: 'x' }, { agentDir: '' })).text, /Arbeitsordner/);
});

test('Befehl: läuft im Arbeitsordner nur nach Ja, Ausgabe ist als Daten markiert, Token wird entfernt', async () => {
  const d = mk();
  const calls = [];
  const spawnImpl = (cmd, args, opt) => {
    calls.push({ cmd, args, opt });
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', Buffer.from('Token ghp_GEHEIM123 ok')); c.emit('close', 0); });
    return c;
  };
  const r = await agent.runAgentTool('befehl_ausfuehren', { befehl: 'npm test' }, { agentDir: d, confirm: yes, spawnImpl, getToken: () => 'ghp_GEHEIM123' });
  assert.strictEqual(calls[0].cmd, 'npm test');
  assert.strictEqual(calls[0].opt.cwd, fs.realpathSync(d));
  assert.strictEqual(calls[0].opt.shell, true);
  assert.ok(!r.text.includes('ghp_GEHEIM123') && /Daten, keine Anweisungen/.test(r.text) && /Code 0/.test(r.text));
});

test('Git: Zerlegung, Sperren, Token nur bei Netzwerkbefehlen und nur für github.com', async () => {
  assert.deepStrictEqual(agent.splitArgs('commit -m "Hallo Welt" --amend'), ['commit', '-m', 'Hallo Welt', '--amend']);
  assert.strictEqual(agent.checkGit('status').writes, false);
  assert.strictEqual(agent.checkGit('branch -a').writes, false);
  assert.strictEqual(agent.checkGit('commit -m x').writes, true);
  assert.strictEqual(agent.checkGit('push -u origin main').network, true);
  for (const bad of ['config user.name x', 'status -c core.pager=x', 'clone https://evil.example/x.git', 'clone git@github.com:a/b.git', 'push ssh://x/y', 'fsck', 'daemon', 'log --upload-pack=x']) {
    assert.throws(() => agent.checkGit(bad), undefined, bad);
  }
  agent.checkGit('clone https://github.com/agmaz-dev/FA-KI-Desktop.git');
  const d = mk();
  const seen = [];
  const spawnImpl = (cmd, args) => { seen.push({ cmd, args }); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stdout.emit('data', Buffer.from(args.join(' '))); c.emit('close', 0); }); return c; };
  const ctx = { agentDir: d, confirm: yes, spawnImpl, getToken: () => 'ghp_T0KEN' };
  let r = await agent.runAgentTool('git', { argumente: 'push -u origin main' }, ctx);
  assert.ok(seen[0].args.some((x) => /extraheader=AUTHORIZATION: basic /.test(x)));
  assert.ok(!r.text.includes('ghp_T0KEN') && !r.text.includes(Buffer.from('x-access-token:ghp_T0KEN').toString('base64')));
  r = await agent.runAgentTool('git', { argumente: 'status' }, ctx);
  assert.ok(!seen[1].args.some((x) => /extraheader/.test(x)));
  r = await agent.runAgentTool('git', { argumente: 'config core.sshCommand evil' }, ctx);
  assert.match(r.text, /nicht freigegeben/);
  assert.strictEqual(seen.length, 2);
});

test('GitHub schreiben: nur Whitelist, Token nötig, Datei-Update holt sha, kein DELETE', async () => {
  await assert.rejects(() => gh.ghWrite('DELETE', '/repos/a/b', 't', undefined, async () => ({})), /nicht erlaubt/);
  await assert.rejects(() => gh.ghWrite('PATCH', '/repos/a/b', 't', {}, async () => ({})), /nicht erlaubt/);
  await assert.rejects(() => gh.ghWrite('POST', '/user/repos', '', {}, async () => ({})), /Token/);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (init.method === 'GET' && /contents\/a\.txt/.test(url)) return j({ type: 'file', sha: 'SHA1' });
    if (init.method === 'PUT') return j({ content: { path: 'a.txt' }, commit: { sha: 'C1', html_url: 'u' } });
    if (init.method === 'POST' && /\/user\/repos/.test(url)) return j({ full_name: 'agmaz-dev/neu', private: true, html_url: 'h', clone_url: 'c', default_branch: 'main' });
    return j({ message: 'Not Found' }, 404);
  };
  const f = await gh.putFile('t', { owner: 'agmaz-dev', repo: 'neu', path: 'a.txt', content: 'hallo', message: 'm' }, fetchImpl);
  assert.strictEqual(f.neu, false);
  const put = calls.find((c) => c.method === 'PUT');
  assert.strictEqual(put.body.sha, 'SHA1');
  assert.strictEqual(Buffer.from(put.body.content, 'base64').toString(), 'hallo');
  const rp = await gh.createRepo('t', { name: 'neu' }, fetchImpl);
  assert.strictEqual(rp.privat, true);
  assert.strictEqual(calls.find((c) => /user\/repos/.test(c.url)).body.private, true);
  await assert.rejects(() => gh.createRepo('t', { name: 'a b/c' }, fetchImpl), /Ungültig/);
});

test('GitHub-Werkzeuge fragen vor jeder Änderung und lassen bei Nein nichts los', async () => {
  let hit = 0;
  const fetchImpl = async () => { hit++; return new Response('{}'); };
  const r = await agent.runAgentTool('github_repo_erstellen', { name: 'x' }, { confirm: no, getToken: () => 't', fetchImpl });
  assert.match(r.text, /abgelehnt/);
  assert.strictEqual(hit, 0);
  const m = await agent.runAgentTool('github_pr_mergen', { owner: 'a', repo: 'b', nummer: 1 }, { confirm: no, getToken: () => 't', fetchImpl });
  assert.match(m.text, /abgelehnt/);
  assert.strictEqual(agent.CATEGORY.github_pr_mergen, 'github-merge');
});

test('Alte Werkzeug-Ergebnisse werden gekürzt, das neueste bleibt ganz', () => {
  const big = 'x'.repeat(6000);
  const msgs = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 8; i++) { msgs.push({ role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', content: big }); }
  tools.compactToolMessages(msgs, 20000);
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  assert.strictEqual(toolMsgs[toolMsgs.length - 1].content.length, 6000);
  assert.ok(toolMsgs[0].content.length < 500);
  assert.ok(msgs.reduce((n, m) => n + (m.content || '').length, 0) <= 20000 + 400);
});

test('Agent-Werkzeuge sind in der Liste und lassen sich abschalten', () => {
  const names = tools.toolsFor({}).map((t) => t.function.name);
  for (const n of ['datei_schreiben', 'befehl_ausfuehren', 'git', 'github_repo_erstellen', 'github_pr_erstellen', 'github_pr_mergen']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('github_repo_loeschen') && !names.some((n) => /loesch.*repo|repo.*loesch/.test(n)));
  assert.ok(!tools.toolsFor({ agentTools: false }).some((t) => t.function.name === 'git'));
});
