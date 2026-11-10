// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFakeVault } from '../../__tests__/fakeVault';
import { TauriLabnoteFs } from '../../fs/tauriLabnoteFs';
import { ERROR_KINDS } from '../../fs/errorKinds';
import { activeEditTarget, flushAllNotes, NoteBusyError, NoteSaveError, openNote, openNoteHandles, processNote, registerOpenNote } from '../openNotes';
import { NoteGoneError } from '../noteErrors';
import type { EditorHandle } from '../../editor/Editor';
import { mountEditor } from './editorHarness';

const P = 'lab/README.md';

function setup(files: Record<string, string>) {
  const vault = createFakeVault(files);
  const fs = new TauriLabnoteFs(vault.invoke);
  return { vault, fs };
}

describe('open-note registry', () => {
  it('registers by path, case-insensitively, and unregisters only its own handle', () => {
    const a = { busy: () => false } as unknown as EditorHandle;
    const b = { busy: () => true } as unknown as EditorHandle;
    const offA = registerOpenNote('Lab/A.md', a);
    expect(openNote('lab/a.md')).toBe(a);
    const offB = registerOpenNote('lab/a.md', b);
    offA(); // a was replaced: its cleanup must not remove b
    expect(openNote('LAB/A.md')).toBe(b);
    offB();
    expect(openNote('lab/a.md')).toBeUndefined();
  });

  it('the Editor registers on mount and unregisters on unmount', async () => {
    const { vault } = setup({ [P]: 'x\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    expect(openNote(P)).toBe(m.ref.current);
    m.unmount();
    expect(openNote(P)).toBeUndefined();
  });
});

describe('processNote', () => {
  it('open and dirty: unsaved typing survives, the transform applies on top, it flushes, and disk equals the buffer', async () => {
    const { vault, fs } = setup({ [P]: 'status: running\nbody\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    await m.type('typed by hand\n');
    const changed = await act(() => processNote(fs, P, (t) => t.replace('running', 'completed')));
    expect(changed).toBe(true);
    expect(m.view().state.doc.toString()).toBe('status: completed\nbody\ntyped by hand\n');
    expect(vault.files()[P]).toBe('status: completed\nbody\ntyped by hand\n');
    m.unmount();
  });

  it('open and busy (external change dialog open): rejects with NoteBusyError and changes nothing', async () => {
    const { vault, fs } = setup({ [P]: 'mine\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    await m.type('!');
    await vault.mem.write(P, 'theirs\n');
    await act(() => vault.emitChange(P, 'modified'));
    await screen.findByRole('alertdialog');
    await expect(processNote(fs, P, (t) => `${t}X`)).rejects.toBeInstanceOf(NoteBusyError);
    expect(m.view().state.doc.toString()).toBe('mine\n!');
    expect(vault.files()[P]).toBe('theirs\n');
    m.unmount();
  });

  it('open and composing (Korean IME): rejects with NoteBusyError and leaves the composition alone', async () => {
    const { vault, fs } = setup({ [P]: 'mine\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    const view = m.view();
    Object.defineProperty(view, 'composing', { configurable: true, get: () => true });
    const dispatch = vi.spyOn(view, 'dispatch');
    await expect(processNote(fs, P, (t) => `${t}X`)).rejects.toBeInstanceOf(NoteBusyError);
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('mine\n');
    expect(vault.files()[P]).toBe('mine\n');
    m.unmount();
  });

  it('open after "Keep my version": busy() is true, so it rejects with NoteBusyError', async () => {
    const user = userEvent.setup();
    const { vault, fs } = setup({ [P]: 'mine\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    await m.type('!');
    await vault.mem.write(P, 'theirs\n');
    await act(() => vault.emitChange(P, 'modified'));
    await user.click(await screen.findByRole('button', { name: '그대로 두기' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(m.ref.current!.busy()).toBe(true);
    await expect(processNote(fs, P, (t) => `${t}X`)).rejects.toBeInstanceOf(NoteBusyError);
    expect(activeEditTarget(P)).toBeUndefined();
    m.unmount();
  });

  it('open, and the save fails: rejects with NoteSaveError and the buffer keeps the change', async () => {
    const { vault, fs } = setup({ [P]: 'a\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    vault.failNext('vault_modify', ERROR_KINDS.io);
    await expect(act(() => processNote(fs, P, (t) => `${t}b\n`))).rejects.toBeInstanceOf(NoteSaveError);
    expect(m.view().state.doc.toString()).toBe('a\nb\n');
    expect(vault.files()[P]).toBe('a\n');
    m.unmount();
  });

  it('not open: BOM and CRLF are kept on disk, and a mixed file keeps its line endings', async () => {
    const { vault, fs } = setup({ 'a.md': '﻿one\r\ntwo\r\n', 'm.md': 'x\r\ny\nz\r\n' });
    expect(await processNote(fs, 'a.md', (t) => t.replace('two\n', 'two\nthree\n'))).toBe(true);
    expect(vault.files()['a.md']).toBe('﻿one\r\ntwo\r\nthree\r\n');
    expect(await processNote(fs, 'm.md', (t) => t.replace('z', 'Z'))).toBe(true);
    expect(vault.files()['m.md']).toBe('x\r\ny\nZ\r\n');
  });

  it('not open: a missing file is refused', async () => {
    const { fs } = setup({});
    await expect(processNote(fs, 'missing.md', (t) => `${t}x`)).rejects.toMatchObject({ kind: ERROR_KINDS.notFound });
  });

  it('a transform that returns its input writes nothing', async () => {
    const { vault, fs } = setup({ [P]: 'same\n', 'closed.md': 'same\n' });
    const m = mountEditor(vault, P);
    await m.loaded();
    expect(await processNote(fs, P, (t) => t)).toBe(false);
    expect(await processNote(fs, 'closed.md', (t) => t)).toBe(false);
    expect(vault.log.some((c) => c.cmd === 'vault_modify')).toBe(false);
    m.unmount();
  });
});

describe('processNote on a note deleted mid-run', () => {
  it('processNote refuses to recreate a note deleted after its read', async () => {
    const vault = createFakeVault({ 'a.md': '[[Home]]' });
    let first = true;
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'vault_modify' && first) {
        first = false;
        await vault.invoke('vault_remove', { path: 'a.md' });
      }
      return vault.invoke(cmd, args);
    }) as typeof vault.invoke;
    await expect(processNote(new TauriLabnoteFs(invoke), 'a.md', (t) => t.replace('Home', 'Start'))).rejects.toBeInstanceOf(
      NoteGoneError,
    );
    expect(vault.files()['a.md']).toBeUndefined();
  });
});

describe('activeEditTarget', () => {
  it('is undefined with no path or no open note', () => {
    expect(activeEditTarget(undefined)).toBeUndefined();
    expect(activeEditTarget('nope.md')).toBeUndefined();
  });

  it('is undefined while the editor is loading, and an EditTarget once loaded', async () => {
    const vault = createFakeVault({ [P]: 'hello\n' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = vault.invoke;
    (vault as { invoke: typeof slow }).invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'vault_read') await gate;
      return slow(cmd, args);
    }) as typeof slow;
    const m = mountEditor(vault, P);
    expect(openNote(P)).toBeDefined();
    expect(activeEditTarget(P)).toBeUndefined();
    await act(async () => release());
    await m.loaded();
    const target = activeEditTarget(P)!;
    expect(await target.getText()).toBe('hello\n');
    m.unmount();
  });
});

describe('Editor reveal / initialReveal', () => {
  it('Editor reveal / initialReveal puts the cursor on the given line (0-based) after load', async () => {
    const { vault } = setup({ [P]: 'l0\nl1\nline two\nl3\n' });
    const m = mountEditor(vault, P, { initialReveal: { line: 2, ch: 4 } });
    await m.loaded();
    await waitFor(() => expect(m.view().state.selection.main.head).toBe(10));
    act(() => m.ref.current!.reveal({ line: 99 })); // clamps to the last line
    expect(m.view().state.selection.main.head).toBe(m.view().state.doc.length);
    act(() => m.ref.current!.reveal({ line: 1, ch: 99 })); // clamps to the line end
    expect(m.view().state.selection.main.head).toBe(5);
    m.unmount();
  });

  it('rawText is the buffer in disk encoding, and undefined while loading', async () => {
    const { vault } = setup({ [P]: '﻿a\r\nb\r\n' });
    const m = mountEditor(vault, P);
    expect(m.ref.current!.rawText()).toBeUndefined();
    await m.loaded();
    await m.type('c');
    expect(m.ref.current!.rawText()).toBe('﻿a\r\nb\r\nc');
    m.unmount();
  });
});

describe('openNoteHandles and flushAllNotes (update install, spec §3.4)', () => {
  const handle = (ok: boolean | Error) =>
    ({
      busy: () => false,
      flush: vi.fn(async () => {
        if (ok instanceof Error) throw ok;
        return ok;
      }),
    }) as unknown as EditorHandle & { flush: ReturnType<typeof vi.fn> };

  it('lists registered handles and drops unregistered ones', () => {
    const a = handle(true);
    const b = handle(true);
    const offA = registerOpenNote('x/a.md', a);
    const offB = registerOpenNote('x/b.md', b);
    expect(openNoteHandles()).toEqual(expect.arrayContaining([a, b]));
    offA();
    expect(openNoteHandles()).toContain(b);
    expect(openNoteHandles()).not.toContain(a);
    offB();
    expect(openNoteHandles()).not.toContain(b);
  });

  it('flushes every open note and the current editor once each, then the sample sync', async () => {
    const a = handle(true);
    const off = registerOpenNote('x/a.md', a);
    const order: string[] = [];
    a.flush.mockImplementation(async () => (order.push('a'), true));
    const sync = { flush: vi.fn(async () => void order.push('sync')) };
    // the current editor is the same handle: de-duplicated
    await expect(flushAllNotes(a, sync)).resolves.toBe(true);
    expect(a.flush).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['a', 'sync']);
    const cur = handle(true);
    await expect(flushAllNotes(cur, sync)).resolves.toBe(true);
    expect(cur.flush).toHaveBeenCalledTimes(1);
    await expect(flushAllNotes(null, sync)).resolves.toBe(true);
    off();
  });

  it('fails when one flush resolves false or throws, or the sample sync throws', async () => {
    const good = handle(true);
    const offGood = registerOpenNote('x/good.md', good);
    const sync = { flush: vi.fn(async () => {}) };
    const bad = handle(false);
    const offBad = registerOpenNote('x/bad.md', bad);
    await expect(flushAllNotes(null, sync)).resolves.toBe(false);
    expect(good.flush).toHaveBeenCalled();
    offBad();
    const throws = handle(new Error('disk'));
    const offThrow = registerOpenNote('x/throw.md', throws);
    await expect(flushAllNotes(null, sync)).resolves.toBe(false);
    offThrow();
    await expect(flushAllNotes(handle(false), sync)).resolves.toBe(false);
    const syncThrows = { flush: vi.fn(async () => Promise.reject(new Error('sync'))) };
    await expect(flushAllNotes(null, syncThrows)).resolves.toBe(false);
    offGood();
  });
});
