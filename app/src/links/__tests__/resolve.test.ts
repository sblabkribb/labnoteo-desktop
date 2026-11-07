import { describe, expect, it } from 'vitest';
import { basenameKey, createResolver, hasUnlinkableChars, isSelfLinkName, labnoteFallback, splitLinktext, wikiBasename } from '../resolve';

const FILES = [
  'Home.md', 'notes/PCR 조건.md', 'notes/sub/PCR 조건.md',
  'labnote/061_a/README.labnote.md', 'labnote/062_b/README.labnote.md', 'labnote/061_a/001_prep.labnote.md',
  'images/gel.png', 'people/이서연.md', 'b.md', 'other/b.md',
];
const r = createResolver(FILES);

describe('resolve', () => {
  it('splits link text', () => {
    expect(splitLinktext('notes/PCR 조건#Step 1#Sub')).toEqual({ path: 'notes/PCR 조건', subpath: 'Step 1#Sub' });
    expect(splitLinktext('#Intro')).toEqual({ path: '', subpath: 'Intro' });
    expect(wikiBasename('labnote/061_a/README.labnote.md')).toBe('README.labnote');
  });
  it('resolves basenames case-insensitively and NFC-normalised', () => {
    expect(r.resolveWiki('home', 'x/y.md')).toBe('Home.md');
    expect(r.resolveWiki('이서연'.normalize('NFD'), 'Home.md')).toBe('people/이서연.md');
    expect(r.resolveWiki('gel.png', 'Home.md')).toBe('images/gel.png');
    expect(r.resolveWiki('missing', 'Home.md')).toBeNull();
    expect(r.resolveWiki('..\\x', 'Home.md')).toBeNull();
    expect(r.resolveWiki('a:b', 'Home.md')).toBeNull();
  });
  it('ambiguous README.labnote resolves by folder, then by depth', () => {
    expect(r.resolveWiki('README.labnote', 'labnote/062_b/002_x.labnote.md')).toBe('labnote/062_b/README.labnote.md');
    expect(r.resolveWiki('PCR 조건', 'notes/sub/n.md')).toBe('notes/sub/PCR 조건.md');
    expect(r.resolveWiki('PCR 조건', 'Home.md')).toBe('notes/PCR 조건.md');
    expect(r.resolveWiki('b', 'other/x.md')).toBe('other/b.md');
    expect(r.resolveWiki('b', 'notes/x.md')).toBe('b.md');
  });
  it('resolves path forms: absolute, relative, suffix', () => {
    expect(r.resolveWiki('labnote/061_a/README.labnote', 'x.md')).toBe('labnote/061_a/README.labnote.md');
    expect(r.resolveWiki('/labnote/061_a/README.labnote', 'x.md')).toBe('labnote/061_a/README.labnote.md');
    expect(r.resolveWiki('./001_prep.labnote', 'labnote/061_a/README.labnote.md')).toBe('labnote/061_a/001_prep.labnote.md');
    expect(r.resolveWiki('061_a/README.labnote', 'Home.md')).toBe('labnote/061_a/README.labnote.md');
  });
  it('resolves markdown hrefs', () => {
    expect(r.resolveMd('./001_prep.labnote.md#step', 'labnote/061_a/README.labnote.md')).toBe('labnote/061_a/001_prep.labnote.md');
    expect(r.resolveMd('PCR%20%EC%A1%B0%EA%B1%B4.md', 'notes/n.md')).toBe('notes/PCR 조건.md');
    expect(r.resolveMd('<../Home.md>', 'notes/n.md')).toBe('Home.md');
    expect(r.resolveMd('Home.md', 'notes/deep/n.md')).toBe('Home.md'); // basename fallback
    expect(r.resolveMd('https://x.org', 'a.md')).toBeNull();
    expect(r.resolveMd('#h', 'a.md')).toBeNull();
  });
  it('builds the shortest link text that resolves back', () => {
    expect(r.linktextFor('Home.md', 'x.md')).toBe('Home');
    expect(r.linktextFor('notes/PCR 조건.md', 'Home.md')).toBe('PCR 조건');
    expect(r.linktextFor('notes/sub/PCR 조건.md', 'Home.md')).toBe('notes/sub/PCR 조건');
    expect(r.linktextFor('labnote/061_a/README.labnote.md', 'labnote/062_b/x.md')).toBe('labnote/061_a/README.labnote');
    expect(r.linktextFor('images/gel.png', 'Home.md')).toBe('gel.png');
    expect(r.isUnknownTarget('spec.pdf')).toBe(true);
    expect(r.isUnknownTarget('gel.png')).toBe(false);
    expect(r.isUnknownTarget('2024.01.05')).toBe(false);
    expect(r.isUnknownTarget('PCR v2.1')).toBe(false);
  });
  it('linktextFor uses the rooted form when the basename is shadowed', () => {
    const s = createResolver(['Start.md', 'notes/Start.md', 'notes/x.md']);
    expect(s.resolveWiki('Start', 'notes/x.md')).toBe('notes/Start.md');
    expect(s.linktextFor('Start.md', 'notes/x.md')).toBe('/Start');
    expect(s.resolveWiki('/Start', 'notes/x.md')).toBe('Start.md');
    expect(s.linktextFor('notes/Start.md', 'notes/x.md')).toBe('Start');
  });
  it('refuses link text for names a wikilink cannot express', () => {
    const s = createResolver(['PCR #2.md', 'a.md']);
    expect(s.linktextFor('PCR #2.md', 'a.md')).toBeNull();
    expect(hasUnlinkableChars('PCR #2')).toBe(true);
    expect(hasUnlinkableChars('2024.01.05')).toBe(false);
  });
  it('defines the basename key once', () => {
    expect(basenameKey('notes/B.md')).toBe('b');
    expect(basenameKey('b.md')).toBe('b');
    expect(basenameKey('x/y.labnote.md')).toBe('y.labnote');
    expect(basenameKey('images/Gel.PNG')).toBe('gel.png');
  });
});

