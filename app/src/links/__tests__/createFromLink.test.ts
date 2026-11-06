// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { createTestHost } from '../../labnote/__tests__/testHost';
import { createFromLink, newNotePath, openLinkTarget } from '../createFromLink';

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
  it('never overwrites a note that appeared meanwhile', async () => {
    const h = createTestHost({ 'notes/a.md': '', 'notes/x.md': 'keep' });
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
});
