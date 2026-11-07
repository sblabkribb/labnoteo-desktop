// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { parseRaw } from '../../editor/documentIo';
import { t } from '../../i18n/t';
import { renameEntry } from '../../labnote/commands/fileOps';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import type { TreeEntry } from '../../tree/useTree';
import { linkIndex } from '../linkIndex';
import { recoverJournal, undoLastRename } from '../undoRename';

const entries = (h: TestHost): TreeEntry[] =>
  Object.keys(h.vault.files()).map((p) => ({ path: p, name: p.split('/').pop()!, isDir: false, depth: p.split('/').length - 1 }));
/** Re-prime the singleton index from the vault as it is now (tests that change files after createTestHost). */
function primeIndex(h: TestHost): void {
  linkIndex.clear();
  const files = h.vault.files();
  linkIndex.setFiles(Object.keys(files));
  for (const [p, text] of Object.entries(files)) if (p.endsWith('.md')) linkIndex.setNote(p, parseRaw(p, text).text);
  linkIndex.markReady();
}
const journalHeader = (h: TestHost) => JSON.parse(h.vault.journal.header!);
const journalNotes = (h: TestHost) => [...h.vault.journal.notes.entries()].sort(([a], [b]) => a - b).map(([, s]) => JSON.parse(s));

const hosts: TestHost[] = [];
const createHost = (...a: Parameters<typeof createTestHost>): TestHost => {
  const h = createTestHost(...a);
  hosts.push(h);
  return h;
};
afterEach(() => {
  for (const h of hosts.splice(0)) h.cleanup();
});

/** Task 24's happy path: Home.md -> Start.md with notes/n.md rewritten. */
async function renamed(files: Record<string, string> = { 'Home.md': '', 'notes/n.md': '[[Home]]' }): Promise<TestHost> {
  const h = createHost(files);
  h.answer.prompt('Start'); h.answer.pick('update');
  await renameEntry(h.ctx, 'Home.md', false, entries(h));
  return h;
}
const seed = async (h: TestHost, header: object, notes: object[] = []) => {
  await h.vault.invoke('link_journal_write_header', { content: JSON.stringify(header) });
  for (const n of notes) await h.vault.invoke('link_journal_write_note', { n: (n as { n: number }).n, content: JSON.stringify(n) });
};

