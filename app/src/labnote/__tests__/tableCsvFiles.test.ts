// @vitest-environment jsdom
import { MemFileSystem } from '@labnoteo/core';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import { setLang } from '../../i18n/lang';
import { createAppHost } from '../host/createAppHost';
import { notify } from '../host/toastStore';
import { coreT } from '../i18n';
import { listFileNames, trashTableCsvs } from '../port/tableCsvFiles';

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
