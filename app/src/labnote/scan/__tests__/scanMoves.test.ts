import { afterEach, describe, expect, it, vi } from 'vitest';
import { entryEvents } from '../../commands/entryEvents';
import { NoteBusyError } from '../../noteErrors';
import { moveScansWithNote, planScanMoves, startScanMoves, type ScanMoveDeps } from '../../port/scanMoves';

const ID = 'LN-7K3M9QX2';
const SCAN = `${ID}_u1_p1_20261015.jpg`;
const SCAN2 = `${ID}_u2_p1_20261015.jpg`;
const E1 = 'labnote/001_e1';
const E2 = 'labnote/002_e2';

const note = (embeds: string) =>
  `---\nlabnote_id: ${ID}\n---\n\n#### Worksheet scans\n\n<!-- labnoteo-scan page=1/1 sha=abcdef012345 -->\n${embeds}\n`;

/** 보관함 흉내: 경로 → 글. 폴더는 파일 경로에서 나온다. */
function memVault(files: Record<string, string>, opts: { busy?: boolean } = {}) {
  const store = new Map(Object.entries(files));
  const fs = {
    read: vi.fn(async (path: string) => {
      const v = store.get(path);
      if (v === undefined) throw { kind: 'notFound', message: path };
      return v;
    }),
    list: vi.fn(async (dir: string) => {
      const names = new Set<string>();
      for (const p of store.keys()) if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split('/')[0]);
      return [...names];
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (!store.has(from)) throw { kind: 'notFound', message: from };
      if ([...store.keys()].some((k) => k.toLowerCase() === to.toLowerCase())) throw { kind: 'exists', message: to };
      store.set(to, store.get(from)!);
      store.delete(from);
    }),
  };
  const notices: Array<[string, string]> = [];
  const jobs: Array<Promise<unknown>> = [];
  const deps: ScanMoveDeps = {
    fs,
    host: {
      notify: (kind, message) => void notices.push([kind, message]),
      t: (key, ...args) => args.reduce<string>((s, a, i) => s.replace(`{${i}}`, String(a)), key),
    },
    processNote: vi.fn(async (path: string, fn: (text: string) => string) => {
      if (opts.busy) throw new NoteBusyError(path);
      const before = store.get(path)!;
      const after = fn(before);
      store.set(path, after);
      return after !== before;
    }),
    run: (fn) => void jobs.push(fn()),
    wait: async () => undefined,
  };
  return { store, fs, deps, notices, jobs };
}

