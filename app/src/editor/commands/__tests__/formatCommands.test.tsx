// @vitest-environment jsdom
import { act, waitFor } from '@testing-library/react';
import type { PickItem } from '@labnoteo/core';
import { undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { setLang } from '../../../i18n/lang';
import { catalogs, t } from '../../../i18n/t';
import { clearCommandsForTest } from '../../../labnote/commands/registry';
import { openPalette } from '../../../labnote/ui/CommandPalette';
import { createTestHost, type TestHost } from '../../../labnote/__tests__/testHost';
import { setMode } from '../../live/mode';
import { activeCellView, focusCell } from '../../table/cellEditor';
import { appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../appCommands';
import { FORMAT_KEYS, runFormat } from '../formatCommands';

// Node 의 자체 localStorage 가 jsdom 의 것을 가리므로 메모리 저장소를 꽂는다(appCommands.test.ts 와 같다).
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const P = 'notes/a.labnote.md';
let h: TestHost;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  setMode('live');
  setLang('ko');
  registerAllAppCommands();
});
afterEach(() => {
  h?.cleanup();
  vi.unstubAllGlobals();
  clearAppCommandsForTest();
  clearCommandsForTest();
});

/** 앱의 편집기에 노트를 열고 선택을 둔 뒤 포커스를 준다. */
async function mountNote(doc: string, sel: [number, number]): Promise<EditorView> {
  h = createTestHost({ [P]: doc });
  const m = await h.mount(P);
  const v = m.view();
  act(() => {
    v.dispatch({ selection: { anchor: sel[0], head: sel[1] } });
    v.focus();
  });
  return v;
}

/** 표가 든 노트를 열고 r 행 c 칸에 셀 편집기를 띄운다. */
async function focusCellIn(doc: string, r: number, c: number): Promise<{ outer: EditorView; cell: EditorView }> {
  const outer = await mountNote(doc, [0, 0]);
  await act(async () => void focusCell(outer, 0, r, c));
  const cell = activeCellView(outer)!;
  expect(cell).not.toBeNull();
  return { outer, cell };
}

type KeyInit = { key: string; code: string; keyCode: number; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean };

/** Ctrl 과 함께 키를 누른다(그 뷰의 contentDOM 에 실제 keydown 사건). keyCode 는 직접 붙인다. */
function press(v: EditorView, init: KeyInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    ctrlKey: true,
    shiftKey: !!init.shiftKey,
    altKey: !!init.altKey,
    isComposing: !!init.isComposing,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
  Object.defineProperty(ev, 'which', { value: init.keyCode });
  act(() => void v.contentDOM.dispatchEvent(ev));
  return ev;
}

/** 한글 조합 중인 것처럼 꾸민다: view.composing 은 inputState.composing 을 읽는다. */
const setComposing = (v: EditorView, on: boolean) => {
  (v as unknown as { inputState: { composing: number } }).inputState.composing = on ? 1 : -1;
};
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n';

