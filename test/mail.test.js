'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mail = require('../lib/mail');
const tools = require('../lib/tools');
const sysstats = require('../lib/sysstats');
const gh = require('../lib/github');

const cfg = { user: 'me@example.de', password: 'pw', imap: 'imap.x', smtp: 'smtp.x', imapPort: 993, smtpPort: 465, from: '' };

test('Mail: Empfänger werden geprüft (keine Zeilenumbrüche, nur echte Adressen)', () => {
  assert.deepStrictEqual(mail.cleanRecipients('a@b.de, c@d.com'), ['a@b.de', 'c@d.com']);
  assert.deepStrictEqual(mail.cleanRecipients(''), []);
  assert.throws(() => mail.cleanRecipients('a@b.de\nBcc: x@y.de'), /Ungültige/);
  assert.throws(() => mail.cleanRecipients('kein-mail'), /Ungültige/);
  assert.throws(() => mail.cleanRecipients(Array.from({ length: 11 }, (_, i) => `a${i}@b.de`)), /Höchstens 10/);
});

test('Mail: Senden prüft Betreff und Text und nutzt den Transport', async () => {
  let got = null;
  const transport = { sendMail: async (m) => { got = m; return { messageId: '<1@x>' }; } };
  const r = await mail.sendMail(cfg, { an: 'a@b.de', betreff: 'Hallo\nBcc: z@z.de', text: 'Text' }, transport);
  assert.ok(r.ok);
  assert.strictEqual(got.subject, 'Hallo Bcc: z@z.de'); // Zeilenumbruch im Betreff entschärft
  assert.deepStrictEqual(got.to, ['a@b.de']); assert.strictEqual(got.from, 'me@example.de');
  await assert.rejects(mail.sendMail(cfg, { an: 'a@b.de', betreff: '', text: 'x' }, transport), /Betreff/);
  await assert.rejects(mail.sendMail(cfg, { an: 'a@b.de', betreff: 'x', text: ' ' }, transport), /leer/);
  await assert.rejects(mail.sendMail(cfg, { an: '', betreff: 'x', text: 'x' }, transport), /Empf/);
});

test('Mail: Konfiguration unvollständig wird verständlich gemeldet', () => {
  assert.throws(() => mail.configOf({}, 'pw'), /noch nicht eingerichtet/);
  assert.throws(() => mail.configOf({ mailUser: 'a@b.de', mailImapHost: 'i', mailSmtpHost: 's' }, ''), /Passwort/);
});

test('Mail-Werkzeug: Senden nur nach Ja, Ablehnung sendet nichts, Kategorie nie „immer erlauben“', async () => {
  const sent = [];
  const base = { mailSettings: { mailUser: 'me@example.de', mailImapHost: 'i', mailSmtpHost: 's' }, getMailPassword: () => 'pw', mailTransport: { sendMail: async (m) => { sent.push(m); return {}; } } };
  const args = { an: 'a@b.de', betreff: 'Test', text: 'Hallo' };
  let req = null;
  const no = await tools.runTool('mail_senden', args, { ...base, confirm: async (r) => { req = r; return false; } });
  assert.strictEqual(sent.length, 0); assert.match(no.text, /abgelehnt/);
  assert.strictEqual(req.kategorie, 'mail-senden'); assert.match(req.detail, /a@b\.de/); assert.match(req.detail, /Hallo/);
  const yes = await tools.runTool('mail_senden', args, { ...base, confirm: async () => true });
  assert.strictEqual(sent.length, 1); assert.match(yes.label, /gesendet/);
  const none = await tools.runTool('mail_senden', args, base); // ohne Bestätigungsfunktion
  assert.match(none.text, /Fehler/); assert.strictEqual(sent.length, 1);
});

test('Mail-Werkzeuge sind nur an, wenn eingeschaltet', () => {
  assert.ok(!tools.toolsFor({}).some((t) => t.function.name === 'mail_senden'));
  assert.ok(tools.toolsFor({ mailTools: true }).some((t) => t.function.name === 'mail_senden'));
});

test('Auslastung: GPU aus typeperf-Ausgabe (größte Art, Prozesse addiert)', () => {
  const csv = '"(PDH-CSV 4.0)","\\\\PC\\GPU Engine(pid_1_luid_0x0_phys_0_eng_0_engtype_3D)\\Utilization Percentage","\\\\PC\\GPU Engine(pid_2_luid_0x0_phys_0_eng_0_engtype_3D)\\Utilization Percentage","\\\\PC\\GPU Engine(pid_2_luid_0x0_phys_0_eng_1_engtype_Compute_0)\\Utilization Percentage"\r\n"11/19/2026 03:00:00.000","10.5","30","60"\r\n"Der Befehl wurde erfolgreich ausgeführt."';
  assert.strictEqual(sysstats.parseGpuEngine(csv), 60);
  assert.strictEqual(sysstats.parseGpuEngine(''), null);
  const s = new sysstats.SysStats(() => {}, 'linux').sample();
  assert.ok(s.cpu >= 0 && s.cpu <= 100 && s.ramTotal > 0 && s.gpu === null);
});

test('GitHub: Repo-Liste liest mehrere Seiten und Organisationen', async () => {
  const urls = [];
  const page = (n) => Array.from({ length: n }, (_, i) => ({ full_name: `o/r${urls.length}-${i}`, private: false }));
  const fetchImpl = async (url) => { urls.push(url); const n = urls.length === 1 ? 100 : 40; return new Response(JSON.stringify(page(n)), { status: 200 }); };
  const r = await gh.listRepos('tok', {}, fetchImpl);
  assert.strictEqual(r.length, 140); assert.strictEqual(urls.length, 2);
  assert.match(urls[0], /organization_member/); assert.match(urls[1], /page=2/);
});