/** 앱에서 한 이름 바꾸기: 노트를 옮기고 entryEvents 로 알린다. */
function renameNote(v: ReturnType<typeof memVault>, from: string, to: string, settled = Promise.resolve()): void {
  v.store.set(to, v.store.get(from)!);
  v.store.delete(from);
  entryEvents.emit({ kind: 'renamed', from, to, isDir: false, files: [{ from, to }], settled });
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

describe('planScanMoves (vendor barcode.test.ts)', () => {
  it("moves the note's own scans and keeps those whose name is taken in the new experiment", () => {
    const names = ['LN-AAAAAAAA_u1_p1_20261015.jpg', 'LN-AAAAAAAA_u2_p1_20261015.jpg', 'LN-BBBBBBBB_u1_p1_20261015.jpg', 'plot.png'];
    expect(planScanMoves(names, 'LN-AAAAAAAA', new Set(['LN-AAAAAAAA_u2_p1_20261015.jpg']))).toEqual({
      move: ['LN-AAAAAAAA_u1_p1_20261015.jpg'],
      keep: ['LN-AAAAAAAA_u2_p1_20261015.jpg'],
    });
  });
});

describe('moveScansWithNote', () => {
  it('moving a note to another experiment moves its scans and keeps names taken there', async () => {
    const v = memVault({
      [`${E1}/01_x.labnote.md`]: note(`![[${SCAN}|400]]\n![[${E1}/images/scans/${SCAN2}|400]]`),
      [`${E1}/images/scans/${SCAN}`]: 'mine',
      [`${E1}/images/scans/${SCAN2}`]: 'mine2',
      [`${E1}/images/scans/LN-BBBBBBBB_u1_p1_20261015.jpg`]: 'other note',
      [`${E2}/images/scans/${SCAN}`]: 'already there',
    });
    stop = startScanMoves(v.deps);
    renameNote(v, `${E1}/01_x.labnote.md`, `${E2}/01_x.labnote.md`);
    await Promise.all(v.jobs);

    // the name taken in e2 keeps its file; ours moves to a free `_2` name and the note embed points at it
    expect(v.store.get(`${E2}/images/scans/${SCAN}`)).toBe('already there');
    expect(v.store.get(`${E2}/images/scans/${ID}_u1_p1_20261015_2.jpg`)).toBe('mine');
    expect(v.store.get(`${E2}/images/scans/${SCAN2}`)).toBe('mine2');
    expect(v.store.has(`${E1}/images/scans/${SCAN}`)).toBe(false);
    expect(v.store.has(`${E1}/images/scans/${SCAN2}`)).toBe(false);
    // another note's scan stays
    expect(v.store.get(`${E1}/images/scans/LN-BBBBBBBB_u1_p1_20261015.jpg`)).toBe('other note');
    const text = v.store.get(`${E2}/01_x.labnote.md`)!;
    expect(text).toContain(`![[${E2}/images/scans/${ID}_u1_p1_20261015_2.jpg|400]]`);
    expect(text).toContain(`![[${E2}/images/scans/${SCAN2}|400]]`);
    expect(text).not.toContain(`![[${SCAN}|400]]`);
    expect(v.notices).toEqual([['info', `Moved 2 scan image(s) to ${E2}/images/scans with the note.`]]);
  });

  it('a rename inside the same experiment moves nothing', async () => {
    const v = memVault({
      [`${E1}/01_x.labnote.md`]: note(`![[${SCAN}|400]]`),
      [`${E1}/images/scans/${SCAN}`]: 'mine',
    });
    stop = startScanMoves(v.deps);
    renameNote(v, `${E1}/01_x.labnote.md`, `${E1}/02_x.labnote.md`);
    await Promise.all(v.jobs);
    expect(v.fs.rename).not.toHaveBeenCalled();
    expect(v.deps.processNote).not.toHaveBeenCalled();
    expect(v.store.get(`${E1}/images/scans/${SCAN}`)).toBe('mine');
    expect(v.notices).toEqual([]);
  });

  it('waits for the rename to settle before it moves anything', async () => {
    const v = memVault({
      [`${E1}/01_x.labnote.md`]: note(`![[${SCAN}|400]]`),
      [`${E1}/images/scans/${SCAN}`]: 'mine',
    });
    stop = startScanMoves(v.deps);
    let settle!: () => void;
    renameNote(v, `${E1}/01_x.labnote.md`, `${E2}/01_x.labnote.md`, new Promise<void>((r) => (settle = r)));
    await new Promise((r) => setTimeout(r, 0));
    expect(v.fs.rename).not.toHaveBeenCalled();
    settle();
    await Promise.all(v.jobs);
    expect(v.store.get(`${E2}/images/scans/${SCAN}`)).toBe('mine');
    // a name-only embed still finds the moved file: the note is not rewritten
    expect(v.deps.processNote).not.toHaveBeenCalled();
  });

  it('a note without an ID moves nothing', async () => {
    const v = memVault({
      [`${E2}/01_x.labnote.md`]: '---\ntitle: x\n---\n',
      [`${E1}/images/scans/${SCAN}`]: 'mine',
    });
    await moveScansWithNote(v.deps, `${E1}/01_x.labnote.md`, `${E2}/01_x.labnote.md`);
    expect(v.fs.rename).not.toHaveBeenCalled();
  });

  it('only lab notes are followed', async () => {
    const v = memVault({
      [`${E1}/plain.md`]: note(`![[${SCAN}|400]]`),
      [`${E1}/images/scans/${SCAN}`]: 'mine',
    });
    stop = startScanMoves(v.deps);
    renameNote(v, `${E1}/plain.md`, `${E2}/plain.md`);
    await Promise.all(v.jobs);
    expect(v.fs.rename).not.toHaveBeenCalled();
  });

  it('moves the scans back when the note stays busy, so its embeds never point at a missing file', async () => {
    const v = memVault(
      {
        [`${E2}/01_x.labnote.md`]: note(`![[${E1}/images/scans/${SCAN}|400]]`),
        [`${E1}/images/scans/${SCAN}`]: 'mine',
      },
      { busy: true },
    );
    await moveScansWithNote(v.deps, `${E1}/01_x.labnote.md`, `${E2}/01_x.labnote.md`);
    expect(v.store.get(`${E1}/images/scans/${SCAN}`)).toBe('mine');
    expect(v.store.has(`${E2}/images/scans/${SCAN}`)).toBe(false);
    expect(v.store.get(`${E2}/01_x.labnote.md`)).toContain(`![[${E1}/images/scans/${SCAN}|400]]`);
    expect(v.notices).toEqual([
      [
        'warn',
        `1 scan image(s) stayed in ${E1}/images/scans: a file with the same name is already in ${E2}/images/scans, or the move failed.`,
      ],
    ]);
  });

  it('stops listening when stopped', async () => {
    const v = memVault({
      [`${E1}/01_x.labnote.md`]: note(`![[${SCAN}|400]]`),
      [`${E1}/images/scans/${SCAN}`]: 'mine',
    });
    startScanMoves(v.deps)();
    renameNote(v, `${E1}/01_x.labnote.md`, `${E2}/01_x.labnote.md`);
    await Promise.all(v.jobs);
    expect(v.jobs).toHaveLength(0);
    expect(v.fs.rename).not.toHaveBeenCalled();
  });
});
