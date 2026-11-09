// @vitest-environment jsdom
/**
 * 앱에서 한 이름 바꾸기와 삭제의 항목 알림(plan SP5 Task 26, D14). `files` 는 작업 전에 뜬 목록이라 .json 과 폴더 속
 * 파일까지 담는다. 이름 바꾸기의 `settled` 는 링크 고침이 끝난 뒤(journal 'done') 풀린다: 그 전에는 뒤따르는 대화상자가 없다.
 */
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { planRename } from '../../../links/planRename';
import { renameWithLinks } from '../../../links/renameWithLinks';
import { LOCAL, NOTE, SAMPLE_VAULT } from '../../../samples/__tests__/fixtures';
import { entryEvents, listFilesUnder, MAX_LIST_DEPTH, type EntryEvent } from '../entryEvents';
import { deleteEntry, renameEntry } from '../fileOps';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

let hosts: TestHost[] = [];
let offs: Array<() => void> = [];
// 붙잡아 둔 흐름: 단언이 실패해도 풀어 다음 테스트에 링크 잠금이 남지 않게 한다
let holds: Array<() => void> = [];
function hold(): Promise<void> {
  return new Promise<void>((r) => holds.push(r));
}
function setup(files: Record<string, string> = SAMPLE_VAULT): { th: TestHost; seen: EntryEvent[] } {
  const th = createTestHost(files);
  hosts.push(th);
  const seen: EntryEvent[] = [];
  offs.push(entryEvents.subscribe((e) => seen.push(e)));
  return { th, seen };
}
afterEach(async () => {
  for (const r of holds.splice(0)) r();
  await new Promise((r) => setTimeout(r, 0));
  for (const off of offs.splice(0)) off();
  for (const th of hosts.splice(0)) th.cleanup();
  vi.restoreAllMocks();
});

async function planFor(th: TestHost, from: string, to: string, isDir: boolean) {
  const links = th.ctx.links!;
  return planRename({
    from,
    to,
    isDir,
    index: links.index,
    images: links.images,
    read: (p) => th.host.fs.read(p),
    search: links.search,
    activePath: undefined,
  });
}

describe('listFilesUnder', () => {
  it('lists every file under a folder, any extension, nested folders included', async () => {
    const { th } = setup();
    const files = await listFilesUnder(th.host.fs, 'labnote/061_PCR');
    expect([...files].sort()).toEqual(
      ['labnote/061_PCR/001_clone.labnote.md', 'labnote/061_PCR/README.labnote.md', `${LOCAL}/DNA.json`].sort(),
    );
  });

  it('stops at a folder that loops back on itself (a junction to an ancestor)', async () => {
    let calls = 0;
    const fs = {
      list: async (p: string) => {
        if (++calls > 10000) throw new Error('runaway');
        if (p.endsWith('.md')) throw new Error('not a folder');
        return ['loop', 'a.md'];
      },
      read: async (p: string) => {
        if (p.endsWith('a.md')) return '';
        throw new Error('not a file');
      },
    } as unknown as Parameters<typeof listFilesUnder>[0];
    const files = await listFilesUnder(fs, 'top');
    expect(calls).toBeLessThan(10000);
    expect(files[0]).toBe('top/a.md');
    expect(files.length).toBeLessThanOrEqual(MAX_LIST_DEPTH + 1);
  });

  it('a missing folder lists nothing', async () => {
    const { th } = setup();
    expect(await listFilesUnder(th.host.fs, 'nowhere')).toEqual([]);
  });
});

