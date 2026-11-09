// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { readNoteId } from '@labnoteo/core/lib/noteId';
import { createFakeVault } from '../../../__tests__/fakeVault';
import { TauriLabnoteFs } from '../../../fs/tauriLabnoteFs';
import type { ListenFn } from '../../../vault/useVaultEvents';
import { entryEvents } from '../../commands/entryEvents';
import { editorAwareFs } from '../../editorAwareFs';
import { createAppHost } from '../../host/createAppHost';
import { closeAllDialogs, currentDialog, settleDialog, type DialogSpec } from '../../host/dialogStore';
import { unsolicitedHost } from '../../host/whenNotComposing';
import { coreT } from '../../i18n';
import { setComposing } from '../../../editor/__tests__/composing';
import { NoteBusyError } from '../../noteErrors';
import { mountEditor } from '../../__tests__/editorHarness';
import { NoteIdService } from '../../port/noteIdService';
import { startIdWatch, noteIdTouch } from '../idWatch';
import { NoteIdIndex, setNoteIdIndex } from '../noteIdIndex';
import { appNoteIdSource, noteRef } from '../noteIdSource';

const ID = 'LN-7K3M9QX2';
const OTHER = 'LN-8M4N0RY3';
const note = (id?: string, body = 'body') => `---\ntitle: x\n${id ? `labnote_id: ${id}\n` : ''}---\n\n${body}\n`;

const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((s) => s());
  closeAllDialogs();
  setNoteIdIndex(undefined);
  vi.useRealTimers();
});

/** 조건이 참이 될 때까지 작업 줄을 돌린다(실제 타이머). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
}
/** 몇 번 작업 줄을 돌린다: 그 사이 아무 일도 없어야 하는 곳에서. */
async function idle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

type Confirm = Extract<DialogSpec, { kind: 'confirm' }>;
const shown = () => currentDialog()?.spec as Confirm | undefined;
function answer(value: unknown): void {
  const entry = currentDialog()!;
  settleDialog(entry.id, value);
}

/**
 * 가짜 보관함 위의 앱 배선: editorAwareFs, 진짜 NoteIdIndex, 감시의 NoteIdService(unsolicitedHost), 그리고 startIdWatch.
 * 대화상자는 dialogStore 로 열리고(테스트가 답한다), 알림은 `notices` 에 남는다.
 */
async function setup(
  files: Record<string, string>,
  opts: { ctimes?: Record<string, number>; view?: () => EditorView | undefined } = {},
) {
  const vault = createFakeVault(files);
  const fs = editorAwareFs(new TauriLabnoteFs(vault.invoke));
  const ctimes = opts.ctimes ?? {};
  const index = new NoteIdIndex({
    files: async () => Object.keys(vault.files()).filter((p) => p.endsWith('.md')),
    read: (p) => fs.read(p),
    ctimes: async (ps) => ps.map((p) => ctimes[p] ?? 0),
  });
  setNoteIdIndex(index);
  const notices: Array<[string, string]> = [];
  const errors: unknown[] = [];
  const plain = {
    ...createAppHost({ fs, editTarget: () => undefined, openFile: async () => undefined }),
    notify: (kind: string, message: string) => void notices.push([kind, message]),
  } as ReturnType<typeof createAppHost>;
  const service = new NoteIdService(appNoteIdSource(index, fs), unsolicitedHost(plain, opts.view ?? (() => undefined)));
  await index.ready();
  stops.push(
    startIdWatch({
      index,
      service,
      listen: vault.listen as unknown as ListenFn,
      run: (fn) => void fn().catch((e) => errors.push(e)),
    }),
  );
  const write = async (path: string, text: string, kind: 'created' | 'modified' = 'modified') => {
    await vault.mem.write(path, text);
    await vault.emitChange(path, kind);
  };
  return { vault, fs, index, service, plain, notices, errors, write };
}

