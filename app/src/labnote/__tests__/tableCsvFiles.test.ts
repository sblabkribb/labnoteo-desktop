// @vitest-environment jsdom
import { MemFileSystem } from '@labnoteo/core';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import { setLang } from '../../i18n/lang';
import { createAppHost } from '../host/createAppHost';
import { notify } from '../host/toastStore';
import { coreT } from '../i18n';
import { listFileNames, moveTableCsvs, offerTableCsvCleanupOnDelete, trashTableCsvs } from '../port/tableCsvFiles';

vi.mock('../host/toastStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host/toastStore')>()),
  notify: vi.fn(),
}));

function memAppFs(trash: (path: string) => Promise<void>): AppFs {
  return Object.assign(new MemFileSystem(), { rename: vi.fn(async () => {}), trash: vi.fn(trash) }) as unknown as AppFs;
}

afterEach(() => {
  vi.mocked(notify).mockClear();
  setLang('ko');
});

describe('host.notify hold time', () => {
  it('forwards { ms } to the toast store', () => {
    const host = createAppHost({ fs: memAppFs(async () => {}), editTarget: () => undefined, openFile: async () => {} });
    host.notify('warn', 'locked', { ms: 15000 });
    expect(notify).toHaveBeenCalledWith('warn', 'locked', { ms: 15000 });
  });

  it('without opts keeps the default time', () => {
    const host = createAppHost({ fs: memAppFs(async () => {}), editTarget: () => undefined, openFile: async () => {} });
    host.notify('info', 'hi');
    expect(notify).toHaveBeenCalledWith('info', 'hi', undefined);
  });
});

describe('trashTableCsvs', () => {
  it('trashes each name under dir and returns how many threw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fs = memAppFs(async (path) => {
      if (path.endsWith('b.csv')) throw new Error('busy');
    });
    const kept = await trashTableCsvs({ fs }, 'Exp/notes', ['a.csv', 'b.csv', 'c.csv']);
    expect(kept).toBe(1);
    expect(vi.mocked(fs.trash).mock.calls.map((c) => c[0])).toEqual(['Exp/notes/a.csv', 'Exp/notes/b.csv', 'Exp/notes/c.csv']);
    warn.mockRestore();
  });

  it('returns 0 when every move succeeds', async () => {
    const fs = memAppFs(async () => {});
    expect(await trashTableCsvs({ fs }, 'd', ['x.csv'])).toBe(0);
  });
});

describe('listFileNames', () => {
  const names = Array.from({ length: 12 }, (_, i) => `f${i + 1}.csv`);
  const shown = names.slice(0, 10).join('\n');

  it('lists the first max names and counts the rest (en)', () => {
    setLang('en');
    expect(listFileNames({ t: coreT }, names, 10)).toBe(`${shown} (+2 more)`);
  });

  it('uses the vendor ko text', () => {
    setLang('ko');
    expect(listFileNames({ t: coreT }, names, 10)).toBe(`${shown} 외 2개`);
  });

  it('lists all names when within max', () => {
    expect(listFileNames({ t: coreT }, names.slice(0, 3))).toBe('f1.csv\nf2.csv\nf3.csv');
  });
});

