'use strict';
// E-Mail für die KI: Posteingang lesen und Mails senden (IMAP/SMTP, z. B. Gmail, iCloud, Outlook, web.de).
// Lesen darf die KI frei, SENDEN nur nach Bestätigung des Nutzers (lib/agent.js ask). Mailtexte sind nicht vertrauenswürdige Daten.

const PRESETS = {
  gmail: { imap: 'imap.gmail.com', imapPort: 993, smtp: 'smtp.gmail.com', smtpPort: 465 },
  icloud: { imap: 'imap.mail.me.com', imapPort: 993, smtp: 'smtp.mail.me.com', smtpPort: 587 },
  outlook: { imap: 'outlook.office365.com', imapPort: 993, smtp: 'smtp-mail.outlook.com', smtpPort: 587 },
  gmx: { imap: 'imap.gmx.net', imapPort: 993, smtp: 'mail.gmx.net', smtpPort: 587 },
  webde: { imap: 'imap.web.de', imapPort: 993, smtp: 'smtp.web.de', smtpPort: 587 },
};

const MAX_BODY = 6000;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

function configOf(settings, password) {
  const user = String(settings.mailUser || '').trim();
  const imap = String(settings.mailImapHost || '').trim();
  const smtp = String(settings.mailSmtpHost || '').trim();
  if (!user || !imap || !smtp) throw new Error('E-Mail ist noch nicht eingerichtet (Einstellungen → Internet und Agent → E-Mail).');
  if (!password) throw new Error('Für das E-Mail-Konto fehlt das App-Passwort.');
  return {
    user, password, imap, smtp,
    imapPort: Number(settings.mailImapPort) || 993,
    smtpPort: Number(settings.mailSmtpPort) || 465,
    from: String(settings.mailFrom || '').trim(),
  };
}

/** Prüft Empfänger: nur echte Adressen, höchstens 10, keine Zeilenumbrüche (Schutz vor Header-Einschleusung). */
function cleanRecipients(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return [];
  if (list.length > 10) throw new Error('Höchstens 10 Empfänger.');
  for (const a of list) if (!EMAIL_RE.test(a)) throw new Error('Ungültige E-Mail-Adresse: ' + a);
  return list;
}

const oneLine = (s, n = 200) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
const addr = (a) => (a && a.value ? a.value.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ') : '');

async function withImap(cfg, fn, factory) {
  const { ImapFlow } = factory ? { ImapFlow: factory } : require('imapflow');
  const client = new ImapFlow({ host: cfg.imap, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.user, pass: cfg.password }, logger: false, socketTimeout: 30000 });
  client.on('error', () => {});
  await client.connect();
  try { return await fn(client); } finally { try { await client.logout(); } catch { /* egal */ } }
}

/** Letzte Mails im Posteingang (neueste zuerst), optional gefiltert nach Absender/Betreff/Text. */
async function listMail(cfg, { limit = 10, suche = '', nurUngelesen = false } = {}, factory) {
  const n = Math.min(30, Math.max(1, parseInt(limit, 10) || 10));
  return withImap(cfg, async (c) => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      const q = {};
      if (nurUngelesen) q.seen = false;
      if (suche) q.or = [{ from: suche }, { subject: suche }, { body: suche }];
      let uids = await c.search(Object.keys(q).length ? q : { all: true }, { uid: true });
      uids = (uids || []).slice(-n).reverse();
      const out = [];
      for (const uid of uids) {
        const m = await c.fetchOne(uid, { envelope: true, flags: true }, { uid: true });
        const e = (m && m.envelope) || {};
        out.push({
          uid,
          von: (e.from || []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', '),
          betreff: oneLine(e.subject),
          datum: e.date ? new Date(e.date).toISOString().slice(0, 16).replace('T', ' ') : '',
          gelesen: !!(m && m.flags && m.flags.has && m.flags.has('\\Seen')),
        });
      }
      return out;
    } finally { lock.release(); }
  }, factory);
}

/** Eine Mail lesen (Text, ohne Anhänge). Markiert sie nicht als gelesen. */
async function readMail(cfg, uid, factory) {
  const id = parseInt(uid, 10);
  if (!Number.isFinite(id) || id < 1) throw new Error('Ungültige Mail-Nummer.');
  const { simpleParser } = require('mailparser');
  return withImap(cfg, async (c) => {
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      const m = await c.fetchOne(id, { source: true }, { uid: true });
      if (!m || !m.source) throw new Error('Mail nicht gefunden.');
      const p = await simpleParser(m.source);
      let text = p.text || (p.html ? String(p.html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ') : '');
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return {
        uid: id, von: addr(p.from), an: addr(p.to), betreff: oneLine(p.subject),
        datum: p.date ? p.date.toISOString().slice(0, 16).replace('T', ' ') : '',
        anhaenge: (p.attachments || []).map((a) => `${a.filename || 'Datei'} (${Math.round((a.size || 0) / 1024)} KB)`),
        text: text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '\n[… gekürzt]' : text,
      };
    } finally { lock.release(); }
  }, factory);
}

/** Mail senden. transport ist nur für Tests austauschbar. */
async function sendMail(cfg, { an, cc, betreff, text }, transport) {
  const to = cleanRecipients(an);
  const copy = cleanRecipients(cc);
  if (!to.length) throw new Error('Es fehlt ein Empfänger.');
  const subject = oneLine(betreff, 250);
  if (!subject) throw new Error('Es fehlt der Betreff.');
  const body = String(text || '');
  if (!body.trim()) throw new Error('Der Text ist leer.');
  const t = transport || require('nodemailer').createTransport({ host: cfg.smtp, port: cfg.smtpPort, secure: cfg.smtpPort === 465, auth: { user: cfg.user, pass: cfg.password }, connectionTimeout: 20000, socketTimeout: 30000 });
  const from = cfg.from && EMAIL_RE.test(cfg.from) ? cfg.from : cfg.user;
  const info = await t.sendMail({ from, to, cc: copy.length ? copy : undefined, subject, text: body });
  return { ok: true, id: info && info.messageId };
}

module.exports = { PRESETS, configOf, cleanRecipients, listMail, readMail, sendMail, EMAIL_RE };