describe('idWatch', () => {
  it('on start, duplicate IDs are offered once with the newest note named', async () => {
    const { vault, service } = await setup(
      { 'a.labnote.md': note(ID), 'b.labnote.md': note(ID) },
      { ctimes: { 'a.labnote.md': 1, 'b.labnote.md': 2 } },
    );
    await until(() => !!shown());
    expect(shown()!.kind).toBe('confirm');
    expect(shown()!.message).toBe(
      coreT(
        'Notes {0} share the note ID {1}, probably because one was copied. Scans of either note would be filed in the wrong one. Give {2} a new ID?',
        'a.labnote.md, b.labnote.md',
        ID,
        'b.labnote.md',
      ),
    );
    expect(shown()!.unsolicited).toBe(true);
    answer(false);
    await idle();
    expect(currentDialog()).toBeNull();
    await service.offerDuplicateFixes();
    expect(currentDialog()).toBeNull();
    expect(readNoteId(vault.files()['b.labnote.md'])).toBe(ID);
  });

  it('a copied note with the same labnote_id is offered a new ID on the next change', async () => {
    const { vault, write } = await setup({ 'a.labnote.md': note(ID) }, { ctimes: { 'a.labnote.md': 1, 'b.labnote.md': 2 } });
    await idle();
    expect(currentDialog()).toBeNull();
    await write('b.labnote.md', note(ID), 'created');
    await until(() => !!shown());
    expect(shown()!.message).toBe(
      coreT(
        'Notes {0} share the note ID {1}, probably because one was copied. Scans of either note would be filed in the wrong one. Give {2} a new ID?',
        'a.labnote.md, b.labnote.md',
        ID,
        'b.labnote.md',
      ),
    );
    expect(shown()!.confirmLabel).toBe(coreT('Give a new ID'));
    answer(true);
    await until(() => readNoteId(vault.files()['b.labnote.md']) !== ID);
    expect(readNoteId(vault.files()['b.labnote.md'])).toMatch(/^LN-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(readNoteId(vault.files()['a.labnote.md'])).toBe(ID);
    // 새 ID 를 준 쓰기는 "ID 가 바뀌었다"는 질문을 부르지 않는다
    await idle();
    expect(currentDialog()).toBeNull();
  });

  it('a labnote_id edited to another valid ID offers the old one back', async () => {
    const { vault, write, notices } = await setup({ 'a.labnote.md': note(ID) });
    await idle();
    await write('a.labnote.md', note(OTHER));
    await until(() => !!shown());
    expect(shown()!.confirmLabel).toBe(coreT('Restore ID'));
    expect(shown()!.unsolicited).toBe(true);
    answer(true);
    await until(() => readNoteId(vault.files()['a.labnote.md']) === ID);
    await idle();
    expect(currentDialog()).toBeNull();
    expect(notices).toContainEqual(['info', coreT('{0} has the note ID {1} again.', 'a.labnote', ID)]);
  });

  it('a template carrying a lab note ID is warned about once', async () => {
    const { write, notices } = await setup(
      { 'a.labnote.md': note(ID), 'Templates/t.md': note(ID) },
      { ctimes: { 'a.labnote.md': 1, 'b.labnote.md': 2 } },
    );
    const warning = coreT(
      '{0} is not a lab note but carries the note ID {1}, so notes made from it as a template get that ID too. Delete its labnote_id line.',
      'Templates/t.md',
      ID,
    );
    await until(() => notices.length > 0);
    expect(notices).toEqual([['warn', warning]]);
    // 다음 변경(같은 ID 의 복사본)은 중복을 묻지만 서식 경고는 다시 하지 않는다
    await write('b.labnote.md', note(ID), 'created');
    await until(() => !!shown());
    answer(false);
    await idle();
    expect(notices.filter(([kind]) => kind === 'warn')).toEqual([['warn', warning]]);
  });

  it('rename keeps the known ID; no question after a rename', async () => {
    const { vault, index, write } = await setup({ 'a.labnote.md': note(ID) });
    await idle();
    await vault.mem.write('x/a.labnote.md', vault.files()['a.labnote.md']);
    await vault.mem.remove('a.labnote.md');
    entryEvents.emit({
      kind: 'renamed',
      from: 'a.labnote.md',
      to: 'x/a.labnote.md',
      isDir: false,
      files: [{ from: 'a.labnote.md', to: 'x/a.labnote.md' }],
      settled: Promise.resolve(),
    });
    expect(index.idOf('x/a.labnote.md')).toBe(ID);
    expect(index.exists('a.labnote.md')).toBe(false);
    await write('x/a.labnote.md', note(ID, 'edited'));
    await idle();
    expect(currentDialog()).toBeNull();
    expect(index.idOf('x/a.labnote.md')).toBe(ID);
  });

  it('a delete drops the note, and a later note with its ID is not taken for a changed one', async () => {
    const { vault, index, write } = await setup({ 'a.labnote.md': note(ID) });
    await idle();
    await vault.mem.remove('a.labnote.md');
    entryEvents.emit({ kind: 'deleted', path: 'a.labnote.md', isDir: false, files: ['a.labnote.md'] });
    expect(index.exists('a.labnote.md')).toBe(false);
    // 같은 경로의 새 노트: 지운 노트의 ID 와 비교해 "되돌릴까요"를 묻지 않는다
    await write('a.labnote.md', note(OTHER), 'created');
    await idle();
    expect(currentDialog()).toBeNull();
    expect(vault.files()['a.labnote.md']).toBe(note(OTHER));
  });

  it('an ID a command gives is not taken for a changed ID', async () => {
    const { fs, index, plain, vault } = await setup({ 'a.labnote.md': note(ID) });
    await idle();
    const command = new NoteIdService(appNoteIdSource(index, fs), plain);
    const next = await command.ensureId(noteRef(index, 'a.labnote.md')!, { reassign: true });
    expect(next).not.toBe(ID);
    expect(readNoteId(vault.files()['a.labnote.md'])).toBe(next);
    await idle();
    expect(currentDialog()).toBeNull();
  });

  it('a command write refused while composing keeps the known ID, so a later hand edit still offers it back', async () => {
    const { fs, index, plain, vault, write } = await setup({ 'a.labnote.md': note(ID) });
    await idle();
    const m = mountEditor(vault, 'a.labnote.md');
    await m.loaded();
    setComposing(m.view(), true);
    const command = new NoteIdService(appNoteIdSource(index, fs), plain);
    await expect(command.ensureId(noteRef(index, 'a.labnote.md')!, { reassign: true })).rejects.toBeInstanceOf(
      NoteBusyError,
    );
    setComposing(m.view(), false);
    m.unmount();
    expect(readNoteId(vault.files()['a.labnote.md'])).toBe(ID);
    await idle();
    await write('a.labnote.md', note(OTHER));
    await until(() => !!shown());
    expect(shown()!.confirmLabel).toBe(coreT('Restore ID'));
  });

  it('a duplicate-ID question is not opened while composing and opens after compositionend', async () => {
    const view = { composing: true, contentDOM: document.createElement('div') } as unknown as EditorView & {
      composing: boolean;
    };
    const { write } = await setup({ 'a.labnote.md': note(ID) }, { ctimes: { 'b.labnote.md': 2 }, view: () => view });
    await idle();
    await write('b.labnote.md', note(ID), 'created');
    await idle();
    expect(currentDialog()).toBeNull();
    view.composing = false;
    view.contentDOM.dispatchEvent(new Event('compositionend'));
    await until(() => !!shown());
    expect(shown()!.unsolicited).toBe(true);
  });

  it('typing in a note refreshes after 2 s, never while composing', async () => {
    vi.useFakeTimers();
    const index = new NoteIdIndex({ files: async () => [], read: async () => '', ctimes: async (ps) => ps.map(() => 0) });
    setNoteIdIndex(index);
    const refresh = vi.spyOn(index, 'refresh').mockResolvedValue(undefined);
    const p = 'e/01_x.labnote.md';
    noteIdTouch(p, { composing: true });
    vi.advanceTimersByTime(3000);
    expect(refresh).not.toHaveBeenCalled();
    noteIdTouch(p, { composing: false });
    vi.advanceTimersByTime(1900);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(p);
  });

  it('typing again restarts the 2 s wait; other files are not watched', async () => {
    vi.useFakeTimers();
    const index = new NoteIdIndex({ files: async () => [], read: async () => '', ctimes: async (ps) => ps.map(() => 0) });
    setNoteIdIndex(index);
    const refresh = vi.spyOn(index, 'refresh').mockResolvedValue(undefined);
    noteIdTouch('a.labnote.md', { composing: false });
    vi.advanceTimersByTime(1500);
    noteIdTouch('a.labnote.md', { composing: false });
    vi.advanceTimersByTime(1500);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(refresh).toHaveBeenCalledTimes(1);
    noteIdTouch('README.md', { composing: false });
    vi.advanceTimersByTime(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('noteIdTouch without an index does nothing', () => {
    vi.useFakeTimers();
    setNoteIdIndex(undefined);
    noteIdTouch('a.labnote.md', { composing: false });
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
  });
});
