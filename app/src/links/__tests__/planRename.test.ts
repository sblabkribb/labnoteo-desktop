import { describe, expect, it } from 'vitest';
import { LinkIndex } from '../linkIndex';
import { candidates, IndexNotReadyError, planRename } from '../planRename';
import { rewriteContext, rewriteLinks } from '../rewrite';

function indexOf(files: Record<string, string>, images: string[] = []): LinkIndex {
  const ix = new LinkIndex();
  ix.setFiles([...Object.keys(files), ...images]);
  for (const [p, t] of Object.entries(files)) ix.setNote(p, t);
  ix.markReady();
  return ix;
}
const reader = (disk: Record<string, string>) => async (p: string) => {
  if (!(p in disk)) throw { kind: 'notFound', message: p };
  return disk[p];
};

describe('planRename', () => {
  it('plans a file rename from fresh text', async () => {
    const ix = indexOf({ 'Home.md': '', 'notes/n.md': '[[Home]]', 'notes/m.md': 'none' });
    const disk = { 'notes/n.md': '[[Home]] [[Home|h]]', 'notes/m.md': 'none', 'Home.md': '' };
    const plan = await planRename({ from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [], read: reader(disk) });
    expect(plan.notes).toEqual([{ before: 'notes/n.md', after: 'notes/n.md', changed: 2, unsafe: 0 }]);
    expect(plan.linkCount).toBe(2);
    expect(plan.hasWikiRewrites).toBe(true);
  });
  it('refuses on an index that is not ready', async () => {
    const ix = new LinkIndex();
    await expect(planRename({ from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [], read: reader({}) })).rejects.toBeInstanceOf(IndexNotReadyError);
  });
  it('a case-only rename plans nothing', async () => {
    const ix = indexOf({ 'Home.md': '', 'n.md': '[[Home]]' });
    const plan = await planRename({ from: 'Home.md', to: 'home.md', isDir: false, index: ix, images: async () => [], read: reader({}) });
    expect(plan).toMatchObject({ caseOnly: true, notes: [], linkCount: 0 });
  });
  it('a folder rename moves images and notes and plans the moved notes too', async () => {
    const notes = { 'notes/a.md': '[[notes/b]]', 'notes/b.md': '', 'x.md': '![[notes/img/p.png]]' };
    const ix = indexOf(notes, ['notes/img/p.png']);
    const plan = await planRename({ from: 'notes', to: 'docs', isDir: true, index: ix, images: async () => ['notes/img/p.png'], read: reader(notes) });
    expect(plan.moves).toEqual([{ from: 'notes/a.md', to: 'docs/a.md' }, { from: 'notes/b.md', to: 'docs/b.md' }, { from: 'notes/img/p.png', to: 'docs/img/p.png' }]);
    expect(plan.notes.map((n) => [n.before, n.after])).toEqual([['notes/a.md', 'docs/a.md'], ['x.md', 'x.md']]);
  });
  it('a folder rename pins a suffix link it would hijack', async () => {
    const notes = { 'a/x.md': '', 'other/b/x.md': '', 'n.md': '[[b/x]]' };
    const ix = indexOf(notes);
    expect(candidates(ix, [{ from: 'a/x.md', to: 'b/x.md' }])).toContain('n.md');
    const plan = await planRename({ from: 'a', to: 'b', isDir: true, index: ix, images: async () => [], read: reader(notes) });
    expect(plan.notes).toEqual([{ before: 'n.md', after: 'n.md', changed: 1, unsafe: 0 }]);
    expect(rewriteLinks('[[b/x]]', 'n.md', 'n.md', rewriteContext(plan.files, plan.moves)).text).toBe('[[other/b/x]]');
  });
  it('always plans the active note, even when the index has not seen its new link', async () => {
    const ix = indexOf({ 'Home.md': '', 'n.md': 'old text' });
    const plan = await planRename({ from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [], read: reader({ 'Home.md': '', 'n.md': 'typed [[Home]]' }), activePath: 'n.md' });
    expect(plan.notes.map((n) => n.before)).toEqual(['n.md']);
  });
  it('adds search hits as candidates', async () => {
    const ix = indexOf({ 'Home.md': '', 'n.md': '' }); // the index missed n.md's link
    const plan = await planRename({
      from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [],
      read: reader({ 'Home.md': '', 'n.md': '[[Home]]' }),
      search: async () => ({ hits: [{ path: 'n.md' }] }),
    });
    expect(plan.notes.map((n) => n.before)).toEqual(['n.md']);
  });
  it('reads through parseRaw: a BOM before front matter still plans the front-matter link', async () => {
    const ix = indexOf({ 'Home.md': '', 'n.md': '---\na: "[[Home]]"\n---\n' });
    const plan = await planRename({ from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [], read: reader({ 'Home.md': '', 'n.md': '﻿---\r\na: "[[Home]]"\r\n---\r\n' }) });
    expect(plan.notes).toEqual([{ before: 'n.md', after: 'n.md', changed: 1, unsafe: 0 }]);
  });

  // Extra coverage beyond the plan's stubs.
  it('skips a candidate deleted since it was indexed, and rethrows other read errors', async () => {
    const ix = indexOf({ 'Home.md': '', 'n.md': '[[Home]]', 'm.md': '[[Home]]' });
    const plan = await planRename({ from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [], read: reader({ 'm.md': '[[Home]]' }) });
    expect(plan.notes.map((n) => n.before)).toEqual(['m.md']);
    const io = async (): Promise<string> => {
      throw { kind: 'io', message: 'disk' };
    };
    await expect(planRename({ from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [], read: io })).rejects.toMatchObject({ kind: 'io' });
  });
  it('hasWikiRewrites is false when only markdown links change, and counts unsafe wikilinks', async () => {
    const ix = indexOf({ 'Home.md': '', 'n.md': '[h](Home.md)' });
    const md = await planRename({ from: 'Home.md', to: 'Start.md', isDir: false, index: ix, images: async () => [], read: reader({ 'n.md': '[h](Home.md)' }) });
    expect(md).toMatchObject({ linkCount: 1, hasWikiRewrites: false });
    const ix2 = indexOf({ 'Home.md': '', 'n.md': '[[Home]]' });
    const bad = await planRename({ from: 'Home.md', to: 'PCR #2.md', isDir: false, index: ix2, images: async () => [], read: reader({ 'n.md': '[[Home]]' }) });
    expect(bad.notes).toEqual([{ before: 'n.md', after: 'n.md', changed: 0, unsafe: 1 }]);
    expect(bad).toMatchObject({ linkCount: 0, hasWikiRewrites: true });
  });
  it('a folder rename whose basename links stay identical has no wiki rewrites', async () => {
    const ix = indexOf({ 'a/x.md': '', 'n.md': '[[x]]' });
    const plan = await planRename({ from: 'a', to: 'b#1', isDir: true, index: ix, images: async () => [], read: reader({ 'a/x.md': '', 'n.md': '[[x]]' }) });
    expect(plan).toMatchObject({ notes: [], linkCount: 0, hasWikiRewrites: false });
  });
  it('uses the universe it is given and does not search for a one-character name', async () => {
    const ix = indexOf({ 'H.md': '', 'n.md': '' });
    let searched = false;
    const plan = await planRename({
      from: 'H.md', to: 'S.md', isDir: false, index: ix, images: async () => ['img.png'], files: ['H.md', 'n.md'],
      read: reader({ 'n.md': '[[H]]' }),
      search: async () => {
        searched = true;
        return { hits: [{ path: 'n.md' }] };
      },
    });
    expect(searched).toBe(false);
    expect(plan.files).toEqual(['H.md', 'n.md']);
    expect(plan.notes).toEqual([]);
  });
});
