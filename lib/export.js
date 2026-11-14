'use strict';
// Export von Texten als PDF (über Electron) und Word (.docx, selbst gebaut aus Markdown).
const AdmZip = require('adm-zip');
const { marked } = require('marked');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML-Tags im Markdown werden als Text behandelt, nie ausgeführt. */
function lex(md) {
  const toks = marked.lexer(String(md || ''), { gfm: true, breaks: false });
  const fix = (arr) => {
    for (const t of arr) {
      if (t.type === 'html') { t.type = 'text'; t.escaped = true; t.text = esc(t.raw); delete t.tokens; }
      if (t.tokens) fix(t.tokens);
      if (t.items) for (const it of t.items) fix(it.tokens || []);
      if (t.type === 'table') {
        for (const h of t.header) fix(h.tokens || []);
        for (const r of t.rows) for (const c of r) fix(c.tokens || []);
      }
    }
  };
  fix(toks);
  return toks;
}

function mdToHtml(md, title) {
  const toks = lex(md);
  toks.links = {};
  const body = marked.parser(toks);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title || 'Dokument')}</title>
<style>
 @page { size: A4; margin: 22mm 20mm; }
 body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.55; color: #111; }
 h1,h2,h3,h4 { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.25; margin: 1.2em 0 .4em; }
 h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4 { font-size: 11.5pt; }
 p { margin: .5em 0; } ul, ol { margin: .4em 0 .4em 1.3em; padding: 0; }
 code { font-family: Consolas, monospace; font-size: 10pt; background: #f2f2f2; padding: 0 3px; border-radius: 3px; }
 pre { background: #f5f5f5; padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
 pre code { background: none; padding: 0; }
 blockquote { margin: .6em 0; padding-left: 12px; border-left: 3px solid #bbb; color: #444; }
 table { border-collapse: collapse; margin: .6em 0; } th, td { border: 1px solid #999; padding: 4px 8px; }
 th { background: #eee; } hr { border: 0; border-top: 1px solid #bbb; margin: 1em 0; } a { color: #1a55b0; }
</style></head><body>${body}</body></html>`;
}

async function renderPdf(BrowserWindow, md, title) {
  const html = mdToHtml(md, title);
  const w = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await w.webContents.printToPDF({ pageSize: 'A4', printBackground: false, preferCSSPageSize: true });
  } finally {
    w.destroy();
  }
}

// ---------------- DOCX ----------------
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function run(text, st) {
  if (text === '') return '';
  let pr = '';
  if (st.b) pr += '<w:b/>';
  if (st.i) pr += '<w:i/>';
  if (st.s) pr += '<w:strike/>';
  if (st.code) pr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>';
  const parts = String(text).split('\n');
  return parts.map((p, i) => `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(p)}</w:t></w:r>`).join('');
}

function inline(tokens, st = {}) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'strong': out += inline(t.tokens, { ...st, b: true }); break;
      case 'em': out += inline(t.tokens, { ...st, i: true }); break;
      case 'del': out += inline(t.tokens, { ...st, s: true }); break;
      case 'codespan': out += run(t.text, { ...st, code: true }); break;
      case 'link': out += inline(t.tokens && t.tokens.length ? t.tokens : [{ type: 'text', text: t.text }], st) + run(` (${t.href})`, st); break;
      case 'br': out += '<w:r><w:br/></w:r>'; break;
      case 'image': out += run(t.text || '', st); break;
      case 'escape': out += run(t.text, st); break;
      default:
        if (t.tokens && t.tokens.length) out += inline(t.tokens, st);
        else out += run(decode(t.text != null ? t.text : t.raw || ''), st);
    }
  }
  return out;
}

function decode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function para(inner, { style, ind, extra } = {}) {
  const pPr = (style ? `<w:pStyle w:val="${style}"/>` : '') + (extra || '') + (ind ? `<w:ind w:left="${ind}"/>` : '');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
}

function blocks(tokens, depth = 0) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'heading': out += para(inline(t.tokens), { style: 'Heading' + Math.min(4, t.depth) }); break;
      case 'paragraph': out += para(inline(t.tokens), { ind: depth * 360 || 0 }); break;
      case 'text': out += para(t.tokens ? inline(t.tokens) : run(decode(t.text), {}), { ind: depth * 360 || 0 }); break;
      case 'code':
        for (const line of String(t.text).split('\n')) {
          out += para(run(line, { code: true }), { style: 'Code', extra: '<w:spacing w:after="0"/>' });
        }
        out += para('');
        break;
      case 'blockquote': out += blocks(t.tokens, depth + 1).replace(/<w:r>/g, '<w:r><w:rPr><w:i/></w:rPr>').replace(/<w:rPr><w:i\/><\/w:rPr><w:rPr>/g, '<w:rPr><w:i/>'); break;
      case 'hr': out += para('', { extra: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>' }); break;
      case 'list': {
        let n = Number(t.start) || 1;
        for (const it of t.items) {
          const mark = t.ordered ? `${n++}. ` : '• ';
          const kids = it.tokens || [];
          let first = true;
          for (const k of kids) {
            if (k.type === 'list') { out += blocks([k], depth + 1); continue; }
            const inner = k.type === 'text' || k.type === 'paragraph' ? inline(k.tokens || [{ type: 'text', text: k.text }]) : '';
            if (!inner) { out += blocks([k], depth + 1); continue; }
            out += para((first ? run(mark, {}) : '') + inner, { ind: 360 * (depth + 1), extra: '<w:spacing w:after="40"/>' });
            first = false;
          }
        }
        break;
      }
      case 'table': {
        const cell = (c, head) => `<w:tc><w:tcPr><w:tcBorders>${['top', 'left', 'bottom', 'right'].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`).join('')}</w:tcBorders>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : ''}</w:tcPr>${para(inline(c.tokens, head ? { b: true } : {}))}</w:tc>`;
        out += '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>';
        out += `<w:tr>${t.header.map((c) => cell(c, true)).join('')}</w:tr>`;
        for (const r of t.rows) out += `<w:tr>${r.map((c) => cell(c, false)).join('')}</w:tr>`;
        out += '</w:tbl>' + para('');
        break;
      }
      case 'space': break;
      default:
        if (t.raw && String(t.raw).trim()) out += para(run(decode(t.text || t.raw), {}));
    }
  }
  return out;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="23"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${[['Heading1', 40, 360], ['Heading2', 32, 280], ['Heading3', 27, 240], ['Heading4', 24, 200]].map(([id, sz, before]) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="heading ${id.slice(-1)}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="100"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`).join('')}
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:ind w:left="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`;

function buildDocx(md, title) {
  const body = blocks(lex(md));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(doc));
  zip.addFile('word/styles.xml', Buffer.from(STYLES));
  zip.addFile('docProps/core.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title || 'Dokument')}</dc:title><dc:creator>FA KI Desktop</dc:creator></cp:coreProperties>`));
  return zip.toBuffer();
}

module.exports = { mdToHtml, renderPdf, buildDocx };
