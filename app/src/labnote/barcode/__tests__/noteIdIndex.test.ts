import { describe, expect, it, vi } from 'vitest';
import { NoteIdIndex, noteIds, setNoteIdIndex, type NoteIdIndexDeps } from '../noteIdIndex';

/** 메모리 위 파일들. `files` 를 바꾸면 다음 읽기에 보인다. ctime 은 받은 목록에서의 순번 + 1000. */
function deps(files: Record<string, string>, read?: (path: string) => Promise<string>) {
  const d = {
    files: vi.fn(async () => Object.keys(files)),
    read: vi.fn(
      read ??
        (async (path: string) => {
          if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return files[path];
        }),
    ),
    ctimes: vi.fn(async (paths: string[]) => paths.map((_, i) => 1000 + i)),
  };
  return d satisfies NoteIdIndexDeps;
}

describe('NoteIdIndex', () => {
  it('indexes valid front-matter ids only', async () => {
    const idx = new NoteIdIndex(
      deps({
        'a.labnote.md': '---\nlabnote_id: LN-7K3M9QX2\n---\n',
        'b.labnote.md': 'labnote_id: LN-7K3M9QX2\n',
        'c.md': '---\nlabnote_id: ln-bad\n---\n',
      }),
    );
    await idx.ready();
    expect(idx.idOf('a.labnote.md')).toBe('LN-7K3M9QX2');
    expect(idx.idOf('b.labnote.md')).toBeUndefined();
    expect(idx.idOf('c.md')).toBeUndefined();
    expect(idx.refs().map((r) => r.path).sort()).toEqual(['a.labnote.md', 'b.labnote.md', 'c.md']);
    expect(idx.refs().find((r) => r.path === 'a.labnote.md')).toMatchObject({ basename: 'a.labnote', ctime: 1000 });
  });

  it('reads a front matter written with a BOM and CRLF', async () => {
    const idx = new NoteIdIndex(deps({ 'a.labnote.md': '﻿---\r\nlabnote_id: LN-7K3M9QX2\r\n---\r\n' }));
    await idx.ready();
    expect(idx.idOf('a.labnote.md')).toBe('LN-7K3M9QX2');
  });

  it('refresh reports a changed id and drops a deleted file', async () => {
    const files: Record<string, string> = { 'a.labnote.md': '---\nlabnote_id: LN-7K3M9QX2\n---\n' };
    const idx = new NoteIdIndex(deps(files));
    await idx.ready();
    const seen: string[] = [];
    idx.onChange((p) => seen.push(p));
    files['a.labnote.md'] = '---\nlabnote_id: LN-8M4N0RY3\n---\n';
    await idx.refresh('a.labnote.md');
    expect(seen).toEqual(['a.labnote.md']);
    expect(idx.idOf('a.labnote.md')).toBe('LN-8M4N0RY3');
    delete files['a.labnote.md'];
    await idx.refresh('a.labnote.md');
    expect(idx.exists('a.labnote.md')).toBe(false);
  });

  it('refresh of an unchanged id fires nothing; a new file with an id fires; unsubscribe stops it', async () => {
    const files: Record<string, string> = { 'a.labnote.md': '---\nlabnote_id: LN-7K3M9QX2\n---\n' };
    const idx = new NoteIdIndex(deps(files));
    await idx.ready();
    const seen: string[] = [];
    const off = idx.onChange((p) => seen.push(p));
    await idx.refresh('a.labnote.md');
    expect(seen).toEqual([]);
    files['n.labnote.md'] = '---\nlabnote_id: LN-8M4N0RY3\n---\n';
    await idx.refresh('n.labnote.md');
    expect(seen).toEqual(['n.labnote.md']);
    expect(idx.exists('n.labnote.md')).toBe(true);
    off();
    files['n.labnote.md'] = '---\nlabnote_id: LN-9N5P1SZ4\n---\n';
    await idx.refresh('n.labnote.md');
    expect(seen).toEqual(['n.labnote.md']);
  });

  it('rename moves the entry without re-reading', async () => {
    const d = deps({ 'a.labnote.md': '---\nlabnote_id: LN-7K3M9QX2\n---\n' });
    const idx = new NoteIdIndex(d);
    await idx.ready();
    const reads = d.read.mock.calls.length;
    idx.rename('a.labnote.md', 'x/b.labnote.md');
    expect(idx.idOf('x/b.labnote.md')).toBe('LN-7K3M9QX2');
    expect(idx.exists('a.labnote.md')).toBe(false);
    expect(idx.refs().find((r) => r.path === 'x/b.labnote.md')).toMatchObject({ basename: 'b.labnote' });
    expect(d.read.mock.calls.length).toBe(reads);
  });

  it('drop removes the entry', async () => {
    const idx = new NoteIdIndex(deps({ 'a.labnote.md': '---\nlabnote_id: LN-7K3M9QX2\n---\n' }));
    await idx.ready();
    idx.drop('a.labnote.md');
    expect(idx.exists('a.labnote.md')).toBe(false);
    expect(idx.idOf('a.labnote.md')).toBeUndefined();
    expect(idx.refs()).toEqual([]);
  });

  it("refresh('') rebuilds", async () => {
    const files: Record<string, string> = { 'a.md': '' };
    const idx = new NoteIdIndex(deps(files));
    await idx.ready();
    files['n.labnote.md'] = '---\nlabnote_id: LN-7K3M9QX2\n---\n';
    await idx.refresh('');
    expect(idx.idOf('n.labnote.md')).toBe('LN-7K3M9QX2');
  });

  it('never reads more than 16 files at once', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) files[`n${i}.md`] = '';
    let live = 0;
    let max = 0;
    const d = deps(files, async () => {
      live++;
      max = Math.max(max, live);
      await new Promise((r) => setTimeout(r, 0));
      live--;
      return '';
    });
    const idx = new NoteIdIndex(d);
    await idx.ready();
    expect(d.read).toHaveBeenCalledTimes(100);
    expect(max).toBe(16);
    expect(idx.refs()).toHaveLength(100);
  });

  it('a file that cannot be read is kept without an id', async () => {
    const idx = new NoteIdIndex(
      deps({ 'a.md': '' }, async () => {
        throw new Error('locked');
      }),
    );
    await idx.ready();
    expect(idx.exists('a.md')).toBe(true);
    expect(idx.idOf('a.md')).toBeUndefined();
  });

  it('ready() builds once', async () => {
    const d = deps({ 'a.md': '' });
    const idx = new NoteIdIndex(d);
    await Promise.all([idx.ready(), idx.ready()]);
    await idx.ready();
    expect(d.files).toHaveBeenCalledTimes(1);
  });

  it('noteIds() throws before an index is set and returns the one set', () => {
    setNoteIdIndex(undefined);
    expect(() => noteIds()).toThrow();
    const idx = new NoteIdIndex(deps({}));
    setNoteIdIndex(idx);
    expect(noteIds()).toBe(idx);
    setNoteIdIndex(undefined);
  });
});
