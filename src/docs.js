import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
// Der PDF-Worker wird direkt mit eingebunden (läuft im selben Thread, braucht keine extra Datei).
import 'pdfjs-dist/build/pdf.worker.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.js';

const toU8 = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** Liest den Text aus einem PDF. Seiten ohne Text (Scans) werden per OCR (Deutsch+Türkisch) gelesen. */
export async function readPdf(data, onStatus) {
  const doc = await pdfjs.getDocument({ data: toU8(data).slice(), isEvalSupported: false }).promise;
  const pages = [];
  let ocrPages = 0;
  const maxPages = Math.min(doc.numPages, 80);
  for (let i = 1; i <= maxPages; i++) {
    onStatus && onStatus(`PDF wird gelesen: Seite ${i} von ${maxPages}`);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    for (const it of tc.items) {
      if (typeof it.str === 'string') text += it.str + (it.hasEOL ? '\n' : ' ');
    }
    text = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    if (text.replace(/\s/g, '').length < 40) {
      onStatus && onStatus(`Seite ${i} ist ein Scan – Texterkennung (OCR) läuft …`);
      try {
        const viewport = page.getViewport({ scale: 2.2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const ocr = await window.api.ocr.run({ image: await blob.arrayBuffer() });
        if (ocr && ocr.trim()) { text = ocr.trim(); ocrPages++; }
      } catch (e) {
        text = text || `[Seite ${i}: OCR fehlgeschlagen – ${e.message || e}]`;
      }
    }
    pages.push(`--- Seite ${i} ---\n${text}`);
    page.cleanup();
  }
  await doc.destroy();
  return {
    text: pages.join('\n\n'),
    pageCount: doc.numPages,
    readPages: maxPages,
    ocrPages,
  };
}

/** Skaliert ein Bild herunter und gibt PNG-/JPEG-Bytes zurück (für Vorschau/OCR/Modell). */
export async function prepareImage(data, maxSide = 1600) {
  const blob = new Blob([toU8(data)]);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  const buf = await out.arrayBuffer();
  let bin = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { base64: btoa(bin), jpeg: buf };
}

export const isPdf = (name) => /\.pdf$/i.test(name);
export const isImage = (name) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(name);
