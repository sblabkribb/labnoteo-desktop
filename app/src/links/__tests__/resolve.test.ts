import { describe, expect, it } from 'vitest';
import { basenameKey, createResolver, hasUnlinkableChars, splitLinktext, wikiBasename } from '../resolve';

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
