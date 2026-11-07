import { describe, expect, it } from 'vitest';
import { applyMoves, invertMoves, movesFor, rewriteContext, rewriteLinks, rewriteLinksDetailed } from '../rewrite';

const FILES = ['Home.md', 'notes/PCR 조건.md', 'notes/sub/PCR 조건.md', 'labnote/061_a/README.labnote.md', 'labnote/061_a/001_prep.labnote.md', 'labnote/062_b/README.labnote.md', 'images/gel.png', 'other/b.md', 'a.md', 'notes/n.md'];
const ctxFor = (from: string, to: string, isDir = false, files = FILES) => rewriteContext(files, movesFor(from, to, isDir, files));
const IN = [
  '[[Home]] [[home|홈]] [[Home#Intro|i]] ![[Home]] [[Home.md]]',
  '| x | [[Home\\|h]] |',
  '|---|---|',
  '`[[Home]]`',
  '[h](../Home.md#intro) [h2](<../Home.md>) [h3](/Home.md)',
].join('\n');

describe('rewriteLinks', () => {
  it('rewrites every link form and leaves every other byte alone', () => {
    const out = rewriteLinks(IN, 'notes/n.md', 'notes/n.md', ctxFor('Home.md', 'Start.md'));
    expect(out.text).toBe([
      '[[Start]] [[Start|홈]] [[Start#Intro|i]] ![[Start]] [[Start.md]]',
      '| x | [[Start\\|h]] |',
      '|---|---|',
      '`[[Home]]`',
      '[h](../Start.md#intro) [h2](<../Start.md>) [h3](/Start.md)',
    ].join('\n'));
    expect(out.changed).toBe(9);
    expect(out.unsafe).toBe(0);
    expect(out.text.replace(/\[\[Start/g, '[[Home').replace(/Start\.md/g, 'Home.md')).toBe(IN.replace('[[home|', '[[Home|'));
  });
  it('updates front-matter links and relative checklist links on a folder rename, keeping their style', () => {
    const text = '---\nretry_of: "[[labnote/061_a/README.labnote|061]]"\n---\n- [ ] [prep](../061_a/001_prep.labnote.md)\n[[README.labnote]]\n';
    const out = rewriteLinks(text, 'labnote/062_b/README.labnote.md', 'labnote/062_b/README.labnote.md', ctxFor('labnote/061_a', 'labnote/061_alpha', true));
    expect(out.text).toBe('---\nretry_of: "[[labnote/061_alpha/README.labnote|061]]"\n---\n- [ ] [prep](../061_alpha/001_prep.labnote.md)\n[[README.labnote]]\n');
    expect(out.changed).toBe(2);
  });
  it('percent-encoded Korean stays percent-encoded', () => {
    const text = '[a](../PCR%20%EC%A1%B0%EA%B1%B4.md) [b](<../PCR 조건.md>) [[notes/PCR 조건]] [[PCR 조건]]';
    const out = rewriteLinks(text, 'notes/sub/x.md', 'notes/sub/x.md', ctxFor('notes/PCR 조건.md', 'notes/PCR 프로토콜.md'));
    expect(out.text).toBe('[a](../PCR%20%ED%94%84%EB%A1%9C%ED%86%A0%EC%BD%9C.md) [b](<../PCR 프로토콜.md>) [[notes/PCR 프로토콜]] [[PCR 조건]]');
  });
  it('a space in a raw markdown path is percent-encoded', () => {
    const out = rewriteLinks('[h](../Home.md) [[Home]]', 'notes/n.md', 'notes/n.md', ctxFor('Home.md', 'My Home (old).md'));
    expect(out.text).toBe('[h](../My%20Home%20%28old%29.md) [[My Home (old)]]');
  });
  it('pins a link a rename would hijack', () => {
    const out = rewriteLinks('[[a]] [[b]]', 'x.md', 'x.md', ctxFor('a.md', 'b.md'));
    expect(out.text).toBe('[[b]] [[other/b]]');
    expect(out.changed).toBe(2);
  });
  it('counts the hijack pins: a second pass over rewritten text would pin again (not idempotent)', () => {
    const ctx = ctxFor('a.md', 'b.md');
    const first = rewriteLinksDetailed('[[a]] [[b]]', 'x.md', 'x.md', ctx);
    expect(first.pinned).toBe(1);
    // The rewritten [[b]] now names the moved note, but the before-universe reads it as other/b: the pass is ambiguous.
    const second = rewriteLinksDetailed(first.text, 'x.md', 'x.md', ctx);
    expect(second.pinned).toBe(1);
    expect(rewriteLinksDetailed('[[a]] [[x]]', 'x.md', 'x.md', ctx).pinned).toBe(0);
  });
  it('a root target shadowed in the source folder gets the rooted form', () => {
    const files = ['Home.md', 'notes/Start.md', 'notes/x.md'];
    const out = rewriteLinks('[[Home]] [h](../Home.md)', 'notes/x.md', 'notes/x.md', ctxFor('Home.md', 'Start.md', false, files));
    expect(out.text).toBe('[[/Start]] [h](../Start.md)');
    expect(out.unsafe).toBe(0);
  });
  it('a name a wikilink cannot express is reported unsafe and left unchanged', () => {
    const out = rewriteLinks('[[Home]] [h](../Home.md)', 'notes/n.md', 'notes/n.md', ctxFor('Home.md', 'PCR #2.md'));
    expect(out.text).toBe('[[Home]] [h](../PCR%20%232.md)');
    expect(out).toMatchObject({ changed: 1, unsafe: 1 });
  });
  it('keeps YAML single-quote escaping', () => {
    const out = rewriteLinks("---\nauthor: '[[Home]]'\n---\n[[Home]]", 'n.md', 'n.md', ctxFor('Home.md', "Bob's.md", false, ['Home.md', 'n.md']));
    expect(out.text).toBe("---\nauthor: '[[Bob''s]]'\n---\n[[Bob's]]");
    const again = rewriteLinks(out.text, 'n.md', 'n.md', ctxFor("Bob's.md", 'Carol.md', false, ["Bob's.md", 'n.md']));
    expect(again.text).toBe("---\nauthor: '[[Carol]]'\n---\n[[Carol]]"); // the escaped link is still found
  });
  it('CRLF and BOM survive', () => {
    const out = rewriteLinks('﻿---\r\na: "[[Home]]"\r\n---\r\n[[Home]]\r\nx\r\n', 'n.md', 'n.md', ctxFor('Home.md', 'Start.md'));
    expect(out.text).toBe('﻿---\r\na: "[[Start]]"\r\n---\r\n[[Start]]\r\nx\r\n');
  });
  it('moved notes keep working relative links; path wikilinks follow the folder', () => {
    const text = '[up](../../Home.md) [sib](../PCR%20%EC%A1%B0%EA%B1%B4.md) [[notes/PCR 조건]] [[Home]]';
    const out = rewriteLinks(text, 'notes/sub/PCR 조건.md', 'docs/sub/PCR 조건.md', ctxFor('notes', 'docs', true));
    expect(out.text).toBe('[up](../../Home.md) [sib](../PCR%20%EC%A1%B0%EA%B1%B4.md) [[docs/PCR 조건]] [[Home]]');
    expect(out.changed).toBe(1); // [sib] is recomputed to identical text: not counted
  });
  it('is idempotent and leaves unresolved links alone', () => {
    const c = ctxFor('Home.md', 'Start.md');
    const once = rewriteLinks(IN + '\n[[Nope]]', 'notes/n.md', 'notes/n.md', c).text;
    expect(rewriteLinks(once, 'notes/n.md', 'notes/n.md', c)).toEqual({ text: once, changed: 0, unsafe: 0 });
  });
  it('a name with a double quote is never written into a double-quoted front-matter scalar', () => {
    const out = rewriteLinks('---\na: "[[Home]]"\n---\n[[Home]]', 'n.md', 'n.md', ctxFor('Home.md', 'Say "hi".md', false, ['Home.md', 'n.md']));
    expect(out.text).toBe('---\na: "[[Home]]"\n---\n[[Say "hi"]]');
    expect(out).toMatchObject({ changed: 1, unsafe: 1 });
  });
  it('same-note heading and block links are never rewritten into cross-note links', () => {
    const text = 'a [[#A]] b ![[#^blk]] [[#A|x]]';
    expect(rewriteLinks(text, 'Home.md', 'Start.md', ctxFor('Home.md', 'Start.md'))).toEqual({ text, changed: 0, unsafe: 0 });
    expect(rewriteLinks(text, 'Home.md', 'Home.md', ctxFor('Home.md', 'Start.md'))).toEqual({ text, changed: 0, unsafe: 0 });
  });
  it('a quote or backslash is never written into the middle of a front-matter scalar', () => {
    const files = ['Home.md', 'n.md'];
    const single = "---\na: 'see [[Home]]'\n---\n";
    const out = rewriteLinks(single, 'n.md', 'n.md', ctxFor('Home.md', "Bob's.md", false, files));
    expect(out).toEqual({ text: single, changed: 0, unsafe: 1 });
    const dbl = '---\na: "see [[Home]]"\n---\n';
    expect(rewriteLinks(dbl, 'n.md', 'n.md', ctxFor('Home.md', 'Say "hi".md', false, files))).toEqual({ text: dbl, changed: 0, unsafe: 1 });
    // A plain rename in the same spot is still written.
    expect(rewriteLinks(single, 'n.md', 'n.md', ctxFor('Home.md', 'Start.md', false, files)).text).toBe("---\na: 'see [[Start]]'\n---\n");
  });
  it('a comma is never written into an unquoted front-matter wikilink', () => {
    const text = '---\na: [[Home]]\n---\n';
    expect(rewriteLinks(text, 'n.md', 'n.md', ctxFor('Home.md', 'x, y.md', false, ['Home.md', 'n.md']))).toEqual({ text, changed: 0, unsafe: 1 });
  });
  it('a markdown link without .md stays without .md', () => {
    const out = rewriteLinks('[h](../Home) [i](../Home.md)', 'notes/n.md', 'notes/n.md', ctxFor('Home.md', 'Start.md'));
    expect(out.text).toBe('[h](../Start) [i](../Start.md)');
  });
  it('a relative wikilink stays relative and keeps its target when the new path goes down a folder', () => {
    const files = ['Home.md', 'notes/n.md', 'sub/Home.md'];
    const out = rewriteLinks('[[../Home]] [[../Home.md|h]]', 'notes/n.md', 'notes/n.md', ctxFor('Home.md', 'notes/sub/Home.md', false, files));
    expect(out.text).toBe('[[./sub/Home]] [[./sub/Home.md|h]]');
    expect(out).toMatchObject({ changed: 2, unsafe: 0 });
  });
  it('a path wikilink whose new text resolves elsewhere is left unchanged and counted unsafe (post-condition)', () => {
    // The extensionless file 'sub/Start' shadows 'sub/Start.md' for every path form without '.md'.
    const files = ['lab/Home.md', 'notes/n.md', 'sub/Start'];
    const ctx = ctxFor('lab/Home.md', 'sub/Start.md', false, files);
    for (const text of ['[[../lab/Home]]', '[[/lab/Home]]', '[[lab/Home]]']) {
      expect(rewriteLinks(text, 'notes/n.md', 'notes/n.md', ctx)).toEqual({ text, changed: 0, unsafe: 1 });
    }
    // With '.md' kept, the same move is written.
    expect(rewriteLinks('[[../lab/Home.md]]', 'notes/n.md', 'notes/n.md', ctx).text).toBe('[[../sub/Start.md]]');
  });
  it('a new text that would no longer parse as a link is left unchanged and counted unsafe', () => {
    const files = ['Home.md', 'n.md'];
    const text = 'a `x [[Home]] y';
    expect(rewriteLinks(text, 'n.md', 'n.md', ctxFor('Home.md', 'Ho`me.md', false, files))).toEqual({ text, changed: 0, unsafe: 1 });
    // Each edit is checked on its own once the broken ones are dropped: here both would sit in a code span.
    const two = 'a `x [[Home]] y [[Home]] z';
    expect(rewriteLinks(two, 'n.md', 'n.md', ctxFor('Home.md', 'Ho`me.md', false, files))).toEqual({ text: two, changed: 0, unsafe: 2 });
    // A good edit next to a broken one is still written.
    const mixed = '[[a]] `x [[Home]]';
    const out = rewriteLinks(mixed, 'n.md', 'n.md', rewriteContext(['Home.md', 'a.md', 'n.md'], [{ from: 'Home.md', to: 'Ho`me.md' }, { from: 'a.md', to: 'b.md' }]));
    expect(out).toEqual({ text: '[[b]] `x [[Home]]', changed: 1, unsafe: 1 });
    const fm = '---\nup: [[Home]]\n---\n';
    expect(rewriteLinks(fm, 'n.md', 'n.md', ctxFor('Home.md', 'x{y}.md', false, files))).toEqual({ text: fm, changed: 0, unsafe: 1 });
  });
  it('keeps a trailing backslash before the alias pipe outside a table', () => {
    const out = rewriteLinks('[[Home\\|x]]', 'notes/n.md', 'notes/n.md', ctxFor('Home.md', 'Start.md'));
    expect(out.text).toBe('[[Start\\|x]]');
  });
});

describe('moves', () => {
  it('movesFor a folder lists every file under it in key order; applyMoves and invertMoves round-trip', () => {
    const moves = movesFor('notes', 'docs', true, FILES);
    expect(moves).toEqual([
      { from: 'notes/n.md', to: 'docs/n.md' },
      { from: 'notes/PCR 조건.md', to: 'docs/PCR 조건.md' },
      { from: 'notes/sub/PCR 조건.md', to: 'docs/sub/PCR 조건.md' },
    ]);
    expect(movesFor('a.md', 'z.md', false, FILES)).toEqual([{ from: 'a.md', to: 'z.md' }]);
    const after = applyMoves(FILES, moves);
    expect(after).toContain('docs/sub/PCR 조건.md');
    expect(after).not.toContain('notes/n.md');
    expect(applyMoves(after, invertMoves(moves))).toEqual(FILES);
  });
  it('movesFor a folder slices by segments, so a differently normalised folder name keeps the right tail', () => {
    const nfd = '노트'.normalize('NFD');
    const files = [`${nfd}/a.md`, `${nfd}/sub/b.md`];
    expect(movesFor('노트', 'docs', true, files)).toEqual([
      { from: `${nfd}/a.md`, to: 'docs/a.md' },
      { from: `${nfd}/sub/b.md`, to: 'docs/sub/b.md' },
    ]);
  });
});
