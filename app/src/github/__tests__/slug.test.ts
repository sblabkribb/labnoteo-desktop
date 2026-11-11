import { describe, expect, it } from 'vitest';
import { nextFreeName, repoNameFor, romanize, slugify } from '../slug';

const TODAY = new Date(2026, 10, 10, 9, 30);
const rand = () => 'a1b2';
const slug = (s: string) => slugify(s, TODAY, rand);

describe('slugify', () => {
  it('romanizes Hangul syllable by syllable and keeps underscores', () => {
    expect(slug('001_단백질_발현')).toBe('001_danbaekjil_balhyeon');
    expect(slug('형질전환')).toBe('hyeongjiljeonhwan');
  });

  it('is approximate: no assimilation rules between syllables', () => {
    // 신라 is "silla" in Revised Romanization; syllable by syllable it is "sinra".
    expect(romanize('신라')).toBe('sinra');
    expect(romanize('값')).toBe('gap');
    expect(romanize('의사')).toBe('uisa');
  });

  it('gives the same result for NFD and NFC input', () => {
    const nfc = '001_단백질_발현';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(slug(nfd)).toBe(slug(nfc));
  });

  it('maps spaces, brackets and other symbols to a single -', () => {
    expect(slug('PCR 결과 (2차)')).toBe('pcr-gyeolgwa-2cha');
    expect(slug('a  --  b')).toBe('a-b');
    expect(slug('E. coli / pET28a')).toBe('e.-coli-pet28a');
  });

  it('trims - and . at the ends and strips a trailing .git', () => {
    expect(slug('x.git')).toBe('x');
    expect(slug('X.GIT')).toBe('x');
    expect(slug('..hidden..')).toBe('hidden');
    expect(slug('-(x)-')).toBe('x');
    expect(slug('a.git.git')).toBe('a');
  });

  it('cuts to 90 characters without a trailing separator', () => {
    const out = slug('a'.repeat(89) + '-bbbb');
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out).toBe('a'.repeat(89));
    expect(slug('가'.repeat(100))).toBe('ga'.repeat(45));
  });

  it('falls back to labnote-YYYYMMDD-xxxx when nothing is left', () => {
    expect(slug('!!! ??? ###')).toBe('labnote-20261110-a1b2');
    expect(slug('')).toBe('labnote-20261110-a1b2');
    expect(slug('...')).toBe('labnote-20261110-a1b2');
    expect(slugify('()', TODAY, () => 'ZZ!@#$9999')).toBe('labnote-20261110-zz99');
  });

  it('always gives a name GitHub accepts', () => {
    for (const s of ['001_단백질_발현', 'x.git', '😀 test', '..', 'Ünïcödé', '   ', '_', 'ㅋㅋ']) {
      const out = slug(s);
      expect(out).toMatch(/^[a-z0-9._-]{1,90}$/);
      expect(out).not.toMatch(/\.git$/);
      expect(['.', '..']).not.toContain(out);
    }
  });
});

describe('repoNameFor', () => {
  it('is the slug for the user and me-slug for an org', () => {
    expect(repoNameFor({ login: 'me', kind: 'user' }, 'me', '001_danbaekjil_balhyeon')).toBe('001_danbaekjil_balhyeon');
    expect(repoNameFor({ login: 'lab', kind: 'org' }, 'me', '001_danbaekjil_balhyeon')).toBe('me-001_danbaekjil_balhyeon');
  });

  it('caps the name at 100 characters', () => {
    const out = repoNameFor({ login: 'lab', kind: 'org' }, 'm'.repeat(39), 'a'.repeat(90));
    expect(out.length).toBe(100);
    expect(out.startsWith('m'.repeat(39) + '-')).toBe(true);
    const dotted = repoNameFor({ login: 'lab', kind: 'org' }, 'm'.repeat(10), 'a'.repeat(88) + '.b');
    expect(dotted.length).toBeLessThanOrEqual(100);
    expect(dotted).not.toMatch(/[-.]$/);
  });
});

describe('nextFreeName', () => {
  it('adds -2, -3 and stays within 100 characters', () => {
    expect(nextFreeName('exp', 1)).toBe('exp');
    expect(nextFreeName('exp', 2)).toBe('exp-2');
    expect(nextFreeName('exp', 3)).toBe('exp-3');
    const long = nextFreeName('a'.repeat(100), 12);
    expect(long).toBe('a'.repeat(97) + '-12');
    expect(nextFreeName('a'.repeat(98) + '.b', 2)).toBe('a'.repeat(98) + '-2');
  });
});