/** A MemFileSystem whose rename moves the file (refusing a taken target) and whose trash removes it. */
function movingFs(files: Record<string, string>): AppFs {
  const mem = new MemFileSystem();
  for (const [p, c] of Object.entries(files)) void mem.write(p, c);
  return Object.assign(mem, {
    rename: vi.fn(async (from: string, to: string) => {
      if (await mem.exists(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const text = await mem.read(from);
      await mem.remove(from);
      await mem.write(to, text);
    }),
    trash: vi.fn(async (path: string) => mem.remove(path)),
  }) as unknown as AppFs;
}

describe('moveTableCsvs', () => {
  it("a rename in place takes the note's table CSVs to the new name", async () => {
    const fs = movingFs({
      'E/001_Y.labnote.md': 'n',
      'E/001_X.labnote_table1.csv': 'a',
      'E/001_X.labnote_table2.csv': 'b',
      'E/002_Z.labnote_table1.csv': 'z',
    });
    const names = new Set(await fs.list('E'));
    const out = await moveTableCsvs({ fs }, { from: 'E', to: 'E' }, { from: '001_X.labnote.md', to: '001_Y.labnote.md' }, names);
    expect(out).toEqual({ moved: 2, skipped: 0, kept: [] });
    expect((await fs.list('E')).sort()).toEqual(
      ['001_Y.labnote.md', '001_Y.labnote_table1.csv', '001_Y.labnote_table2.csv', '002_Z.labnote_table1.csv'].sort(),
    );
    expect(await fs.read('E/001_Y.labnote_table2.csv')).toBe('b');
    expect(names.has('001_Y.labnote_table1.csv')).toBe(true);
    expect(names.has('001_X.labnote_table1.csv')).toBe(false);
  });

  it('a CSV whose new name is taken stays and is reported as kept', async () => {
    const fs = movingFs({
      'E/001_X.labnote_table1.csv': 'mine',
      'E/001_X.labnote_table2.csv': 'mine2',
      'E/001_Y.labnote_table1.csv': 'other',
    });
    const out = await moveTableCsvs({ fs }, { from: 'E', to: 'E' }, { from: '001_X.labnote.md', to: '001_Y.labnote.md' }, new Set(await fs.list('E')));
    expect(out).toEqual({ moved: 1, skipped: 1, kept: ['001_X.labnote_table1.csv'] });
    expect(await fs.read('E/001_Y.labnote_table1.csv')).toBe('other');
    expect(await fs.read('E/001_X.labnote_table1.csv')).toBe('mine');
    expect(await fs.read('E/001_Y.labnote_table2.csv')).toBe('mine2');
  });

  it('a failed rename keeps the CSV and counts it as skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fs = movingFs({ 'E/001_X.labnote_table1.csv': 'a' });
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    const out = await moveTableCsvs({ fs }, { from: 'E', to: 'E' }, { from: '001_X.labnote.md', to: '001_Y.labnote.md' }, new Set(await fs.list('E')));
    expect(out).toEqual({ moved: 0, skipped: 1, kept: ['001_X.labnote_table1.csv'] });
    expect(await fs.exists('E/001_X.labnote_table1.csv')).toBe(true);
    warn.mockRestore();
  });

  it('a note moved to another folder takes its CSVs along; a name taken there stays', async () => {
    const fs = movingFs({
      'A/001_X.labnote_table1.csv': '1',
      'A/001_X.labnote_table2.csv': '2',
      'B/001_X.labnote_table2.csv': 'theirs',
    });
    const names = new Set(await fs.list('A'));
    const toNames = new Set(await fs.list('B'));
    const out = await moveTableCsvs({ fs }, { from: 'A', to: 'B' }, { from: '001_X.labnote.md', to: '001_X.labnote.md' }, names, toNames);
    expect(out).toEqual({ moved: 1, skipped: 1, kept: ['001_X.labnote_table2.csv'] });
    expect(await fs.read('B/001_X.labnote_table1.csv')).toBe('1');
    expect(await fs.read('B/001_X.labnote_table2.csv')).toBe('theirs');
    expect(await fs.read('A/001_X.labnote_table2.csv')).toBe('2');
    expect(toNames.has('001_X.labnote_table1.csv')).toBe(true);
  });

  it('the same folder and name moves nothing', async () => {
    const fs = movingFs({ 'E/001_X.labnote_table1.csv': 'a' });
    const out = await moveTableCsvs({ fs }, { from: 'E', to: 'E' }, { from: '001_X.labnote.md', to: '001_X.labnote.md' }, new Set(await fs.list('E')));
    expect(out).toEqual({ moved: 0, skipped: 0, kept: [] });
    expect(fs.rename).not.toHaveBeenCalled();
  });
});

describe('offerTableCsvCleanupOnDelete', () => {
  function hostOf(fs: AppFs, answer: boolean) {
    return {
      fs,
      t: coreT,
      confirm: vi.fn(async (_message: string, _opts?: { confirmLabel?: string; destructive?: boolean }) => answer),
      notify: vi.fn(),
    };
  }

  it('asks once for a deleted note with 2 CSVs; accepting trashes both and says how many', async () => {
    setLang('en');
    const fs = movingFs({ 'E/001_X.labnote_table1.csv': 'a', 'E/001_X.labnote_table2.csv': 'b', 'E/002_Y.labnote.md': 'y' });
    const host = hostOf(fs, true);
    await offerTableCsvCleanupOnDelete(host, ['E/001_X.labnote.md']);
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect(host.confirm.mock.calls[0][0]).toContain('001_X.labnote_table1.csv\n001_X.labnote_table2.csv');
    expect(host.confirm.mock.calls[0][1]).toEqual({ confirmLabel: 'Move to trash', destructive: true });
    expect(vi.mocked(fs.trash).mock.calls.map((c) => c[0])).toEqual(['E/001_X.labnote_table1.csv', 'E/001_X.labnote_table2.csv']);
    expect(host.notify).toHaveBeenCalledWith('info', '2 CSV file(s) moved to the trash.');
    expect(host.notify).toHaveBeenCalledTimes(1);
  });

  it('declining trashes nothing', async () => {
    const fs = movingFs({ 'E/001_X.labnote_table1.csv': 'a' });
    const host = hostOf(fs, false);
    await offerTableCsvCleanupOnDelete(host, ['E/001_X.labnote.md']);
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect(fs.trash).not.toHaveBeenCalled();
    expect(host.notify).not.toHaveBeenCalled();
  });

  it('a note that is back keeps its CSVs and nothing is asked', async () => {
    const fs = movingFs({ 'E/001_X.labnote.md': 'back', 'E/001_X.labnote_table1.csv': 'a' });
    const host = hostOf(fs, true);
    await offerTableCsvCleanupOnDelete(host, ['E/001_X.labnote.md']);
    expect(host.confirm).not.toHaveBeenCalled();
    expect(fs.trash).not.toHaveBeenCalled();
  });

  it('a CSV that cannot be trashed is counted in a warning', async () => {
    setLang('en');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fs = movingFs({ 'E/001_X.labnote_table1.csv': 'a', 'E/001_X.labnote_table2.csv': 'b' });
    vi.mocked(fs.trash).mockRejectedValueOnce(new Error('busy'));
    const host = hostOf(fs, true);
    await offerTableCsvCleanupOnDelete(host, ['E/001_X.labnote.md']);
    expect(host.notify).toHaveBeenCalledWith('info', '1 CSV file(s) moved to the trash.');
    expect(host.notify).toHaveBeenCalledWith('warn', '1 CSV file(s) could not be moved to the trash.');
    warn.mockRestore();
  });
});
