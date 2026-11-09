// Ported from app/vendor/labnoteo/src/barcode/qr.ts:1-45 sha256:69467457115b3ec4
// labnoteO 0.140.2, Apache-2.0.
// Changes: none (imports only).
/**
 * QR codes for notes and printed pages. Level Q survives a pen mark or a
 * crease over a quarter of the code; the 4-module quiet zone is part of the
 * image so a layout can never crowd it.
 */
import qrcode from 'qrcode-generator';

export const QR_QUIET_ZONE = 4;

/** Dark modules of the QR for `text`, row by row. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'Q');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** A scalable SVG of the QR, quiet zone included; size it with CSS. */
export function qrSvg(text: string, title?: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length + QR_QUIET_ZONE * 2;
  let path = '';
  matrix.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < row.length && row[c]) c++;
      path += `M${start + QR_QUIET_ZONE} ${r + QR_QUIET_ZONE}h${c - start}v1h-${c - start}z`;
    }
  });
  const label = title ? `<title>${escapeXml(title)}</title>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img">` +
    `${label}<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}
