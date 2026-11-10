import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToTokens } from '../tokens';

describe('estimateTokens (spec §5.4)', () => {
  it('pins English: ceil(ascii / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('Hello world')).toBe(3); // 11 ascii
    expect(estimateTokens('PCR at 98C for 30 s.\n')).toBe(6); // 21 ascii
  });

  it('pins Hangul syllables at one token each', () => {
    expect(estimateTokens('안녕하세요')).toBe(5);
    expect(estimateTokens('단백질 발현')).toBe(6); // 5 syllables + ceil(1 / 4)
  });

  it('pins Hangul jamo (U+1100-11FF, U+3130-318F) at one token each', () => {
    expect(estimateTokens('ㄱㄴㄷ')).toBe(3);
    expect(estimateTokens('\u1100\u1161\u11A8')).toBe(3);
  });

  it('pins Japanese kana and CJK ideographs at one token each', () => {
    expect(estimateTokens('こんにちは')).toBe(5);
    expect(estimateTokens('カタカナ')).toBe(4);
    expect(estimateTokens('日本語')).toBe(3);
  });

  it('pins other code points at ceil(other / 3)', () => {
    expect(estimateTokens('é')).toBe(1);
    expect(estimateTokens('µµµµ')).toBe(2);
    expect(estimateTokens('😀')).toBe(1); // one code point, not two UTF-16 units
  });

  it('pins mixed text by adding the classes', () => {
    // ascii "PCR ", " 50 ng/", "L" = 12 -> 3; hangul 2; other "µ" -> 1
    expect(estimateTokens('PCR 증폭 50 ng/µL')).toBe(3 + 2 + 1);
    expect(estimateTokens('- DNA-1 ; 주형 플라스미드')).toBe(Math.ceil(11 / 4) + 7);
  });

  it('is pessimistic for Korean compared with the same length of English', () => {
    expect(estimateTokens('가'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)) * 3);
  });
});

describe('truncateToTokens', () => {
  it('returns short text unchanged', () => {
    expect(truncateToTokens('short text', 100)).toBe('short text');
  });

  it('cuts long text to at most the limit and marks the cut', () => {
    const cut = truncateToTokens('word '.repeat(2000), 100);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(100);
    expect(estimateTokens(cut)).toBeGreaterThan(90);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateToTokens('😀'.repeat(50), 5);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(5);
  });
});
