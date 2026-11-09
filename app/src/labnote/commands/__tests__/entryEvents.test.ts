// @vitest-environment jsdom
/**
 * 앱에서 한 이름 바꾸기와 삭제의 항목 알림(plan SP5 Task 26, D14). `files` 는 작업 전에 뜬 목록이라 .json 과 폴더 속
 * 파일까지 담는다. 이름 바꾸기의 `settled` 는 링크 고침이 끝난 뒤(journal 'done') 풀린다: 그 전에는 뒤따르는 대화상자가 없다.
 */
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { planRename } from '../../../links/planRename';
import { renameWithLinks } from '../../../links/renameWithLinks';
import { LOCAL, NOTE, SAMPLE_VAULT } from '../../../samples/__tests__/fixtures';
import { entryEvents, listFilesUnder, type EntryEvent } from '../entryEvents';
import { deleteEntry, renameEntry } from '../fileOps';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

let hosts: TestHost[] = [];
let offs: Array<() => void> = [];
function setup(files: Record<string, string> = SAMPLE_VAULT): { th: TestHost; seen: EntryEvent[] } {
  const th = createTestHost(files);
  hosts.push(th);
  const seen: EntryEvent[] = [];
  offs.push(entryEvents.subscribe((e) => seen.push(e)));
  return { th, seen };
}
afterEach(() => {
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

  it('a missing folder lists nothing', async () => {
    const { th } = setup();
    expect(await listFilesUnder(th.host.fs, 'nowhere')).toEqual([]);
  });
});

describe('entryEvents', () => {
  it('a folder rename emits every file inside, .json included, and settles after the link rewrite', async () => {
    const { th, seen } = setup();
    const journal = th.ctx.links!.journal;
    const setStatus = vi.spyOn(journal, 'setStatus');
    const done = () => setStatus.mock.calls.filter((c) => c[0] === 'done').length;
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
    let settledAt = -1;
    await e.settled.then(() => (settledAt = done()));
    expect(settledAt).toBe(1);
    await flow;
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