describe('formatting shortcuts', () => {
  it.each([
    ['Mod-b', { key: 'b', code: 'KeyB', keyCode: 66 }, 'a **b** c'],
    ['Mod-b korean', { key: 'ㅠ', code: 'KeyB', keyCode: 66 }, 'a **b** c'],
    ['Mod-Shift-8', { key: '*', code: 'Digit8', keyCode: 56, shiftKey: true }, '- a b c'],
    ['Mod-Shift-.', { key: '>', code: 'Period', keyCode: 190, shiftKey: true }, '> a b c'],
    ['Mod-Alt-c korean', { key: 'ㅊ', code: 'KeyC', keyCode: 67, altKey: true }, '```\na b c\n```'],
  ] as [string, KeyInit, string][])('%s fires and is preventDefault-ed', async (_, ev, out) => {
    const v = await mountNote('a b c', [2, 3]);
    expect(press(v, ev).defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe(out);
  });

  it('Mod-1 on a one-line note makes a heading', async () => {
    const v = await mountNote('a', [1, 1]);
    press(v, { key: '1', code: 'Digit1', keyCode: 49 });
    expect(v.state.doc.toString()).toBe('# a');
  });

  it('Ctrl+B inside a table cell bolds the cell selection; the outer doc changes once; one undo', async () => {
    const { outer, cell } = await focusCellIn(TABLE, 1, 0);
    const before = outer.state.doc.toString();
    act(() => cell.dispatch({ selection: { anchor: 0, head: 1 } }));
    let changed = 0;
    const listen = EditorView.updateListener.of((u) => void (u.docChanged && changed++));
    act(() => outer.dispatch({ effects: StateEffect.appendConfig.of(listen) }));
    press(cell, { key: 'b', code: 'KeyB', keyCode: 66 });
    expect(outer.state.doc.toString()).toBe('| a | b |\n| - | - |\n| **1** | 2 |\n');
    expect(changed).toBe(1);
    act(() => void undo(outer));
    expect(outer.state.doc.toString()).toBe(before);
  });

  it('Mod-1 inside a cell does nothing, inserts no line break, and is consumed', async () => {
    const { outer, cell } = await focusCellIn(TABLE, 1, 0);
    expect(press(cell, { key: '1', code: 'Digit1', keyCode: 49 }).defaultPrevented).toBe(true);
    expect(outer.state.doc.toString()).toBe(TABLE);
  });

  it('Mod-b during composition runs once on compositionend as one undo step', async () => {
    const v = await mountNote('단백질', [3, 3]);
    setComposing(v, true);
    press(v, { key: 'ㅠ', code: 'KeyB', keyCode: 229, isComposing: true });
    expect(v.state.doc.toString()).toBe('단백질');
    setComposing(v, false);
    act(() => void v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await nextFrame();
    expect(v.state.doc.toString()).toBe('**단백질**');
    // 한 번만 돈다: 다음 조합 끝에 다시 돌지 않는다
    act(() => void v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await nextFrame();
    expect(v.state.doc.toString()).toBe('**단백질**');
    act(() => void undo(v));
    expect(v.state.doc.toString()).toBe('단백질');
  });

  it('text typed right after Ctrl+B is a separate undo step', async () => {
    const v = await mountNote('a b c', [2, 3]);
    press(v, { key: 'b', code: 'KeyB', keyCode: 66 });
    act(() => v.dispatch({ changes: { from: 9, insert: 'x' }, userEvent: 'input.type' }));
    act(() => void undo(v));
    expect(v.state.doc.toString()).toBe('a **b** c');
  });

  it('text typed in a cell right after Ctrl+B is a separate undo step', async () => {
    const { outer, cell } = await focusCellIn(TABLE, 1, 0);
    act(() => cell.dispatch({ selection: { anchor: 0, head: 1 } }));
    press(cell, { key: 'b', code: 'KeyB', keyCode: 66 });
    act(() => cell.dispatch({ changes: { from: cell.state.doc.length, insert: 'x' }, selection: { anchor: cell.state.doc.length + 1 }, userEvent: 'input.type' }));
    expect(outer.state.doc.toString()).toBe('| a | b |\n| - | - |\n| **1**x | 2 |\n');
    act(() => void undo(outer));
    expect(outer.state.doc.toString()).toBe('| a | b |\n| - | - |\n| **1** | 2 |\n');
  });

  it('Ctrl+S and Ctrl+Alt+T are not shadowed', async () => {
    const v = await mountNote('a', [1, 1]);
    act(() => v.dispatch({ changes: { from: 1, insert: 'b' }, selection: { anchor: 2 }, userEvent: 'input.type' }));
    const writes = () => h.vault.log.filter((c) => c.cmd === 'vault_modify').length;
    press(v, { key: 's', code: 'KeyS', keyCode: 83 });
    await waitFor(() => expect(writes()).toBe(1));
    press(v, { key: 'ㅅ', code: 'KeyT', keyCode: 84, altKey: true });
    expect(v.state.doc.toString()).toContain('| ');
  });

  it('a builder that refuses (read-only) makes runFormat consume the key and change nothing', async () => {
    const v = await mountNote('a b c', [2, 3]);
    const bold = FORMAT_KEYS.find((f) => f.id === 'format-bold')!;
    // 빌더가 읽기 전용에서 null 을 내면 runFormat 은 키를 먹고 아무것도 바꾸지 않는다
    const spy = vi.spyOn(bold, 'build').mockReturnValue(null);
    expect(runFormat(v, bold)).toBe(true);
    expect(v.state.doc.toString()).toBe('a b c');
    spy.mockRestore();
  });
});

describe('format commands in the palette', () => {
  it('the palette lists all format commands with ko names and display keys', async () => {
    h = createTestHost();
    await openPalette(h.ctx);
    // 이름과 단축키는 따로다: 단축키는 줄 오른쪽 끝의 kbd 칩(UI 재설계 Task 12)
    const rows = (h.asked.pick[0].items as PickItem<{ kbd?: string }>[]).map((i) => `${i.label} ${i.value.kbd}`);
    expect(rows).toEqual(expect.arrayContaining(['굵게 Ctrl+B', '제목 2 Ctrl+2', '인용 Ctrl+Shift+.', '코드 블록 Ctrl+Alt+C']));
  });

  it('every D10 format row is registered as an app command with ko and en names', () => {
    const ids = FORMAT_KEYS.map((f) => f.id);
    expect(ids).toEqual([
      'format-bold',
      'format-italic',
      'format-strikethrough',
      'format-code',
      'format-highlight',
      'format-link',
      'format-heading-1',
      'format-heading-2',
      'format-heading-3',
      'format-heading-4',
      'format-heading-5',
      'format-heading-6',
      'format-paragraph',
      'format-bullet-list',
      'format-numbered-list',
      'format-task',
      'format-quote',
      'format-code-block',
    ]);
    for (const f of FORMAT_KEYS) {
      expect(appCommands().find((c) => c.id === f.id)?.key).toBe(f.key);
      expect(catalogs.ko[f.nameKey]).toBeTruthy();
      expect(catalogs.en[f.nameKey]).toBeTruthy();
    }
  });

  it('running a format command with no open note shows the noNote toast', async () => {
    h = createTestHost();
    const c = appCommands().find((x) => x.id === 'format-bold')!;
    await c.run(h.ctx);
    expect(h.notes).toEqual([{ kind: 'info', message: t('cmd.format.noNote') }]);
  });

  it('running a format command from the palette formats the active note', async () => {
    const v = await mountNote('a b c', [2, 3]);
    const c = appCommands().find((x) => x.id === 'format-italic')!;
    await act(async () => void (await c.run(h.ctx)));
    expect(v.state.doc.toString()).toBe('a *b* c');
  });
});
