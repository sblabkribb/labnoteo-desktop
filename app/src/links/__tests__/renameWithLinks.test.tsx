// @vitest-environment jsdom
import { undo } from '@codemirror/commands';
import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRaw } from '../../editor/documentIo';
import type { EditorHandle } from '../../editor/Editor';
import { t } from '../../i18n/t';
import { renameEntry } from '../../labnote/commands/fileOps';
import { runCommand } from '../../labnote/commands/runCommand';
import { registerOpenNote } from '../../labnote/openNotes';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import type { TreeEntry } from '../../tree/useTree';
import { linkIndex } from '../linkIndex';
import { LinkOpsBusyError, linkOps, READY_WAIT_MS, reasonOf, renameEvents, renameWithLinks, rewritePlanned } from '../renameWithLinks';

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
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>): TestHost => {
  const h = createTestHost(...a);
  hosts.push(h);
  return h;
};
afterEach(() => {
  vi.useRealTimers();
  for (const h of hosts.splice(0)) h.cleanup();
});

describe('renameEntry with links', () => {
  it('renames and updates links, journalled', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    h.answer.prompt('Start'); h.answer.pick('update');
    expect(await renameEntry(h.ctx, 'Home.md', false, entries(h))).toBe('Start.md');
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]]');
    expect(h.asked.pick[0].items.map((i) => i.label)).toEqual([t('links.rename.update', '1', '1'), t('links.rename.skip')]);
    expect(h.notes.at(-1)).toEqual({ kind: 'info', message: t('links.rename.done', '1', '1') });
    expect(journalHeader(h)).toMatchObject({ status: 'done', from: 'Home.md', to: 'Start.md', planned: [{ before: 'notes/n.md', after: 'notes/n.md' }], undoable: true });
    expect(journalNotes(h)).toEqual([{ n: 0, path: 'notes/n.md', before: '[[Home]]', after: '[[Start]]', status: 'ok' }]);
  });

  it('a rename while the index is loading waits and still rewrites the links', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    linkIndex.clear(); // as on vault open: nothing loaded yet
    h.answer.prompt('Start'); h.answer.pick('update');
    const running = renameEntry(h.ctx, 'Home.md', false, entries(h));
    await waitFor(() => expect(h.notes).toContainEqual({ kind: 'info', message: t('links.waiting') }));
    expect(h.vault.log.some((c) => c.cmd === 'vault_rename')).toBe(false);
    primeIndex(h); // the load finishes
    expect(await running).toBe('Start.md');
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]]');
    expect(h.notes).not.toContainEqual({ kind: 'info', message: t('fileOps.renamed') });
  });

  it('a rename refuses when the index never becomes ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    linkIndex.clear();
    h.answer.prompt('Start');
    const running = renameEntry(h.ctx, 'Home.md', false, entries(h));
    await vi.advanceTimersByTimeAsync(READY_WAIT_MS);
    expect(await running).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.notReady') });
    expect(h.vault.log.some((c) => c.cmd === 'vault_rename')).toBe(false);
    expect(h.vault.files()['Home.md']).toBe('');
  });

  it('refuses a name a wikilink cannot express when links would be rewritten', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    h.answer.prompt('PCR #2');
    expect(await renameEntry(h.ctx, 'Home.md', false, entries(h))).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.rename.badName') });
    expect(h.vault.files()['Home.md']).toBe('');
  });

  it('a failed rename touches no note', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    h.answer.prompt('Start'); h.answer.pick('update');
    h.vault.failNext('vault_rename', 'exists');
    expect(await renameEntry(h.ctx, 'Home.md', false, entries(h))).toBeUndefined();
    expect(h.vault.log.some((c) => c.cmd === 'vault_rename')).toBe(true);
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.exists') });
    expect(h.vault.log.filter((c) => c.cmd === 'vault_modify')).toEqual([]);
    expect(h.vault.journal.header).toBeNull();
  });

  it('one failed write does not stop the others; the report lists it and Retry fixes it', async () => {
    const h = host({ 'Home.md': '', 'a.md': '[[Home]]', 'b.md': '[[Home]]' });
    h.answer.prompt('Start'); h.answer.pick('update');
    h.vault.failNext('vault_modify', 'io'); // a.md is written first (key order)
    h.answer.confirm(true); // Retry
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    expect(h.asked.confirm[0].message).toBe(t('links.rename.partial', `a.md (${t('links.reason.io')})`));
    expect(h.asked.confirm[0].opts?.confirmLabel).toBe(t('links.rename.retry'));
    expect(h.vault.files()['a.md']).toBe('[[Start]]');
    expect(h.vault.files()['b.md']).toBe('[[Start]]');
    expect(journalNotes(h).map((r) => [r.path, r.status])).toEqual([['a.md', 'ok'], ['b.md', 'ok']]);
  });

  it('CRLF and BOM survive a rename', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '﻿[[Home]]\r\nx\r\n' });
    h.answer.prompt('Start'); h.answer.pick('update');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    expect(h.vault.files()['notes/n.md']).toBe('﻿[[Start]]\r\nx\r\n');
  });

  it('a dirty open referrer keeps unsaved typing and gets one undo step', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    const m = await h.mount('notes/n.md');
    const v = m.view();
    v.dispatch({ changes: { from: 8, insert: 'X' } }); // unsaved
    h.answer.prompt('Start'); h.answer.pick('update');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    expect(v.state.doc.toString()).toBe('[[Start]]X');
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]]X');
    undo(v);
    expect(v.state.doc.toString()).toBe('[[Home]]X');
  });

  it('a busy open referrer is reported busy and not written', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    // An editor still reading its note: busy, no view and no buffer text yet (reads fall through to the disk).
    const busy = { busy: () => true, view: () => undefined, rawText: () => undefined } as unknown as EditorHandle;
    const off = registerOpenNote('notes/n.md', busy);
    try {
      h.answer.prompt('Start'); h.answer.pick('update'); h.answer.confirm(false);
      await renameEntry(h.ctx, 'Home.md', false, entries(h));
      expect(h.vault.files()['notes/n.md']).toBe('[[Home]]');
      expect(h.asked.confirm[0].message).toBe(t('links.rename.partial', `notes/n.md (${t('links.reason.busy')})`));
    } finally {
      off();
    }
  });

  it('a referrer deleted mid-run is reported gone and not recreated', async () => {
    let removed = false;
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' }, {}, {
      invoke: (base) => async (cmd, args) => {
        if (cmd === 'vault_modify' && (args as { path: string }).path === 'notes/n.md' && !removed) {
          removed = true;
          await base('vault_remove', { path: 'notes/n.md' });
        }
        return base(cmd, args);
      },
    });
    h.answer.prompt('Start'); h.answer.pick('update'); h.answer.confirm(false);
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    expect(h.vault.files()['notes/n.md']).toBeUndefined();
    expect(h.asked.confirm[0].message).toBe(t('links.rename.partial', `notes/n.md (${t('links.reason.gone')})`));
    expect(journalNotes(h)).toMatchObject([{ path: 'notes/n.md', status: 'failed', reason: 'gone' }]);
  });

  it("Rename only keeps today's behaviour", async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    h.answer.prompt('Start'); h.answer.pick('skip');
    expect(await renameEntry(h.ctx, 'Home.md', false, entries(h))).toBe('Start.md');
    expect(h.vault.log.filter((c) => c.cmd === 'vault_modify')).toEqual([]);
    expect(h.vault.files()['notes/n.md']).toBe('[[Home]]');
    expect(h.notes.at(-1)).toEqual({ kind: 'info', message: t('fileOps.renamed.linksNotUpdated') });
  });

  it('Esc on the pick dialog cancels the whole rename', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    h.answer.prompt('Start');
    expect(await renameEntry(h.ctx, 'Home.md', false, entries(h))).toBeUndefined();
    expect(h.vault.files()['Home.md']).toBe('');
    expect(h.vault.log.some((c) => c.cmd === 'vault_rename')).toBe(false);
  });

  it('a case-only rename asks nothing', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    h.answer.prompt('home');
    expect(await renameEntry(h.ctx, 'Home.md', false, entries(h))).toBe('home.md');
    expect(h.asked.pick).toEqual([]);
    expect(h.notes.at(-1)).toEqual({ kind: 'info', message: t('fileOps.renamed') });
    expect(h.vault.files()['notes/n.md']).toBe('[[Home]]');
  });

  it('a note with no referrers gets a plain toast', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': 'no links' });
    h.answer.prompt('Start');
    expect(await renameEntry(h.ctx, 'Home.md', false, entries(h))).toBe('Start.md');
    expect(h.asked.pick).toEqual([]);
    expect(h.notes.at(-1)).toEqual({ kind: 'info', message: t('fileOps.renamed') });
  });

  it('every successful rename is announced with its moves', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    const seen: unknown[] = [];
    const off = renameEvents.subscribe((m) => void seen.push(m));
    h.answer.prompt('Start'); h.answer.pick('skip');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    off();
    expect(seen).toEqual([[{ from: 'Home.md', to: 'Start.md' }]]);
  });

  it('a rename with link updates is announced right after vault_rename, before any other await', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    const lastCmd: string[] = [];
    const off = renameEvents.subscribe(() => void lastCmd.push(h.vault.log.at(-1)!.cmd));
    h.answer.prompt('Start'); h.answer.pick('update');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    off();
    // a watcher 'removed' for the old path that lands in a later await must find the history already mapped
    expect(lastCmd).toEqual(['vault_rename']);
  });

  it('a second rename while the first waits for the index is refused busy; the first journal is intact', async () => {
    const h = host({ 'Home.md': '', 'Other.md': '', 'notes/n.md': '[[Home]] [[Other]]' });
    linkIndex.clear(); // as on vault open: nothing loaded yet
    h.answer.prompt('Start', 'Next'); h.answer.pick('update', 'update');
    const first = renameEntry(h.ctx, 'Home.md', false, entries(h));
    await waitFor(() => expect(h.notes).toContainEqual({ kind: 'info', message: t('links.waiting') }));
    expect(linkOps.running()).toBe(true);
    const second = renameEntry(h.ctx, 'Other.md', false, entries(h));
    primeIndex(h); // the load finishes
    expect(await second).toBeUndefined();
    expect(h.notes).toContainEqual({ kind: 'warn', message: t('links.busy') });
    expect(await first).toBe('Start.md');
    expect(h.vault.files()['Other.md']).toBe('');
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]] [[Other]]');
    expect(h.vault.log.filter((c) => c.cmd === 'link_journal_clear')).toHaveLength(1);
    expect(journalHeader(h)).toMatchObject({ status: 'done', from: 'Home.md', to: 'Start.md' });
    expect(journalNotes(h)).toEqual([{ n: 0, path: 'notes/n.md', before: '[[Home]] [[Other]]', after: '[[Start]] [[Other]]', status: 'ok' }]);
    expect(linkOps.running()).toBe(false);
  });

  it('renameWithLinks refuses while another rename holds the link lock and leaves the journal alone', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    const session = linkOps.claim()!;
    try {
      expect(linkOps.claim()).toBeUndefined();
      const plan = { from: 'Home.md', to: 'Start.md', isDir: false, caseOnly: false, moves: [{ from: 'Home.md', to: 'Start.md' }], files: ['Home.md', 'notes/n.md'], notes: [{ before: 'notes/n.md', after: 'notes/n.md', changed: 1, unsafe: 0 }], linkCount: 1, hasWikiRewrites: true };
      await expect(renameWithLinks(h.ctx, plan, h.ctx.links!.journal)).rejects.toBeInstanceOf(LinkOpsBusyError);
      await expect(rewritePlanned(h.ctx, plan, ['notes/n.md'], h.ctx.links!.journal)).rejects.toBeInstanceOf(LinkOpsBusyError);
      expect(h.vault.log.filter((c) => c.cmd.startsWith('link_journal') || c.cmd === 'vault_rename')).toEqual([]);
    } finally {
      session.release();
    }
    expect(linkOps.running()).toBe(false);
  });

  it('a rename aborted before vault_rename keeps the previous rename undoable', async () => {
    const h = host({ 'Home.md': '', 'Other.md': '', 'Taken.md': '', 'notes/n.md': '[[Home]] [[Other]]' });
    h.answer.prompt('Start'); h.answer.pick('update');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    const header = journalHeader(h);
    const notes = journalNotes(h);
    h.answer.prompt('Taken'); h.answer.pick('update');
    expect(await renameEntry(h.ctx, 'Other.md', false, entries(h))).toBeUndefined();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('fileOps.exists') });
    expect(journalHeader(h)).toEqual(header);
    expect(journalNotes(h)).toEqual(notes);
    expect(h.ctx.links!.journal.current()).toEqual({ header, notes });
  });

  it('a dirty open referrer that is not the active note keeps its unsaved typing', async () => {
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' });
    const m = await h.mount('notes/n.md');
    h.setActive(undefined); // not flushed by renameEntry
    const v = m.view();
    v.dispatch({ changes: { from: 8, insert: 'X' } }); // unsaved
    expect(h.vault.files()['notes/n.md']).toBe('[[Home]]');
    h.answer.prompt('Start'); h.answer.pick('update');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    expect(v.state.doc.toString()).toBe('[[Start]]X');
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]]X');
    expect(journalNotes(h)).toEqual([{ n: 0, path: 'notes/n.md', before: '[[Home]]X', after: '[[Start]]X', status: 'ok' }]);
    undo(v);
    expect(v.state.doc.toString()).toBe('[[Home]]X');
  });

  it('after a compare-and-swap retry the journal holds the text that was actually written', async () => {
    let raced = false;
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' }, {}, {
      invoke: (base) => async (cmd, args) => {
        if (cmd === 'vault_modify' && !raced) {
          raced = true;
          await base('vault_write', { path: 'notes/n.md', content: '[[Home]] edited' }); // another writer wins
        }
        return base(cmd, args);
      },
    });
    h.answer.prompt('Start'); h.answer.pick('update');
    await renameEntry(h.ctx, 'Home.md', false, entries(h));
    expect(h.vault.files()['notes/n.md']).toBe('[[Start]] edited');
    expect(journalNotes(h)).toEqual([{ n: 0, path: 'notes/n.md', before: '[[Home]] edited', after: '[[Start]] edited', status: 'ok' }]);
  });

  it('commands wait while links are being updated', async () => {
    const gate = deferred<void>();
    const h = host({ 'Home.md': '', 'notes/n.md': '[[Home]]' }, {}, {
      invoke: (base) => async (cmd, args) => {
        if (cmd === 'vault_modify') await gate.promise;
        return base(cmd, args);
      },
    });
    h.answer.prompt('Start'); h.answer.pick('update');
    const running = renameEntry(h.ctx, 'Home.md', false, entries(h));
    await waitFor(() => expect(linkOps.running()).toBe(true));
    const cmd = vi.fn();
    await runCommand(h.ctx, cmd);
    expect(cmd).not.toHaveBeenCalled();
    expect(h.notes.at(-1)).toEqual({ kind: 'warn', message: t('links.busy') });
    gate.resolve();
    await running;
    expect(linkOps.running()).toBe(false);
  });
});

describe('reasonOf', () => {
  it('maps a notFound error to gone and anything unknown to io', () => {
    expect(reasonOf({ kind: 'notFound', message: 'x' })).toBe('gone');
    expect(reasonOf(new Error('boom'))).toBe('io');
  });
});