describe('entryEvents', () => {
  it('a folder rename emits every file inside, .json included, and settles after the link rewrite', async () => {
    const { th, seen } = setup();
    const journal = th.ctx.links!.journal;
    const log: string[] = [];
    const held = hold();
    const release = () => holds.forEach((r) => r());
    const original = journal.setStatus.bind(journal);
    vi.spyOn(journal, 'setStatus').mockImplementation(async (s) => {
      if (s === 'done') await held; // 링크 고침의 끝을 붙잡아 둔다
      await original(s);
      log.push(s);
    });
    const plan = await planFor(th, 'labnote/061_PCR', 'labnote/061_PCR2', true);
    const flow = renameWithLinks(th.ctx, plan, journal);
    // 이름을 바꾼 직후, 링크 고침이 끝나기 전에 알린다
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const e = seen[0] as Extract<EntryEvent, { kind: 'renamed' }>;
    expect(e.kind).toBe('renamed');
    expect(e.isDir).toBe(true);
    expect(e.from).toBe('labnote/061_PCR');
    expect(e.to).toBe('labnote/061_PCR2');
    expect(e.files.map((f) => f.from)).toEqual(expect.arrayContaining([NOTE, `${LOCAL}/DNA.json`]));
    expect(e.files).toContainEqual({ from: `${LOCAL}/DNA.json`, to: 'labnote/061_PCR2/resources/labsamples/DNA.json' });
    let isSettled = false;
    void e.settled.then(() => {
      isSettled = true;
      log.push('settled');
    });
    await vi.waitFor(() => expect(log).toContain('renamed'));
    await new Promise((r) => setTimeout(r, 30));
    expect(isSettled).toBe(false);
    release();
    await flow;
    await e.settled;
    expect(log).toEqual(['renamed', 'done', 'settled']);
  });

  it('a plain rename settles only after the renamed note is reopened', async () => {
    const { th, seen } = setup({ ...SAMPLE_VAULT, 'notes/a.md': '# a\n' });
    vi.spyOn(th.ctx, 'activePath').mockReturnValue('notes/a.md');
    vi.spyOn(th.ctx, 'closeActive').mockResolvedValue(true);
    const held = hold();
    const release = () => holds.forEach((r) => r());
    const opened: string[] = [];
    vi.spyOn(th.ctx, 'openFile').mockImplementation(async (p: string) => {
      await held;
      opened.push(p);
    });
    th.answer.prompt('b');
    const flow = renameEntry(th.ctx, 'notes/a.md', false, []);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const e = seen[0] as Extract<EntryEvent, { kind: 'renamed' }>;
    let isSettled = false;
    void e.settled.then(() => (isSettled = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(isSettled).toBe(false);
    release();
    expect(await flow).toBe('notes/b.md');
    await e.settled;
    expect(opened).toEqual(['notes/b.md']);
  });

  it('settled still resolves when the link rewrite fails after the rename', async () => {
    const { th, seen } = setup({ ...SAMPLE_VAULT, 'notes/x.md': '# x\n' });
    const journal = th.ctx.links!.journal;
    const plan = await planFor(th, 'notes/x.md', 'notes/y.md', false);
    vi.spyOn(journal, 'setStatus').mockImplementation(async (s) => {
      if (s === 'done') throw new Error('journal broke');
    });
    await expect(renameWithLinks(th.ctx, plan, journal)).rejects.toThrow('journal broke');
    const e = seen[0] as Extract<EntryEvent, { kind: 'renamed' }>;
    await expect(e.settled).resolves.toBeUndefined();
  });

  it('a refused rename emits nothing', async () => {
    const { th, seen } = setup({ ...SAMPLE_VAULT, 'notes/a.md': 'a', 'notes/b.md': 'b' });
    const plan = await planFor(th, 'notes/a.md', 'notes/b.md', false);
    await expect(renameWithLinks(th.ctx, plan, th.ctx.links!.journal)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('a plain file rename in the tree emits the one file and is already settled', async () => {
    const { th, seen } = setup({ ...SAMPLE_VAULT, 'notes/a.md': '# a\n' });
    th.answer.prompt('b');
    expect(await renameEntry(th.ctx, 'notes/a.md', false, [])).toBe('notes/b.md');
    expect(seen).toHaveLength(1);
    const e = seen[0] as Extract<EntryEvent, { kind: 'renamed' }>;
    expect(e).toMatchObject({ kind: 'renamed', from: 'notes/a.md', to: 'notes/b.md', isDir: false, files: [{ from: 'notes/a.md', to: 'notes/b.md' }] });
    await expect(e.settled).resolves.toBeUndefined();
  });

  it('a folder delete emits the files it held', async () => {
    const { th, seen } = setup();
    th.answer.confirm(true);
    expect(await deleteEntry(th.ctx, LOCAL, true)).toBe(true);
    expect(seen).toEqual([{ kind: 'deleted', path: LOCAL, isDir: true, files: [`${LOCAL}/DNA.json`] }]);
  });

  it('a file delete emits just that file; a cancelled delete emits nothing', async () => {
    const { th, seen } = setup();
    th.answer.confirm(false);
    expect(await deleteEntry(th.ctx, NOTE, false)).toBe(false);
    expect(seen).toEqual([]);
    th.answer.confirm(true, false);
    expect(await deleteEntry(th.ctx, NOTE, false)).toBe(true);
    expect(seen).toEqual([{ kind: 'deleted', path: NOTE, isDir: false, files: [NOTE] }]);
  });
});
