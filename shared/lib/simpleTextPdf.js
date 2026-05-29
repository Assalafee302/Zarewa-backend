/**
 * Minimal PDF 1.4 builder (Helvetica, one page per document chunk).
 * @param {{ lines?: string[] }[]} pages
 * @returns {Uint8Array}
 */
export function buildSimpleTextPdf(pages) {
  const safePages = (pages || []).length
    ? pages
    : [{ lines: ['(empty document)'] }];

  const esc = (s) =>
    String(s ?? '')
      .slice(0, 240)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7E\n\r\t]/g, '?');

  const pageStreams = safePages.map((page) => {
    const lines = Array.isArray(page.lines) ? page.lines : [];
    let stream = 'BT\n/F1 10 Tf\n14 TL\n';
    let first = true;
    for (const line of lines) {
      const chunk = esc(line);
      if (first) {
        stream += `50 800 Td\n(${chunk}) Tj\n`;
        first = false;
      } else {
        stream += `T*\n(${chunk}) Tj\n`;
      }
    }
    stream += '\nET';
    return stream;
  });

  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentIds = pageStreams.map((stream) => {
    const len = Buffer.byteLength(stream, 'utf8');
    return addObj(`<< /Length ${len} >>\nstream\n${stream}\nendstream`);
  });
  const pageIds = contentIds.map((contentId) => {
    return addObj(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
  });

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pagesId = addObj(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
  for (let i = 0; i < pageIds.length; i += 1) {
    objects[pageIds[i] - 1] = objects[pageIds[i] - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  }
  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'utf8'));
}