describe('the .labnote fallback (a deliberate departure from Obsidian)', () => {
  const s = createResolver([
    'exp/a.labnote.md', 'exp/플라스미드 미니프렙.labnote.md', 'dir/a.labnote.md', 'both.md', 'both.labnote.md',
    'PCR v2.1.labnote.md', 'other/a.labnote.md', 'gel.labnote.md', 'gel.png',
  ]);
  it('[[a]] resolves to a.labnote.md with the usual tie-break (same folder first, then depth)', () => {
    expect(s.resolveWiki('a', 'exp/x.labnote.md')).toBe('exp/a.labnote.md');
    expect(s.resolveWiki('A', 'dir/x.md')).toBe('dir/a.labnote.md');
    expect(s.resolveWiki('플라스미드 미니프렙'.normalize('NFD'), 'z.md')).toBe('exp/플라스미드 미니프렙.labnote.md');
    expect(s.resolveWiki('PCR v2.1', 'z.md')).toBe('PCR v2.1.labnote.md');
  });
  it('an exact match wins over the fallback', () => {
    expect(s.resolveWiki('both', 'z.md')).toBe('both.md');
    expect(s.resolveWiki('both.labnote', 'z.md')).toBe('both.labnote.md');
  });
  it('path forms fall back too', () => {
    expect(s.resolveWiki('dir/a', 'z.md')).toBe('dir/a.labnote.md');
    expect(s.resolveWiki('/dir/a', 'z.md')).toBe('dir/a.labnote.md');
    expect(s.resolveWiki('./a', 'other/x.md')).toBe('other/a.labnote.md');
    expect(s.resolveWiki('../dir/a', 'other/x.md')).toBe('dir/a.labnote.md');
  });
  it('[[a.labnote]] still resolves; .md, .labnote and file extensions get no fallback', () => {
    expect(s.resolveWiki('a.labnote', 'exp/x.md')).toBe('exp/a.labnote.md');
    expect(s.resolveWiki('dir/a.labnote', 'z.md')).toBe('dir/a.labnote.md');
    expect(s.resolveWiki('a.md', 'z.md')).toBeNull();
    expect(s.resolveWiki('x.labnote', 'z.md')).toBeNull();
    expect(s.resolveWiki('gel.png', 'z.md')).toBe('gel.png');
    expect(s.resolveWiki('spec.pdf', 'z.md')).toBeNull();
    expect(s.resolveWiki('missing', 'z.md')).toBeNull();
  });
  it('markdown links without an extension fall back the same way', () => {
    expect(s.resolveMd('a', 'exp/x.md')).toBe('exp/a.labnote.md');
    expect(s.resolveMd('./a#step', 'dir/x.md')).toBe('dir/a.labnote.md');
    expect(s.resolveMd('%ED%94%8C%EB%9D%BC%EC%8A%A4%EB%AF%B8%EB%93%9C%20%EB%AF%B8%EB%8B%88%ED%94%84%EB%A0%99', 'exp/x.md')).toBe(
      'exp/플라스미드 미니프렙.labnote.md',
    );
    expect(s.resolveMd('both', 'z.md')).toBe('both.md');
    expect(s.resolveMd('a.md', 'exp/x.md')).toBeNull();
  });
  it('the strict resolvers follow Obsidian only', () => {
    expect(s.resolveWikiStrict('a', 'exp/x.md')).toBeNull();
    expect(s.resolveWikiStrict('a.labnote', 'exp/x.md')).toBe('exp/a.labnote.md');
    expect(s.resolveMdStrict('a', 'exp/x.md')).toBeNull();
  });
  it('linktextFor keeps writing the Obsidian-compatible form', () => {
    expect(s.linktextFor('exp/a.labnote.md', 'exp/x.md')).toBe('a.labnote');
  });
  it('labnoteFallback and isSelfLinkName', () => {
    expect(labnoteFallback('a')).toBe('a.labnote');
    expect(labnoteFallback('dir/a')).toBe('dir/a.labnote');
    expect(labnoteFallback('a.LABNOTE')).toBeNull();
    expect(labnoteFallback('a.md')).toBeNull();
    expect(labnoteFallback('gel.png')).toBeNull();
    expect(labnoteFallback('dir/')).toBeNull();
    expect(isSelfLinkName('a', 'exp/a.labnote.md')).toBe(true);
    expect(isSelfLinkName('A.labnote', 'exp/a.labnote.md')).toBe(true);
    expect(isSelfLinkName('a', 'exp/a.md')).toBe(true);
    expect(isSelfLinkName('b', 'exp/a.labnote.md')).toBe(false);
    expect(isSelfLinkName('exp/a', 'exp/a.labnote.md')).toBe(false);
  });
});
