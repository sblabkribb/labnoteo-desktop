import { createFakeVault } from './fakeVault';
import { ERROR_KINDS_FIXTURE } from './fixtures';

describe('fakeVault', () => {
  it('vault_modify with a stale expectedBefore returns conflict and writes nothing', async () => {
    const v = createFakeVault({ 'a.md': 'disk' });
    const r = await v.invoke('vault_modify', { path: 'a.md', content: 'mine', expectedBefore: 'old' });
    expect(r).toEqual({ kind: 'conflict', current: 'disk' });
    expect(v.files()['a.md']).toBe('disk');
    expect(await v.invoke('vault_modify', { path: 'a.md', content: 'mine', expectedBefore: 'disk' })).toEqual({ kind: 'ok' });
    expect(v.files()['a.md']).toBe('mine');
  });

  it('vault_read of a missing file rejects with notFound', async () => {
    const v = createFakeVault();
    await expect(v.invoke('vault_read', { path: 'nope.md' })).rejects.toMatchObject({ kind: ERROR_KINDS_FIXTURE.notFound });
  });

  it('vault_trash never deletes from files without recording it in recycleBin', async () => {
    const v = createFakeVault({ 'lab/a.md': 'A', 'lab/sub/b.md': 'B', 'keep.md': 'K' });
    await v.invoke('vault_trash', { path: 'lab' });
    expect(v.files()).toEqual({ 'keep.md': 'K' });
    expect(v.recycleBin).toEqual([{ path: 'lab', files: { 'lab/a.md': 'A', 'lab/sub/b.md': 'B' } }]);
    expect(await v.invoke('vault_exists', { path: 'lab' })).toBe(false);
    await v.invoke('vault_trash', { path: 'missing.md' }); // missing is Ok and records nothing
    expect(v.recycleBin).toHaveLength(1);
  });

  it('vault_rename moves files and folders, refuses an existing target, allows a case-only rename', async () => {
    const v = createFakeVault({ 'a.md': 'A', 'b.md': 'B', 'dir/x.md': 'X' });
    await expect(v.invoke('vault_rename', { from: 'a.md', to: 'B.md' })).rejects.toMatchObject({ kind: ERROR_KINDS_FIXTURE.exists });
    await v.invoke('vault_rename', { from: 'a.md', to: 'A.md' });
    await v.invoke('vault_rename', { from: 'dir', to: 'new/dir2' });
    expect(v.files()).toEqual({ 'A.md': 'A', 'b.md': 'B', 'new/dir2/x.md': 'X' });
    await expect(v.invoke('vault_rename', { from: 'gone.md', to: 'c.md' })).rejects.toMatchObject({ kind: ERROR_KINDS_FIXTURE.notFound });
  });

  it('lists, makes folders, builds the tree and records every call', async () => {
    const v = createFakeVault({ 'b/n.md': 'n', 'b/pic.PNG': 'p', 'a.md': 'a', '.obsidian/x.json': '{}' });
    await v.invoke('vault_mkdir', { path: 'empty' });
    expect((await v.invoke<string[]>('vault_list', { dir: '' })).sort()).toEqual(['.obsidian', 'a.md', 'b', 'empty']);
    expect(await v.invoke('vault_list', { dir: 'missing' })).toEqual([]);
    expect(await v.invoke('vault_tree', {})).toEqual([
      { path: 'b', name: 'b', isDir: true, depth: 0, ext: '' },
      { path: 'b/n.md', name: 'n.md', isDir: false, depth: 1, ext: 'md' },
      { path: 'b/pic.PNG', name: 'pic.PNG', isDir: false, depth: 1, ext: 'png' },
      { path: 'empty', name: 'empty', isDir: true, depth: 0, ext: '' },
      { path: 'a.md', name: 'a.md', isDir: false, depth: 0, ext: 'md' },
    ]);
    expect(v.log.map((c) => c.cmd)).toEqual(['vault_mkdir', 'vault_list', 'vault_list', 'vault_tree']);
  });

  it('failNext makes the next call of that command reject once', async () => {
    const v = createFakeVault({ 'a.md': 'A' });
    v.failNext('vault_modify', ERROR_KINDS_FIXTURE.io);
    await expect(v.invoke('vault_modify', { path: 'a.md', content: 'x' })).rejects.toMatchObject({ kind: ERROR_KINDS_FIXTURE.io });
    expect(v.files()['a.md']).toBe('A');
    await v.invoke('vault_modify', { path: 'a.md', content: 'x' });
    expect(v.files()['a.md']).toBe('x');
  });

  it('answers settings, index and vault commands, and emits vault://changed', async () => {
    const v = createFakeVault();
    expect(await v.invoke('settings_vault_read', {})).toBeNull();
    await v.invoke('settings_vault_write', { content: '{"a":1}' });
    expect(await v.invoke('settings_vault_read', {})).toBe('{"a":1}');
    expect(await v.invoke('search', { query: 'x', limit: 5 })).toEqual({ hits: [], truncated: false });
    expect(await v.invoke('vault_current', {})).toMatchObject({ name: expect.any(String) });
    const seen: unknown[] = [];
    const un = await v.listen('vault://changed', (e) => seen.push(e.payload));
    await v.emitChange('a.md', 'modified');
    un();
    await v.emitChange('b.md', 'modified');
    expect(seen).toEqual([{ path: 'a.md', kind: 'modified' }]);
  });
  it('pages bodies and lists images', async () => {
    const v = createFakeVault({ 'b.md': 'B', 'A.md': 'a', 'img/p.png': '', 'c/d.md': '[[x]]' });
    expect(await v.invoke('index_bodies', { after: null, limit: 2 })).toEqual({ items: [{ path: 'A.md', body: 'a' }, { path: 'b.md', body: 'B' }], next: 'b.md' });
    expect(await v.invoke('index_bodies', { after: 'b.md', limit: 2 })).toEqual({ items: [{ path: 'c/d.md', body: '[[x]]' }], next: null });
    expect(await v.invoke('vault_list_images', {})).toEqual(['img/p.png']);
  });
  it('keeps a link journal outside the files', async () => {
    const v = createFakeVault({ 'a.md': '' });
    await v.invoke('link_journal_write_header', { content: 'H' });
    await v.invoke('link_journal_write_note', { n: 1, content: 'B' });
    await v.invoke('link_journal_write_note', { n: 0, content: 'A' });
    expect(await v.invoke('link_journal_read', {})).toEqual({ header: 'H', notes: ['A', 'B'] });
    expect(Object.keys(v.files())).toEqual(['a.md']);
    await v.invoke('link_journal_clear', {});
    expect(await v.invoke('link_journal_read', {})).toBeNull();
    expect(v.journal.header).toBeNull();
  });
});
