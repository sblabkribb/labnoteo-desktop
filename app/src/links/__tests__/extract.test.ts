import { describe, expect, it } from 'vitest';
import { extractLinks, extractMeta, hasLinkSyntax } from '../extract';

const TEXT = [
  '---',
  'retry_of: "[[labnote/061_a/README.labnote|061]]"',
  'author: [[이서연]]',
  '---',
  'See [[Home]] and [[notes/PCR 조건#Step 1|PCR]].',
  '| a | [[Home\\|h]] |',
  '|---|---|',
  '`[[NotALink]]`',
  '<!-- [[Hidden]] -->',
  '![[gel.png|200]] ![[Home]]',
  '[prep](./001_prep.labnote.md#step) [ext](https://x.org) [anchor](#h) ![g](<images/gel.png>)',
  '```',
  '[[InFence]]',
  '```',
  '',
].join('\n');

describe('extractLinks', () => {
  it('extracts every link form outside code and comments', () => {
    const ls = extractLinks(TEXT);
    expect(ls.map((l) => [l.kind, l.target, l.alias ?? null, l.line, l.inFrontmatter])).toEqual([
      ['wiki', 'labnote/061_a/README.labnote', '061', 1, true],
      ['wiki', '이서연', null, 2, true],
      ['wiki', 'Home', null, 4, false],
      ['wiki', 'notes/PCR 조건#Step 1', 'PCR', 4, false],
      ['wiki', 'Home', 'h', 5, false],
      ['embed', 'gel.png', '200', 9, false],
      ['embed', 'Home', null, 9, false],
      ['md', './001_prep.labnote.md#step', null, 10, false],
      ['image', 'images/gel.png', null, 10, false],
    ]);
    expect(ls.map((l) => TEXT.slice(l.pathFrom, l.pathTo))).toEqual([
      'labnote/061_a/README.labnote', '이서연', 'Home', 'notes/PCR 조건', 'Home', 'gel.png', 'Home', './001_prep.labnote.md', 'images/gel.png',
    ]);
    const see = ls[2];
    expect(see.context).toBe('See [[Home]] and [[notes/PCR 조건#Step 1|PCR]].');
    expect(see.context.slice(see.contextFrom, see.contextTo)).toBe('[[Home]]');
  });

  it('keeps the table-cell escape outside the path range', () => {
    const l = extractLinks(TEXT)[4];
    expect(TEXT.slice(l.from, l.to)).toBe('[[Home\\|h]]');
    expect(TEXT.slice(l.pathTo, l.pathTo + 2)).toBe('\\|');
  });

  it('reads aliases and the title', () => {
    expect(extractMeta('---\naliases: [PCR, "중합효소 연쇄반응"]\n---\nx')).toEqual({ aliases: ['PCR', '중합효소 연쇄반응'] });
    expect(extractMeta('---\nalias: 짧은 이름\ntitle: 061 PCR\n---\n')).toEqual({ aliases: ['짧은 이름'], title: '061 PCR' });
    expect(extractMeta('no front matter')).toEqual({ aliases: [] });
    expect(extractMeta('\uFEFF---\naliases: [A]\n---\n')).toEqual({ aliases: ['A'] });
  });

  it('unescapes single-quoted YAML in front-matter link targets', () => {
    const t = "---\na: '[[Bob''s]]'\n---\n";
    const l = extractLinks(t)[0];
    expect(l.target).toBe("Bob's");
    expect(t.slice(l.pathFrom, l.pathTo)).toBe("Bob''s");
  });

  it('sees front matter behind a BOM', () => {
    const ls = extractLinks('\uFEFF---\nauthor: "[[이서연]]"\n---\n[[Home]]');
    expect(ls.map((l) => [l.target, l.inFrontmatter, l.line])).toEqual([['이서연', true, 1], ['Home', false, 3]]);
    expect(ls[1].from).toBe('\uFEFF---\nauthor: "[[이서연]]"\n---\n'.length);
  });

  it('prefilters', () => {
    expect(hasLinkSyntax('plain text only')).toBe(false);
    expect(hasLinkSyntax('a [[b]]')).toBe(true);
  });

  it('reads link reference definitions and skips scheme ones', () => {
    const t = 'See [p].\n\n[p]: <notes/a b.md#x>\n[q]: https://x.org\n';
    const ls = extractLinks(t);
    expect(ls.map((l) => [l.kind, l.target, t.slice(l.pathFrom, l.pathTo)])).toEqual([['md', 'notes/a b.md#x', 'notes/a b.md']]);
  });

  it('cuts a long line to CONTEXT_MAX around the link', () => {
    const line = 'x'.repeat(300) + ' [[Far]] ' + 'y'.repeat(300);
    const l = extractLinks(line)[0];
    expect(l.context.length).toBe(240);
    expect(l.context.slice(l.contextFrom, l.contextTo)).toBe('[[Far]]');
    expect(l.contextFrom).toBe(80);
  });
});
