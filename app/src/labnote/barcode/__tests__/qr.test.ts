import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix, qrSvg, QR_QUIET_ZONE } from '../../port/qr';

/** RGBA pixels of a QR matrix: quiet zone QR_QUIET_ZONE, each module scale×scale px, dark = 0, light = 255, alpha 255. */
const rgba = (m: boolean[][], scale = 4) => {
  const modules = m.length + 2 * QR_QUIET_ZONE;
  const width = modules * scale;
  const height = width;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.floor(y / scale) - QR_QUIET_ZONE;
      const c = Math.floor(x / scale) - QR_QUIET_ZONE;
      const dark = r >= 0 && c >= 0 && r < m.length && c < m.length && m[r][c];
      const v = dark ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
};

describe('port/qr', () => {
  it('round-trips a page payload through jsQR', () => {
    const text = 'LN1:LN-7K3M9QX2:3:UHW010:2/3:261015:AB12';
    const { data, width, height } = rgba(qrMatrix(text));
    expect(jsQR(data, width, height)?.data).toBe(text);
  });

  it('a page payload fits version 4 (33 modules)', () => {
    expect(qrMatrix('LN1:LN-7K3M9QX2:12:UHW010:12/12:261015:AB12').length).toBeLessThanOrEqual(33);
  });

  it('the SVG is CSP-safe: no style attribute, crispEdges, escaped title', () => {
    const svg = qrSvg('LN1:LN-7K3M9QX2', '<b>&');
    expect(svg).not.toMatch(/style=/);
    expect(svg).toContain('shape-rendering="crispEdges"');
    // The vendor escapeXml writes numeric character references (&#60; for <), not named entities.
    expect(svg).toContain('<title>&#60;b&#62;&#38;</title>');
    expect(svg).not.toContain('<b>');
    const n = qrMatrix('LN1:LN-7K3M9QX2').length + 2 * QR_QUIET_ZONE;
    expect(svg).toContain(`viewBox="0 0 ${n} ${n}"`);
  });
});
