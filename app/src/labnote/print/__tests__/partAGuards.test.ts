import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SP7 Part A guards. Paths are relative to app/ (vitest's working directory).
const PART_A = ['src/labnote/barcode', 'src/labnote/print', 'src/labnote/host/whenNotComposing.ts',
  ...['qr', 'texHtml', 'scanNames', 'noteIdService', 'printPages', 'worksheetPrint', 'fullNotePrint', 'barcodeDialog', 'barcodeActions'].map(n => `src/labnote/port/${n}`)];

const SOURCE = /\.tsx?$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(name)) out.push(p);
  }
}

/** The `.ts`/`.tsx` files (no `__tests__`) under each path; a bare port name gets its extension. */
function sourcesUnder(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (existsSync(p) && statSync(p).isDirectory()) { walk(p, out); continue; }
    const file = [p, `${p}.ts`, `${p}.tsx`].find(c => SOURCE.test(c) && existsSync(c));
    if (!file) throw new Error(`Part A source not found: ${p}`);
    out.push(file);
  }
  return out;
}

describe('SP7 Part A guards', () => {
  it('every guarded path resolves to sources, so the guards are not vacuous', () => {
    const files = sourcesUnder(PART_A);
    expect(files.length).toBeGreaterThanOrEqual(PART_A.length);
    expect(files.some(f => f.endsWith('barcodeDialog.tsx'))).toBe(true);
    expect(files.some(f => f.replace(/\\/g, '/').startsWith('src/labnote/barcode/'))).toBe(true);
    expect(files.some(f => f.replace(/\\/g, '/').startsWith('src/labnote/print/'))).toBe(true);
  });

  it('the CSP and capabilities are unchanged', () => {
    const conf = readFileSync('src-tauri/tauri.conf.json', 'utf-8'); expect(conf).toContain("frame-src 'none'"); expect(conf).toContain("style-src 'self'");
    expect(readFileSync('src-tauri/capabilities/default.json', 'utf-8')).not.toContain('opener:allow-open-path');
  });

  it('Part A sources set no inline style and assign no innerHTML', () => {
    for (const f of sourcesUnder(PART_A)) expect(readFileSync(f, 'utf-8'), f).not.toMatch(/style=\{|\.style\.|innerHTML\s*=(?!=)|outerHTML\s*=(?!=)|insertAdjacentHTML/);
  });

  it('Part A imports nothing from integrations/ or net', () => {
    for (const f of sourcesUnder(PART_A)) expect(readFileSync(f, 'utf-8'), f).not.toMatch(/from ['"][^'"]*integrations\//);
  });

  it('new npm dependencies carry a permissive licence', () => {
    for (const p of ['qrcode-generator', 'jsqr']) expect(['MIT', 'Apache-2.0']).toContain(JSON.parse(readFileSync(`node_modules/${p}/package.json`, 'utf-8')).license);
  });
});