describe('undoLastRename', () => {
  it('undo restores exact text and the old name', async () => {
    const h = await renamed();
    const r = await undoLastRename(h.ctx, h.ctx.links!.journal);
    expect(r).toEqual({ restored: ['notes/n.md'], skipped: [] });
    expect(h.vault.files()).toMatchObject({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    expect(h.vault.files()['Start.md']).toBeUndefined();
    expect(h.vault.journal.header).toBeNull();
    expect(h.notes.at(-1)).toEqual({ kind: 'info', message: t('links.undo.done') });
  });
  it('undo reverts only the links of notes edited since, and lists them', async () => {
    const h = await renamed();
    await h.vault.mem.write('notes/n.md', '[[Start]] more'); primeIndex(h);
    const r = await undoLastRename(h.ctx, h.ctx.links!.journal);
    expect(r!.skipped).toEqual(['notes/n.md']);
    expect(h.vault.files()['notes/n.md']).toBe('[[Home]] more');
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.undo.skipped', 'notes/n.md') });
  });
  it('undo also reverts links written after the rename', async () => {
    const h = await renamed();
    await h.vault.mem.write('b.md', 'later [[Start]]'); primeIndex(h);
    await undoLastRename(h.ctx, h.ctx.links!.journal);
    expect(h.vault.files()['b.md']).toBe('later [[Home]]');
  });
  it('undo maps journal paths back through a folder rename', async () => {
    const h = createHost({ 'notes/a.md': '', 'notes/n.md': 'x [[notes/a]]' });
    h.answer.prompt('docs'); h.answer.pick('update');
    await renameEntry(h.ctx, 'notes', true, [{ path: 'notes', name: 'notes', isDir: true, depth: 0 }, ...entries(h)]);
    expect(h.vault.files()['docs/n.md']).toBe('x [[docs/a]]');
    await undoLastRename(h.ctx, h.ctx.links!.journal);
    expect(h.vault.files()['notes/n.md']).toBe('x [[notes/a]]');
    expect(h.vault.files()['docs/n.md']).toBeUndefined();
  });
  it('undo refuses when the old name is taken', async () => {
    const h = await renamed();
    await h.vault.mem.write('Home.md', 'new'); primeIndex(h);
    expect(await undoLastRename(h.ctx, h.ctx.links!.journal)).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.undo.blocked') });
    expect(h.vault.files()['Start.md']).toBe('');
  });
  it('undo with no finished rename says so and changes nothing', async () => {
    const h = createHost({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    expect(await undoLastRename(h.ctx, h.ctx.links!.journal)).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'info', message: t('links.undo.none') });
    expect(h.vault.files()).toEqual({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
  });
});

describe('recoverJournal', () => {
  it('recovery after a restart finishes an interrupted run', async () => {
    const h = createHost({ 'Start.md': '', 'notes/n.md': '[[Home]]' }); // a fresh index holding only the after-universe
    await seed(h, { id: '1', from: 'Home.md', to: 'Start.md', isDir: false, moves: [{ from: 'Home.md', to: 'Start.md' }], status: 'renamed', planned: [{ before: 'notes/n.md', after: 'notes/n.md' }], undoable: true });
    h.answer.confirm(true);
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.asked.confirm[0].message).toBe(t('links.recover.confirm', '1'));
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]]');
    expect(journalHeader(h).status).toBe('done');
  });
  it("recovery re-checks a 'writing' record and keeps it undoable", async () => {
    const h = createHost({ 'Start.md': '', 'notes/n.md': '[[Start]]' }); // written, then the app died before 'ok'
    await seed(
      h,
      { id: '1', from: 'Home.md', to: 'Start.md', isDir: false, moves: [{ from: 'Home.md', to: 'Start.md' }], status: 'renamed', planned: [{ before: 'notes/n.md', after: 'notes/n.md' }], undoable: true },
      [{ n: 0, path: 'notes/n.md', before: '[[Home]]', after: '[[Start]]', status: 'writing' }],
    );
    h.answer.confirm(true);
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]]');
    expect(journalNotes(h)).toEqual([{ n: 0, path: 'notes/n.md', before: '[[Home]]', after: '[[Start]]', status: 'ok' }]);
  });
  it("recovery leaves an edited note that already holds a hijack rewrite alone and reports it", async () => {
    // a.md -> b.md with other/b.md present; x.md was rewritten, then edited, then the app died before 'ok'.
    const h = createHost({ 'b.md': '', 'other/b.md': '', 'x.md': '[[b]] [[other/b]] more' });
    await seed(h, { id: '1', from: 'a.md', to: 'b.md', isDir: false, moves: [{ from: 'a.md', to: 'b.md' }], status: 'renamed', planned: [{ before: 'x.md', after: 'x.md' }], undoable: true }, [
      { n: 0, path: 'x.md', before: '[[a]] [[b]]', after: '[[b]] [[other/b]]', status: 'writing' },
    ]);
    h.answer.confirm(true);
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.vault.files()['x.md']).toBe('[[b]] [[other/b]] more');
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.rename.partial', `x.md (${t('links.reason.ambiguous')})`) });
  });
  it("recovery of a 'writing' record without texts leaves an ambiguous note alone and reports it", async () => {
    const h = createHost({ 'b.md': '', 'other/b.md': '', 'x.md': '[[b]] [[other/b]]' });
    await seed(h, { ...{ id: '1', from: 'a.md', to: 'b.md', isDir: false, moves: [{ from: 'a.md', to: 'b.md' }], status: 'renamed', planned: [{ before: 'x.md', after: 'x.md' }], undoable: true }, undoable: false }, [{ n: 0, path: 'x.md', status: 'writing' }]);
    h.answer.confirm(true);
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.vault.files()['x.md']).toBe('[[b]] [[other/b]]');
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.rename.partial', `x.md (${t('links.reason.ambiguous')})`) });
  });
  it("recovery of a 'writing' record still holding its before text rewrites it, hijack pins included", async () => {
    const h = createHost({ 'b.md': '', 'other/b.md': '', 'x.md': '[[a]] [[b]]' });
    await seed(h, { id: '1', from: 'a.md', to: 'b.md', isDir: false, moves: [{ from: 'a.md', to: 'b.md' }], status: 'renamed', planned: [{ before: 'x.md', after: 'x.md' }], undoable: true }, [
      { n: 0, path: 'x.md', before: '[[a]] [[b]]', after: '[[b]] [[other/b]]', status: 'writing' },
    ]);
    h.answer.confirm(true);
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.vault.files()['x.md']).toBe('[[b]] [[other/b]]');
    expect(journalNotes(h)).toEqual([{ n: 0, path: 'x.md', before: '[[a]] [[b]]', after: '[[b]] [[other/b]]', status: 'ok' }]);
  });
  it('recovery clears a plan whose rename never happened', async () => {
    const h = createHost({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    await seed(h, { id: '1', from: 'Home.md', to: 'Start.md', isDir: false, moves: [{ from: 'Home.md', to: 'Start.md' }], status: 'planned', planned: [{ before: 'notes/n.md', after: 'notes/n.md' }], undoable: true });
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.asked.confirm).toEqual([]);
    expect(h.vault.journal.header).toBeNull();
  });
  it('declining recovery clears the journal and warns', async () => {
    const h = createHost({ 'Start.md': '', 'notes/n.md': '[[Home]]' });
    await seed(h, { id: '1', from: 'Home.md', to: 'Start.md', isDir: false, moves: [{ from: 'Home.md', to: 'Start.md' }], status: 'renamed', planned: [{ before: 'notes/n.md', after: 'notes/n.md' }], undoable: true });
    h.answer.confirm(false);
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.vault.journal.header).toBeNull();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.renamed.linksNotUpdated') });
  });
  it('a finished journal is kept for undo without asking', async () => {
    const h = await renamed();
    await recoverJournal(h.ctx, h.ctx.links!.journal);
    expect(h.asked.confirm).toEqual([]);
    expect(journalHeader(h)).toMatchObject({ status: 'done', undoable: true });
  });
});
