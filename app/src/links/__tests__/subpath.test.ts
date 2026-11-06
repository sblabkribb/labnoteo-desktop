import { describe, expect, it } from 'vitest';
import { looseHeadingKey, sanitizeHeading, subpathLine } from '../subpath';

const T = '# Intro\n## Step 1: PCR\ntext ^blk1\n## Step 1: PCR\n';

describe('subpathLine', () => {
  it('finds headings, block ids and GitHub anchors', () => {
    expect(subpathLine(T, { subpath: 'Step 1: PCR' })).toBe(1);
    expect(subpathLine(T, { subpath: 'step 1 pcr' })).toBe(1);
    expect(subpathLine(T, { subpath: 'Intro#Step 1: PCR' })).toBe(1);
    expect(subpathLine(T, { subpath: '^blk1' })).toBe(2);
    expect(subpathLine(T, { subpath: 'step-1-pcr' })).toBe(1); // slug fallback
    expect(subpathLine(T, { anchor: 'step-1-pcr-1' })).toBe(3); // GitHub duplicate numbering
    expect(subpathLine(T, { anchor: 'Step 1: PCR' })).toBe(1); // anchor falls back to heading text
    expect(subpathLine(T, { subpath: 'nope' })).toBeUndefined();
  });

  it('sanitised heading links resolve back to their heading', () => {
    const H = '# Top\n## Sample #3\n## Run #2 | 37°C\n## [재] 전기영동\n';
    expect(sanitizeHeading('Sample #3')).toBe('Sample 3');
    expect(sanitizeHeading('Run #2 | 37°C')).toBe('Run 2 37°C');
    expect(sanitizeHeading('[재] 전기영동')).toBe('재 전기영동');
    expect(subpathLine(H, { subpath: 'Sample 3' })).toBe(1);
    expect(subpathLine(H, { subpath: 'Run 2 37°C' })).toBe(2);
    expect(subpathLine(H, { subpath: '재 전기영동' })).toBe(3);
  });

  it('numbers lines as the editor does for BOM and mixed endings', () => {
    expect(subpathLine('\uFEFF# A\r\n## B\r\n', { subpath: 'B' })).toBe(1);
    expect(subpathLine('# A\r\nx\n## B\n', { subpath: 'B' })).toBe(2);
  });

  it('a mostly-CRLF mixed file does not split on a lone LF', () => {
    // eol crlf + mixed: the editor splits only on CRLF, so the lone LF stays inside line 0
    expect(subpathLine('# A\nx\r\n## B\r\n## C\r\n', { subpath: 'C' })).toBe(2);
    expect(subpathLine('# A\nx\r\n## B\r\n## C\r\n', { anchor: 'c' })).toBe(2);
  });

  it('skips headings in front matter and fences, and ignores empty subpaths', () => {
    const F = '---\ntitle: x\n---\n```\n# Fake\n```\n# Fake\n';
    expect(subpathLine(F, { subpath: 'Fake' })).toBe(6);
    expect(subpathLine(F, { subpath: '' })).toBeUndefined();
    expect(subpathLine(F, { subpath: 'Fake#' })).toBeUndefined();
    expect(subpathLine(F, {})).toBeUndefined();
  });

  it('matches coded workflow and unit operation headings by their written text', () => {
    const W = '# T\n## [WB030 Western] blot\n';
    expect(subpathLine(W, { subpath: '[WB030 Western] blot' })).toBe(1);
    expect(subpathLine(W, { subpath: sanitizeHeading('[WB030 Western] blot') })).toBe(1);
  });
});

describe('looseHeadingKey', () => {
  it('lowercases, keeps letters, digits and spaces, collapses and trims', () => {
    expect(looseHeadingKey('  Step 1:  PCR  ')).toBe('step 1 pcr');
    expect(looseHeadingKey('[재] 전기영동!')).toBe('재 전기영동');
  });
});

describe('sanitizeHeading', () => {
  it('replaces %% [[ ]] and the reserved characters', () => {
    expect(sanitizeHeading('a %%b%% [[c]] ^d: e')).toBe('a b c d e');
  });
});
