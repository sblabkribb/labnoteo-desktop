// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { createTestHost } from '../../labnote/__tests__/testHost';
import { createFromLink, handleOpenLink, newNotePath, openLinkTarget } from '../createFromLink';
import { coreT } from '../../labnote/i18n';

describe('createFromLink', () => {
  it('places new notes per D6', () => {
    expect(newNotePath('New idea', 'notes/a.md')).toBe('notes/New idea.md');
    expect(newNotePath('sub/x', 'notes/a.md')).toBe('sub/x.md');
    expect(newNotePath('./y', 'notes/a.md')).toBe('notes/y.md');
    expect(newNotePath('../z', 'notes/deep/a.md')).toBe('notes/z.md');
    expect(newNotePath('z.md', 'a.md')).toBe('z.md');
    expect(newNotePath('pic.png', 'a.md')).toEqual({ refused: 'notNote' });
    expect(newNotePath('spec.pdf', 'a.md')).toEqual({ refused: 'notNote' });
    expect(newNotePath('2024.01.05', 'a.md')).toBe('2024.01.05.md');
    expect(newNotePath('PCR v2.1', 'notes/a.md')).toBe('notes/PCR v2.1.md');
  });
  it('creates an empty note and opens it', async () => {
    const h = createTestHost({ 'notes/a.md': '[[New idea]]' });
    expect(await createFromLink(h.ctx, 'New idea', 'notes/a.md')).toBe('notes/New idea.md');
    expect(h.vault.files()['notes/New idea.md']).toBe('');
    expect(h.opened).toEqual(['notes/New idea.md']);
    expect(h.notes).toContainEqual({ kind: 'info', message: t('links.created', 'notes/New idea.md') });
  });
  it('never overwrites a note that appeared between the check and the write', async () => {
    const h = createTestHost({ 'notes/a.md': '', 'notes/x.md': 'keep' });
    vi.spyOn(h.ctx.host.fs, 'exists').mockResolvedValueOnce(false);
    expect(await createFromLink(h.ctx, 'x', 'notes/a.md')).toBeUndefined();
    expect(h.vault.files()['notes/x.md']).toBe('keep');
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.exists') });
  });
  it('reports a name Windows refuses', async () => {
    const h = createTestHost({ 'a.md': '' });
    h.vault.failNext('vault_modify', 'forbidden');
    expect(await createFromLink(h.ctx, 'CON', 'a.md')).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.name.invalid') });
  });
  it('reports a name Windows refuses when the existence check rejects it', async () => {
    // The real vault_exists runs the path through Rust `confine`, which refuses CON, `: ? *` and the like.
    const h = createTestHost({ 'a.md': '' });
    h.vault.failNext('vault_exists', 'escape');
    expect(await createFromLink(h.ctx, 'Exp 1: PCR', 'a.md')).toBeUndefined();
    expect(h.vault.files()['Exp 1: PCR.md']).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.name.invalid') });
  });
  it('opens x.labnote.md instead of creating a duplicate x.md (the .labnote fallback, index not refreshed yet)', async () => {
    const h = createTestHost({ 'exp/a.labnote.md': '[[플라스미드 미니프렙]]', 'exp/플라스미드 미니프렙.labnote.md': 'keep' });
    expect(await createFromLink(h.ctx, '플라스미드 미니프렙', 'exp/a.labnote.md')).toBe('exp/플라스미드 미니프렙.labnote.md');
    expect(h.vault.files()['exp/플라스미드 미니프렙.md']).toBeUndefined();
    expect(h.vault.files()['exp/플라스미드 미니프렙.labnote.md']).toBe('keep');
    expect(h.opened).toEqual(['exp/플라스미드 미니프렙.labnote.md']);
  });
  it('opens the note when it already exists at exactly that path (index not refreshed yet)', async () => {
    const h = createTestHost({ 'notes/a.md': '', 'notes/x.md': 'keep' });
    expect(await createFromLink(h.ctx, 'x', 'notes/a.md')).toBe('notes/x.md');
    expect(h.vault.files()['notes/x.md']).toBe('keep');
    expect(h.opened).toEqual(['notes/x.md']);
  });
  it('warns rather than opens when only a different-case entry or a folder exists', async () => {
    const h = createTestHost({ 'notes/a.md': '', 'notes/X.md': 'keep', 'notes/dir.md/inner.md': 'k' });
    expect(await createFromLink(h.ctx, 'x', 'notes/a.md')).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.exists') });
    expect(await createFromLink(h.ctx, 'dir', 'notes/a.md')).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.exists') });
    expect(h.vault.files()['notes/X.md']).toBe('keep');
    expect(h.opened).toEqual([]);
  });
  it('refuses a link path with no name', async () => {
    expect(newNotePath('.', 'notes/a.md')).toEqual({ refused: 'invalid' });
    expect(newNotePath('sub/..', 'notes/a.md')).toEqual({ refused: 'invalid' });
    expect(newNotePath('sub/', 'notes/a.md')).toEqual({ refused: 'invalid' });
    const h = createTestHost({ 'notes/a.md': '' });
    expect(await createFromLink(h.ctx, '.', 'notes/a.md')).toBeUndefined();
    expect(h.vault.files()['notes.md']).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.name.invalid') });
  });
  it('refuses to create an attachment from a link', async () => {
    const h = createTestHost({ 'a.md': '' });
    expect(await createFromLink(h.ctx, 'pic.png', 'a.md')).toBeUndefined();
    expect(h.vault.files()['pic.png']).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.create.notNote', 'pic.png') });
  });
  it('refuses a link path that leaves the vault', async () => {
    const h = createTestHost({ 'a.md': '' });
    expect(await createFromLink(h.ctx, '../../out', 'a.md')).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.name.invalid') });
  });
  it('opens a note at its heading', async () => {
    const h = createTestHost({ 'a.md': '', 'Home.md': '# A\n## Step\n' });
    const spy = vi.spyOn(h.ctx, 'openFile');
    await openLinkTarget(h.ctx, { kind: 'note', path: 'Home.md', subpath: 'step' }, 'a.md', async () => {});
    expect(spy).toHaveBeenCalledWith('Home.md', { line: 1 });
  });
  it('opens a CRLF note with a BOM at the editor line', async () => {
    const h = createTestHost({ 'a.md': '', 'Home.md': '\uFEFF# A\r\nx\r\n## Step\r\n' });
    const spy = vi.spyOn(h.ctx, 'openFile');
    await openLinkTarget(h.ctx, { kind: 'note', path: 'Home.md', subpath: 'Step' }, 'a.md', async () => {});
    expect(spy).toHaveBeenCalledWith('Home.md', { line: 2 });
  });
  it('dispatches create and external targets', async () => {
    const h = createTestHost({ 'a.md': '' });
    const urls: string[] = [];
    await openLinkTarget(h.ctx, { kind: 'create', linkpath: 'B' }, 'a.md', async (u) => void urls.push(u));
    await openLinkTarget(h.ctx, { kind: 'external', url: 'https://a.b' }, 'a.md', async (u) => void urls.push(u));
    expect(h.opened).toEqual(['B.md']);
    expect(urls).toEqual(['https://a.b']);
  });
  it('opens an attachment link in its viewer, resolved against the files in the tree', async () => {
    const h = createTestHost({ 'exp/a.md': '' });
    h.ctx.treeFiles = () => ['exp/a.md', 'exp/resources/plate.csv', 'exp/resources/spec A.pdf'];
    const spy = vi.spyOn(h.ctx, 'openFile');
    await openLinkTarget(h.ctx, { kind: 'attachment', linkpath: 'plate.csv' }, 'exp/a.md', async () => {});
    expect(spy).toHaveBeenLastCalledWith('exp/resources/plate.csv');
    await openLinkTarget(h.ctx, { kind: 'attachment', linkpath: './resources/spec A.pdf', href: './resources/spec%20A.pdf' }, 'exp/a.md', async () => {});
    expect(spy).toHaveBeenLastCalledWith('exp/resources/spec A.pdf');
    await openLinkTarget(h.ctx, { kind: 'attachment', linkpath: 'gone.csv' }, 'exp/a.md', async () => {});
    expect(spy).toHaveBeenCalledTimes(2);
    expect(h.notes.at(-1)).toEqual({ kind: 'info', message: t('viewer.missing', 'gone.csv') });
  });
  it('reports a failed create instead of leaving an unhandled rejection', async () => {
    const h = createTestHost({ 'a.md': '' });
    h.vault.failNext('vault_modify', 'io');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      handleOpenLink(h.ctx, { kind: 'create', linkpath: 'x' }, 'a.md', async () => {}, { openFile: async () => {}, notify: () => {} }),
    ).resolves.toBeUndefined();
    err.mockRestore();
    expect(h.notes.at(-1)?.kind).toBe('error');
    expect(h.notes.at(-1)?.message).toContain(coreT('Command failed: {0}', '').trim());
  });
  it('still opens a note while the command context is loading', async () => {
    const openFile = vi.fn(async () => {});
    const notify = vi.fn();
    await handleOpenLink(undefined, { kind: 'note', path: 'Home.md' }, 'a.md', async () => {}, { openFile, notify });
    expect(openFile).toHaveBeenCalledWith('Home.md');
    await handleOpenLink(undefined, { kind: 'create', linkpath: 'x' }, 'a.md', async () => {}, { openFile, notify });
    expect(notify).toHaveBeenCalledWith('info', t('links.settingsNotReady'));
    expect(openFile).toHaveBeenCalledTimes(1);
  });
});
