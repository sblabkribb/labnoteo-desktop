// @vitest-environment jsdom
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { moveUnitOp, swapUnitOp, unitOpBlocks } from '../uoOrder';

const NOTE = [
  '---',
  'title: WB010 Oligo',
  'last_updated_date: 2026-01-01',
  '---',
  '',
  '## [WB010 DNA Oligomer Assembly] x',
  '',
  '## 🗂️ Related Unit Operations',
  '',
  '- [UHW010 Mixing | 첫째](#uhw010-mixing-첫째)',
  '- [USW020 Design | 둘째](#usw020-design-둘째)',
  '- [UHW030 PCR](#uhw030-pcr)',
  '',
  '---',
  '',
  '### [UHW010 Mixing] 첫째',
  '',
  '첫째 본문',
  '```',
  '### [UHW999 Fake] 울타리 안',
  '```',
  '',
  '---',
  '',
  '### [USW020 Design] 둘째',
  '',
  '둘째 본문',
  '',
  '---',
  '',
  '### [UHW030 PCR]',
  '',
  '셋째 본문',
  '',
  '## Conclusions',
  '',
  '끝',
  '',
].join('\n');

const headings = (md: string) => md.split('\n').filter((l) => l.startsWith('### [') && !l.includes('Fake'));
const toc = (md: string) => md.split('\n').filter((l) => /^- \[U/.test(l));

describe('swapUnitOp', () => {
  it('finds blocks and ignores headings inside code fences', () => {
    expect(unitOpBlocks(NOTE).map((b) => b.heading)).toEqual(['[UHW010 Mixing] 첫째', '[USW020 Design] 둘째', '[UHW030 PCR]']);
  });

  it('moves a block down: body, TOC and separators follow; the text after the last block stays', () => {
    const line = NOTE.split('\n').indexOf('### [UHW010 Mixing] 첫째');
    const r = swapUnitOp(NOTE, line, 'down');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(headings(r.text)).toEqual(['### [USW020 Design] 둘째', '### [UHW010 Mixing] 첫째', '### [UHW030 PCR]']);
    expect(toc(r.text)).toEqual(['- [USW020 Design | 둘째](#usw020-design-둘째)', '- [UHW010 Mixing | 첫째](#uhw010-mixing-첫째)', '- [UHW030 PCR](#uhw030-pcr)']);
    expect(r.text.split('\n')[r.line]).toBe('### [UHW010 Mixing] 첫째');
    expect(r.text).toContain('### [UHW999 Fake] 울타리 안');
    // 구분선: UO 마다 하나씩 앞에, 남는 것 없이
    const lines = r.text.split('\n');
    for (const h of headings(r.text)) expect(lines[lines.indexOf(h) - 2]).toBe('---');
    expect(r.text.match(/^---$/gm)!.length).toBe(NOTE.match(/^---$/gm)!.length);
    expect(r.text.endsWith('## Conclusions\n\n끝\n')).toBe(true);
    expect(r.text.length).toBe(NOTE.length);
  });

  it('moves the last block up and keeps the blank line before the next section', () => {
    const line = NOTE.split('\n').indexOf('### [UHW030 PCR]');
    const r = swapUnitOp(NOTE, line, 'up');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(headings(r.text)).toEqual(['### [UHW010 Mixing] 첫째', '### [UHW030 PCR]', '### [USW020 Design] 둘째']);
    expect(r.text).toContain('둘째 본문\n\n## Conclusions');
  });

  it('the first cannot move up; identical headings are refused', () => {
    const line = NOTE.split('\n').indexOf('### [UHW010 Mixing] 첫째');
    expect(swapUnitOp(NOTE, line, 'up')).toEqual({ ok: false, reason: 'none' });
    const dup = NOTE.replace('### [USW020 Design] 둘째', '### [UHW010 Mixing] 첫째');
    expect(swapUnitOp(dup, line, 'down')).toMatchObject({ ok: false, reason: 'duplicate' });
  });
});

describe('moveUnitOp', () => {
  let h: TestHost;
  beforeEach(() => setLang('ko'));
  afterEach(() => h?.cleanup());

  it('writes the swapped note with CRLF kept and stamps the date', async () => {
    const path = 'labnote/001_x/002_WB010_Oligo.labnote.md';
    h = createTestHost({ [path]: NOTE.replace(/\n/g, '\r\n') });
    const line = NOTE.split('\n').indexOf('### [USW020 Design] 둘째');
    const at = await moveUnitOp(h.ctx, path, line, 'up');
    const text = h.vault.files()[path];
    expect(text).not.toMatch(/[^\r]\n/);
    expect(headings(text.replace(/\r/g, ''))).toEqual(['### [USW020 Design] 둘째', '### [UHW010 Mixing] 첫째', '### [UHW030 PCR]']);
    expect(text.split('\r\n')[at!]).toBe('### [USW020 Design] 둘째');
    expect(text).not.toContain('last_updated_date: 2026-01-01');
  });
});
