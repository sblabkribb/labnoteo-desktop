import { describe, expect, it } from 'vitest';
import { createFakeVault } from '../../__tests__/fakeVault';
import { createJournalStore, JOURNAL_TEXT_CAP, planFromJournal } from '../journal';

describe('JournalStore', () => {
  it('drops texts above the cap and marks the journal not undoable', async () => {
    const v = createFakeVault({});
    const j = createJournalStore(v.invoke);
    await j.begin({ id: '1', from: 'a.md', to: 'b.md', isDir: false, moves: [{ from: 'a.md', to: 'b.md' }], status: 'planned', planned: [], undoable: true });
    const big = 'x'.repeat(JOURNAL_TEXT_CAP / 2 + 1);
    await j.note({ n: 0, path: 'n.md', before: big, after: big, status: 'ok' });
    expect(JSON.parse(v.journal.notes.get(0)!)).toEqual({ n: 0, path: 'n.md', status: 'ok' });
    expect(JSON.parse(v.journal.header!).undoable).toBe(false);
  });

  it('writes the header once per status change and one file per note', async () => {
    const v = createFakeVault({});
    const j = createJournalStore(v.invoke);
    await j.begin({ id: '1', from: 'a.md', to: 'b.md', isDir: false, moves: [], status: 'planned', planned: [], undoable: true });
    await j.note({ n: 0, path: 'n.md', before: 'a', after: 'b', status: 'writing' });
    await j.note({ n: 0, path: 'n.md', before: 'a', after: 'b', status: 'ok' });
    await j.setStatus('done');
    expect(v.log.filter((c) => c.cmd === 'link_journal_write_header').length).toBe(2);
    expect(v.log.filter((c) => c.cmd === 'link_journal_write_note').length).toBe(2);
    expect(await j.load()).toEqual({ header: expect.objectContaining({ status: 'done' }), notes: [{ n: 0, path: 'n.md', before: 'a', after: 'b', status: 'ok' }] });
  });

  it('a record rewritten for the same note does not count its texts twice', async () => {
    const v = createFakeVault({});
    const j = createJournalStore(v.invoke);
    await j.begin({ id: '1', from: 'a.md', to: 'b.md', isDir: false, moves: [], status: 'planned', planned: [], undoable: true });
    const third = 'x'.repeat(Math.floor(JOURNAL_TEXT_CAP / 3));
    await j.note({ n: 0, path: 'n.md', before: third, after: third, status: 'writing' });
    await j.note({ n: 0, path: 'n.md', before: third, after: third, status: 'ok' });
    expect(JSON.parse(v.journal.notes.get(0)!).before).toBe(third);
    expect(JSON.parse(v.journal.header!).undoable).toBe(true);
  });

  it('clear empties the store and the disk', async () => {
    const v = createFakeVault({});
    const j = createJournalStore(v.invoke);
    await j.begin({ id: '1', from: 'a.md', to: 'b.md', isDir: false, moves: [], status: 'planned', planned: [], undoable: true });
    await j.clear();
    expect(j.current()).toBeNull();
    expect(v.journal.header).toBeNull();
    expect(await j.load()).toBeNull();
  });
});

describe('planFromJournal', () => {
  it('rebuilds the before-universe from the inverse moves when the rename happened', () => {
    const plan = planFromJournal(
      {
        header: { id: '1', from: 'Home.md', to: 'Start.md', isDir: false, moves: [{ from: 'Home.md', to: 'Start.md' }], status: 'renamed', planned: [{ before: 'notes/n.md', after: 'notes/n.md' }], undoable: true },
        notes: [],
      },
      ['Start.md', 'notes/n.md'],
    );
    expect(plan.files).toEqual(['Home.md', 'notes/n.md']);
    expect(plan.moves).toEqual([{ from: 'Home.md', to: 'Start.md' }]);
    expect(plan.notes).toEqual([{ before: 'notes/n.md', after: 'notes/n.md', changed: 0, unsafe: 0 }]);
  });
  it('keeps the current universe while the rename is only planned', () => {
    const plan = planFromJournal(
      { header: { id: '1', from: 'Home.md', to: 'Start.md', isDir: false, moves: [{ from: 'Home.md', to: 'Start.md' }], status: 'planned', planned: [], undoable: true }, notes: [] },
      ['Home.md'],
    );
    expect(plan.files).toEqual(['Home.md']);
  });
});
