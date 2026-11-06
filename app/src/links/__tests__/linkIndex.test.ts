import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkIndex } from '../linkIndex';

describe('LinkIndex', () => {
  let ix: LinkIndex;
  beforeEach(() => {
    ix = new LinkIndex();
    ix.setFiles(['Home.md', 'notes/a.md', 'notes/b.md', 'images/gel.png']);
    ix.setNote('notes/a.md', 'to [[Home]] and [[nowhere]] ![[gel.png]] [s](../Home.md)');
    ix.setNote('notes/b.md', '[[Home#Intro|i]] [[b]]');
  });
  it('lists backlinks grouped and sorted, without self links', () => {
    const bl = ix.backlinks('Home.md');
    expect(bl.map((b) => [b.source, b.links.length])).toEqual([['notes/a.md', 2], ['notes/b.md', 1]]);
    expect(ix.backlinks('notes/b.md')).toEqual([]);
  });
  it('marks unresolved and unknown', () => {
    expect(ix.resolved('notes/a.md').map((r) => r.target)).toEqual(['Home.md', null, 'images/gel.png', 'Home.md']);
    ix.setNote('notes/a.md', '[[spec.pdf]]');
    expect(ix.resolved('notes/a.md')[0]).toMatchObject({ target: null, unknown: true });
  });
  it('overlay wins and clears back to disk text', () => {
    ix.setOverlay('notes/a.md', 'nothing here');
    expect(ix.backlinks('Home.md').map((b) => b.source)).toEqual(['notes/b.md']);
    ix.setOverlay('notes/a.md', null);
    expect(ix.backlinks('Home.md').map((b) => b.source)).toEqual(['notes/a.md', 'notes/b.md']);
  });
  it('removeTree drops a folder', () => {
    ix.removeTree('notes');
    expect(ix.files()).toEqual(['Home.md', 'images/gel.png']);
    expect(ix.backlinks('Home.md')).toEqual([]);
  });
  it('notifies once per batch', async () => {
    const fn = vi.fn();
    ix.subscribe(fn);
    ix.setNote('notes/a.md', 'x'); ix.setNote('notes/b.md', 'y');
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('finds hijack candidates by basename, for wiki and markdown links', () => {
    expect(ix.sourcesLinkingBasename('b')).toEqual(['notes/b.md']);
    ix.setNote('notes/a.md', '[x](b.md)');
    expect(ix.sourcesLinkingBasename('b')).toEqual(['notes/a.md', 'notes/b.md']);
  });
  it('note text changes do not bump filesVersion or rebuild the resolver', () => {
    const f = ix.filesVersion; const r = ix.resolver(); const l = ix.linksVersion;
    ix.setOverlay('notes/a.md', '[[Home]] typing');
    expect(ix.filesVersion).toBe(f);
    expect(ix.linksVersion).toBe(l + 1);
    expect(ix.resolver()).toBe(r);
    ix.addFiles(['New.md']);
    expect(ix.filesVersion).toBe(f + 1);
    expect(ix.resolver()).not.toBe(r);
  });
  it('keeps the reverse map per source', () => {
    ix.setNote('notes/a.md', 'only [[notes/b]]');
    expect(ix.backlinks('Home.md').map((b) => b.source)).toEqual(['notes/b.md']);
    expect(ix.backlinks('notes/b.md').map((b) => b.source)).toEqual(['notes/a.md']);
    ix.addFiles(['nowhere.md']);
    ix.setNote('notes/a.md', 'to [[nowhere]]');
    expect(ix.backlinks('nowhere.md').map((b) => b.source)).toEqual(['notes/a.md']);
  });
  it('whenReady covers the wait before loading', async () => {
    const fresh = new LinkIndex();
    let done = false;
    void fresh.whenReady().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    fresh.markReady();
    await Promise.resolve();
    expect(done).toBe(true);
    fresh.clear();
    expect(fresh.ready()).toBe(false);
  });
  it('keeps labnote titles', () => {
    ix.addFiles(['labnote/061_a/README.labnote.md']);
    ix.setNote('labnote/061_a/README.labnote.md', '---\ntitle: 061 PCR 최적화\n---\n');
    expect(ix.title('labnote/061_a/README.labnote.md')).toBe('061 PCR 최적화');
  });
});
