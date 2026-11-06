// @vitest-environment jsdom
import { createRef, StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { Editor, MAX_SAVE_ATTEMPTS, type EditorHandle, type WindowApi } from '../Editor';
import { defaultHighlightStyle } from '@codemirror/language';
import { editorTheme, editorThemeSpec, highlightSpec } from '../theme';
import type { VaultChange } from '../../vault/useVaultEvents';
import { ERROR_KINDS_FIXTURE, EVENTS_FIXTURE } from '../../__tests__/fixtures';
import { SYSTEM_COLOURS } from '../../__tests__/css';
import { getOutline } from '../outline/outlineStore';
// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
// 그림자 루트 안에서 포커스를 주면 CodeMirror 가 선택을 읽으려고 execCommand 를 부른다(jsdom 에는 없다).
document.execCommand ??= () => false;

const P = 'lab/a.labnote.md';

/** 가짜 보관함 + 가짜 이벤트. Rust 와 같은 의미: 없는 파일 읽기는 notFound, 수정은 기대값 비교. */
function setup(files: Record<string, string>, failWrites = 0) {
  let failures = failWrites;
  const calls: string[] = [];
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
    const path = args.path as string;
    if (cmd === 'vault_read') {
      if (!(path in files)) throw { kind: ERROR_KINDS_FIXTURE.notFound, message: 'x' };
      return files[path];
    }
    if (cmd === 'vault_modify') {
      if (failures-- > 0) throw { kind: ERROR_KINDS_FIXTURE.io, message: 'locked' };
      const current = files[path] ?? '';
      const expected = args.expectedBefore as string | undefined;
      if (expected !== undefined && expected !== current) return { kind: 'conflict', current };
      files[path] = args.content as string;
      return { kind: 'ok' };
    }
    throw new Error(`unexpected ${cmd}`);
  }) as never;
  const handlers = new Set<(e: { payload: VaultChange }) => void>();
  const listen = (async (_event: string, h: (e: { payload: VaultChange }) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  }) as never;
  const emit = (payload: VaultChange) => act(async () => handlers.forEach((h) => h({ payload })));
  return { files, calls, invoke, listen, emit, writes: () => calls.filter((c) => c === 'vault_modify').length };
}

function mount(files: Record<string, string>, autosaveMs = 60_000, extra: { failWrites?: number; maxAutosaveMs?: number; windowApi?: WindowApi } = {}) {
  const s = setup(files, extra.failWrites);
  const ref = createRef<EditorHandle>();
  const utils = render(
    <Editor
      ref={ref} path={P} invoke={s.invoke} listen={s.listen} autosaveMs={autosaveMs}
      maxAutosaveMs={extra.maxAutosaveMs}
      windowApi={extra.windowApi}
    />,
  );
  // 편집기는 그림자 루트 안에 있다(CSP 때문에): 테스트 라이브러리의 질의는 거기까지 들어가지 못하므로 뷰로 직접 간다.
  const view = () => {
    const root = (utils.container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
    return EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
  };
  const ctrlS = () => fireEvent.keyDown(view().contentDOM, { key: 's', ctrlKey: true });
  /** 사용자가 본문 끝에 친 것과 같다 (프로그램 교체가 아닌 일반 입력). */
  const type = (extra: string) =>
    act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: extra }, userEvent: 'input.type' }));
  return { ...s, ref, view, type, ctrlS, unmount: utils.unmount };
}

const dirtyMark = () => screen.queryByText('저장 안 됨');

describe('편집기', () => {
  it('노트를 열면 본문이 보인다', async () => {
    const m = mount({ [P]: '# 제목\r\n본문\r\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('# 제목\n본문\n'));
    expect(m.view().contentDOM.textContent).toContain('본문'); // 화면에도 그려졌다
    expect(m.view().contentDOM.getAttribute('aria-label')).toBe('노트 편집기');
    expect(dirtyMark()).toBeNull(); // 읽기만 했을 때는 저장 안 됨 표시가 없다
  });

  it('개발 모드의 StrictMode(effect 두 번 실행)에서도 열린다', async () => {
    const s = setup({ [P]: 'a\n' });
    const { container } = render(
      <StrictMode>
        <Editor path={P} invoke={s.invoke} listen={s.listen} />
      </StrictMode>,
    );
    const root = (container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
    await waitFor(() => expect(root.querySelector('.cm-content')?.textContent).toBe('a'));
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(1); // 첫 번째 뷰는 치워졌다
  });

  it('되돌리기를 끝까지 눌러도 열 때 채운 본문까지 지우지 않고, 빈 노트를 저장하지 않는다', async () => {
    const m = mount({ [P]: 'keep me\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('keep me\n'));
    await m.type('x');
    await act(async () => {
      undo(m.view());
      undo(m.view()); // 사용자가 친 것은 이미 되돌렸다: 두 번째는 되돌릴 것이 없어야 한다
      undo(m.view());
    });
    expect(m.view().state.doc.toString()).toBe('keep me\n');
    await new Promise((r) => setTimeout(r, 200)); // 자동 저장 시간이 지나도
    expect(m.files[P]).toBe('keep me\n');
    expect(m.writes()).toBe(0);
  });

  it('다시 불러온 뒤 되돌리기를 눌러도 불러오기 전 본문으로 돌아가지 않는다', async () => {
    const user = userEvent.setup();
    const m = mount({ [P]: 'mine\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\n';
    await m.emit({ path: P, kind: 'modified' });
    await user.click(await screen.findByRole('button', { name: /다시 불러오기/ }));
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('theirs\n'));
    await act(async () => {
      undo(m.view());
      undo(m.view());
    });
    expect(m.view().state.doc.toString()).toBe('theirs\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(m.files[P]).toBe('theirs\n');
    expect(m.writes()).toBe(0);
  });

  it('고치면 저장 안 됨 표시가 뜬다', async () => {
    const m = mount({ [P]: 'a\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    await m.type('b');
    expect(dirtyMark()).toBeTruthy();
    expect(m.writes()).toBe(0); // 아직 쓰지 않았다
  });

  it('저장하면 표시가 사라진다 (Ctrl+S)', async () => {
    const m = mount({ [P]: 'a\r\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    await m.type('b');
    expect(dirtyMark()).toBeTruthy();

    m.ctrlS();
    await waitFor(() => expect(dirtyMark()).toBeNull());
    expect(m.files[P]).toBe('a\r\nb'); // CRLF 도 그대로
  });

  it('입력이 2초 멈추면 저절로 저장된다 (짧게 줄인 시간으로)', async () => {
    const m = mount({ [P]: 'a\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    await m.type('b');
    await waitFor(() => expect(m.files[P]).toBe('a\nb'));
    await waitFor(() => expect(dirtyMark()).toBeNull());
  });

  it('연 노트가 밖에서 바뀌면 다시 불러오기 / 덮어쓰기를 묻고, 묻는 동안 자동 저장은 쓰지 않는다', async () => {
    const m = mount({ [P]: 'mine\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\n';
    await m.emit({ path: P, kind: 'modified' });

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('다시 불러오기');
    expect(dialog.textContent).toContain('덮어쓰기');
    // 자동 저장 시간(40ms)이 몇 번 지나도 남의 변경은 그대로다.
    await new Promise((r) => setTimeout(r, 200));
    expect(m.files[P]).toBe('theirs\n');
    expect(m.writes()).toBe(0);
    // 묻는 동안 본문은 바뀌지 않는다.
    expect(m.view().state.doc.toString()).toBe('mine\n!');
  });

  it('그대로 두기를 골라 계속 고쳐도 충돌이 풀리기 전에는 자동 저장하지 않고, Ctrl+S 는 다시 묻는다', async () => {
    const user = userEvent.setup();
    const m = mount({ [P]: 'mine\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\n';
    await m.emit({ path: P, kind: 'modified' });
    await user.click(await screen.findByRole('button', { name: '그대로 두기' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await m.type('?'); // 새 입력은 자동 저장 시간을 다시 건다
    await new Promise((r) => setTimeout(r, 200));
    expect(m.writes()).toBe(0);
    expect(m.files[P]).toBe('theirs\n');
    expect(screen.getByText('저장하지 않았습니다: 디스크의 노트가 다릅니다')).toBeTruthy();
    m.ctrlS();
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(m.writes()).toBe(0);
  });

  it('closing the external-change dialog returns focus to the editor', async () => {
    const user = userEvent.setup();
    const m = mount({ [P]: 'mine\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    const shadow = m.view().root as ShadowRoot;
    act(() => m.view().contentDOM.focus());
    expect(shadow.activeElement).toBe(shadow.querySelector('.cm-content'));
    m.files[P] = 'theirs\n';
    await m.emit({ path: P, kind: 'modified' });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.contains(document.activeElement)).toBe(true); // 대화상자가 초점을 가져갔다
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(shadow.activeElement).toBe(shadow.querySelector('.cm-content'));
  });

  it('덮어쓰기를 고르면 내 내용이 저장되고 대화상자가 닫힌다', async () => {
    const user = userEvent.setup();
    const m = mount({ [P]: 'mine\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\n';
    await m.emit({ path: P, kind: 'modified' });
    await user.click(await screen.findByRole('button', { name: /덮어쓰기/ }));
    await waitFor(() => expect(m.files[P]).toBe('mine\n!'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dirtyMark()).toBeNull();
  });

  it('덮어쓰기를 고르는 사이 또 바뀌면 덮어쓰지 않고 새 내용으로 다시 묻는다', async () => {
    const user = userEvent.setup();
    const m = mount({ [P]: 'mine\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\n';
    await m.emit({ path: P, kind: 'modified' });
    const overwrite = await screen.findByRole('button', { name: /덮어쓰기/ });
    m.files[P] = 'third\n'; // 대화상자를 읽는 동안 세 번째 변경 (이벤트는 아직 안 왔다)
    await user.click(overwrite);
    await waitFor(() => expect(m.writes()).toBe(1)); // 시도는 했다 — 그리고 Rust 가 거절했다
    expect(m.files[P]).toBe('third\n');
    expect(await screen.findByRole('alertdialog')).toBeTruthy(); // 여전히 묻고 있다
  });

  it('다시 불러오기를 고르면 디스크 내용으로 바뀌고 수정은 버려진다', async () => {
    const user = userEvent.setup();
    const m = mount({ [P]: 'mine\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\r\n';
    await m.emit({ path: P, kind: 'modified' });
    await user.click(await screen.findByRole('button', { name: /다시 불러오기/ }));
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('theirs\n'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(dirtyMark()).toBeNull();
    expect(m.files[P]).toBe('theirs\r\n');
  });

  it('고친 것이 없으면 밖의 변경을 묻지 않고 조용히 새 내용을 보여 준다', async () => {
    const m = mount({ [P]: 'one\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('one\n'));
    m.files[P] = 'two\n';
    await m.emit({ path: P, kind: 'modified' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('two\n'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('내 저장이 일으킨 이벤트나 다른 노트의 이벤트는 묻지 않고 디스크를 다시 읽지도 않는다', async () => {
    const m = mount({ [P]: 'a\n', 'other.md': 'x' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    await m.type('b');
    await act(async () => void (await m.ref.current!.flush()));
    await m.emit({ path: P, kind: 'modified' }); // 내 저장의 메아리: 디스크 == 방금 쓴 내용
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const reads = m.calls.filter((c) => c === 'vault_read').length;
    await m.emit({ path: 'other.md', kind: 'modified' });
    expect(m.calls.filter((c) => c === 'vault_read').length).toBe(reads);
  });

  it('이벤트 페이로드의 필드 이름은 Rust 가 보내는 이름이다(공유 픽스처)', async () => {
    const { fields, kinds } = EVENTS_FIXTURE.vaultChanged.payload;
    const m = mount({ [P]: 'mine\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\n';
    await m.emit({ [fields.path]: P, [fields.kind]: kinds.modified } as unknown as VaultChange);
    expect(await screen.findByRole('button', { name: /다시 불러오기/ })).toBeTruthy();
  });

  it('연 노트가 밖에서 지워지면 알리고, 자동 저장으로 되살리지 않는다', async () => {
    const user = userEvent.setup();
    const m = mount({ [P]: 'a\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    delete m.files[P];
    await m.emit({ path: P, kind: 'removed' });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('사라졌습니다');
    expect(dialog.textContent).not.toContain('다시 불러오기'); // 불러올 것이 없다

    await user.click(screen.getByRole('button', { name: '그대로 두기' }));
    await m.type('b'); // 편집은 계속할 수 있지만
    await new Promise((r) => setTimeout(r, 200)); // 자동 저장 시간이 지나도
    expect(P in m.files).toBe(false); // 파일을 만들지 않는다
    expect(m.writes()).toBe(0);

    // 사용자가 Ctrl+S 를 누르면 쓰는 대신 다시 묻는다.
    m.ctrlS();
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(P in m.files).toBe(false);

    await user.click(screen.getByRole('button', { name: '이 위치에 다시 저장' }));
    await waitFor(() => expect(m.files[P]).toBe('a\nb'));
  });

  it('노트가 들어 있던 폴더가 지워지거나 이름이 바뀌어도 알아챈다', async () => {
    const m = mount({ [P]: 'a\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    delete m.files[P];
    await m.emit({ path: 'lab', kind: 'removed' });
    expect((await screen.findByRole('alertdialog')).textContent).toContain('사라졌습니다');
  });

  it('flush: 충돌 중이면 false 를 돌려주어 다른 노트로 넘어가지 못하게 한다', async () => {
    const m = mount({ [P]: 'mine\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    expect(await m.ref.current!.flush()).toBe(true); // 깨끗하면 바로 true
    await m.type('!');
    m.files[P] = 'theirs\n';
    let ok = true;
    await act(async () => void (ok = await m.ref.current!.flush()));
    expect(ok).toBe(false);
    expect(m.files[P]).toBe('theirs\n');
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('줄바꿈이 섞인 노트: 한 글자를 넣어도 다른 줄의 줄바꿈은 그대로다', async () => {
    const m = mount({ [P]: 'a\r\nb\nc\r\n' });
    await waitFor(() => expect(m.view().state.sliceDoc()).toBe('a\r\nb\nc\r\n')); // 본문이 정규화되지 않았다
    expect(m.view().state.lineBreak).toBe('\r\n');
    await act(async () => m.view().dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' }));
    m.ctrlS();
    await waitFor(() => expect(dirtyMark()).toBeNull());
    expect(m.files[P]).toBe('Xa\r\nb\nc\r\n');
  });

  it('계속 치는 중에도 최대 간격이 지나면 저장한다 (무입력 대기는 끝내 오지 않는다)', async () => {
    const m = mount({ [P]: 'a\n' }, 150, { maxAutosaveMs: 250 });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    for (let i = 0; i < 10; i++) {
      await m.type('x');
      await new Promise((r) => setTimeout(r, 40)); // 150ms 무입력은 한 번도 없다
    }
    // 마지막 입력 직후다: 무입력 시간(150ms)으로는 저장될 수 없었다.
    expect(m.writes()).toBeGreaterThanOrEqual(1);
    expect(m.files[P].startsWith('a\nx')).toBe(true);
  });

  it('저장이 일시적으로 실패하면 키를 다시 치지 않아도 다시 시도해 저장한다', async () => {
    const m = mount({ [P]: 'a\n' }, 40, { failWrites: 1 });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    await m.type('b');
    expect(await screen.findByText('저장하지 못했습니다. 내용은 편집기에 그대로 있습니다.')).toBeTruthy();
    await waitFor(() => expect(m.files[P]).toBe('a\nb'));
    expect(m.writes()).toBe(2); // 실패 한 번 + 재시도
    await waitFor(() => expect(screen.queryByText(/저장하지 못했습니다/)).toBeNull());
    expect(dirtyMark()).toBeNull();
  });

  describe('개요', () => {
    it('outline click puts the cursor on the heading line itself (reveal scrolls it to the top)', async () => {
      const m = mount({ [P]: 'a\nb\nc\nd\n### [UHW010 PCR]\nbody' });
      await waitFor(() => expect(m.view().state.doc.lines).toBe(6));
      const view = m.view();
      const dispatch = vi.spyOn(view, 'dispatch');
      act(() => m.ref.current!.reveal({ line: 4 }));
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
      expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
      // 맨 위로 붙이는 scrollIntoView 효과로 옮긴다(단순한 scrollIntoView: true 가 아니다)
      const spec = dispatch.mock.calls[0][0] as { effects?: unknown; scrollIntoView?: boolean };
      expect(spec.scrollIntoView).toBeUndefined();
      const ref = EditorView.scrollIntoView(view.state.doc.line(5).from, { y: 'start', yMargin: 8 });
      const effect = spec.effects as typeof ref;
      // 같은 종류(ScrollTarget)의 값이다
      expect(effect.value).toBeInstanceOf((ref.value as object).constructor);
      const target = effect.value as { range: { from: number; to: number }; y: string; yMargin: number };
      const expected = ref.value as typeof target;
      expect(target.y).toBe('start');
      expect(target.yMargin).toBe(8);
      expect({ from: target.range.from, to: target.range.to }).toEqual({ from: expected.range.from, to: expected.range.to });
    });

    it('publishes the outline on load, 300 ms after edits, and clears it on unmount', async () => {
      const m = mount({ [P]: '# A\nbody\n' });
      await waitFor(() => expect(getOutline()).toEqual({ path: P, items: [{ level: 1, text: 'A', kind: 'heading', line: 1 }], cursorLine: 1 }));
      await m.type('## B\n');
      expect(getOutline()!.items).toHaveLength(1); // 바로는 아니다
      await waitFor(() => expect(getOutline()!.items.map((i) => i.text)).toEqual(['A', 'B']));
      m.unmount();
      expect(getOutline()).toBeUndefined();
    });

    it('publishes the cursor line when the selection moves, without an edit', async () => {
      const m = mount({ [P]: '# A\nx\n## B\ny\n' });
      await waitFor(() => expect(getOutline()?.items).toHaveLength(2));
      act(() => m.view().dispatch({ selection: { anchor: m.view().state.doc.line(4).from } }));
      await waitFor(() => expect(getOutline()!.cursorLine).toBe(4));
      expect(dirtyMark()).toBeNull();
      m.unmount();
    });

    it('mixed-EOL note (CRLF majority): outline lines match CodeMirror lines and the jump lands on the heading', async () => {
      const m = mount({ [P]: 'a\r\nb\nc\r\nd\r\n## H\r\nx' });
      await waitFor(() => expect(getOutline()?.items).toHaveLength(1));
      const view = m.view();
      // 줄 구분자가 CRLF 라 b\nc 는 한 줄이다
      const cmLine = Array.from({ length: view.state.doc.lines }, (_, i) => i + 1).find((n) => view.state.doc.line(n).text === '## H');
      expect(cmLine).toBe(4);
      const item = getOutline()!.items[0];
      expect(item.line).toBe(cmLine);
      act(() => m.ref.current!.reveal({ line: item.line - 1 }));
      expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('## H');
      m.unmount();
    });

    it('republishes the cursor line when an edit above moves it without a selection change', async () => {
      const m = mount({ [P]: '# A\nx\n## B\ny\n' });
      await waitFor(() => expect(getOutline()?.items).toHaveLength(2));
      act(() => m.view().dispatch({ selection: { anchor: m.view().state.doc.line(4).from } }));
      await waitFor(() => expect(getOutline()!.cursorLine).toBe(4));
      // 선택을 주지 않은 변경: 위에 두 줄을 넣는다(커서는 매핑만 된다)
      act(() => m.view().dispatch({ changes: { from: 0, insert: 'p\nq\n' } }));
      await waitFor(() => expect(getOutline()!.cursorLine).toBe(6));
      m.unmount();
    });
  });

  describe('창 닫기', () => {
    function fakeWindow() {
      let handler: (e: { preventDefault(): void }) => void | Promise<void> = () => {};
      const destroy = vi.fn(async () => {});
      const api: WindowApi = {
        onCloseRequested: async (h) => {
          handler = h;
          return () => {};
        },
        destroy,
      };
      /** 닫기 요청을 보내고, preventDefault 가 불렸는지 돌려준다. */
      const requestClose = async () => {
        const prevent = vi.fn();
        await act(async () => void (await handler({ preventDefault: prevent })));
        return prevent.mock.calls.length > 0;
      };
      return { api, destroy, requestClose };
    }

    it('저장 안 된 편집이 있으면 저장한 뒤에 닫는다', async () => {
      const w = fakeWindow();
      const m = mount({ [P]: 'a\n' }, 60_000, { windowApi: w.api });
      await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
      await m.type('b');
      expect(m.files[P]).toBe('a\n'); // 자동 저장은 아직 멀었다
      expect(await w.requestClose()).toBe(true); // 기본 닫기를 막고
      expect(m.files[P]).toBe('a\nb'); // 저장했고
      expect(w.destroy).toHaveBeenCalledTimes(1); // 그다음에 닫았다
    });

    it('저장이 던지면 닫기가 먹통이 되지 않고 저장 없이 닫을지 묻는다', async () => {
      const w = fakeWindow();
      const m = mount({ [P]: 'a\n' }, 60_000, { windowApi: w.api });
      await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
      await m.type('b');
      // flush() 가 거부되게 한다: 닫기 핸들러의 isDirty() 는 통과시키고, flush 안의 두 번째 읽기에서 편집기 상태가 던진다.
      // 그 읽기는 doSave 의 try 밖이다. 한 번만 던지게 해서 CodeMirror 내부에는 영향이 없다.
      const v = m.view();
      const real = v.state;
      let reads = 0;
      Object.defineProperty(v, 'state', {
        configurable: true,
        get() {
          if (++reads === 2) {
            Object.defineProperty(v, 'state', { configurable: true, value: real, writable: true });
            throw new Error('boom');
          }
          return real;
        },
      });
      expect(await w.requestClose()).toBe(true);
      expect(w.destroy).not.toHaveBeenCalled();
      expect(await screen.findByText(/저장하지 못해 창을 닫지 않았습니다/)).toBeTruthy();
    });

    it('고친 것이 없으면 그냥 닫는다', async () => {
      const w = fakeWindow();
      const m = mount({ [P]: 'a\n' }, 60_000, { windowApi: w.api });
      await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
      expect(await w.requestClose()).toBe(false);
      expect(m.writes()).toBe(0);
    });

    it('충돌로 저장하지 못하면 닫지 않는다 — 몇 번을 눌러도 닫히지 않고, 버릴지 명시적으로 묻는다', async () => {
      const user = userEvent.setup();
      const w = fakeWindow();
      const m = mount({ [P]: 'mine\n' }, 60_000, { windowApi: w.api });
      await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
      await m.type('!');
      m.files[P] = 'theirs\n';
      expect(await w.requestClose()).toBe(true);
      expect(w.destroy).not.toHaveBeenCalled();
      expect(m.files[P]).toBe('theirs\n');
      expect(await screen.findByRole('alertdialog')).toBeTruthy();
      expect(await screen.findByText(/저장하지 못해 창을 닫지 않았습니다/)).toBeTruthy();
      // 두 번째 닫기 요청도 조용히 닫지 않는다.
      expect(await w.requestClose()).toBe(true);
      expect(w.destroy).not.toHaveBeenCalled();
      // 버리겠다고 명시적으로 고르면 그때 닫는다.
      await user.click(screen.getByRole('button', { name: '저장하지 않고 닫기' }));
      expect(w.destroy).toHaveBeenCalledTimes(1);
    });

    it('충돌을 해결하면 가드가 그대로 살아 있다: 이후의 편집도 저장한 뒤에 닫는다', async () => {
      const user = userEvent.setup();
      const w = fakeWindow();
      const m = mount({ [P]: 'mine\n' }, 60_000, { windowApi: w.api });
      await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
      await m.type('!');
      m.files[P] = 'theirs\n';
      expect(await w.requestClose()).toBe(true); // 한 번 거절당했다
      await user.click(await screen.findByRole('button', { name: /덮어쓰기/ }));
      await waitFor(() => expect(m.files[P]).toBe('mine\n!'));
      expect(screen.queryByText(/저장하지 못해 창을 닫지 않았습니다/)).toBeNull(); // 저장되면 묻던 것도 사라진다

      await m.type('?'); // 한참 뒤의 새 편집
      expect(await w.requestClose()).toBe(true); // 이번에도 기본 닫기를 막고
      expect(m.files[P]).toBe('mine\n!?'); // 저장하고
      expect(w.destroy).toHaveBeenCalledTimes(1); // 닫는다
    });

    it('계속 편집을 고르면 질문이 닫히고 창은 그대로 있다', async () => {
      const user = userEvent.setup();
      const w = fakeWindow();
      const m = mount({ [P]: 'mine\n' }, 60_000, { windowApi: w.api });
      await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
      await m.type('!');
      m.files[P] = 'theirs\n';
      await w.requestClose();
      await user.click(await screen.findByRole('button', { name: '계속 편집' }));
      expect(screen.queryByText(/저장하지 못해 창을 닫지 않았습니다/)).toBeNull();
      expect(w.destroy).not.toHaveBeenCalled();
    });
  });

  it('조용한 다시 읽기는 커서 위치를 그대로 두고, 새 본문이 짧아지면 끝으로 맞춘다', async () => {
    const m = mount({ [P]: 'abcdefghij\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('abcdefghij\n'));
    await act(async () => m.view().dispatch({ selection: { anchor: 6 } }));
    m.files[P] = 'ABCDEFGHIJKLMNOP\n';
    await m.emit({ path: P, kind: 'modified' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('ABCDEFGHIJKLMNOP\n'));
    expect(m.view().state.selection.main.head).toBe(6); // 맨 앞(0)으로 튀지 않았다
    m.files[P] = 'AB\n';
    await m.emit({ path: P, kind: 'modified' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('AB\n'));
    expect(m.view().state.selection.main.head).toBe(3); // 길이 안으로 맞춘다
  });

  it('섞인 CRLF 노트로 조용히 다시 읽어도, 커서가 새 상태 길이를 넘는 자리에 있어도 낡은 버퍼를 저장하지 않는다', async () => {
    const m = mount({ [P]: 'abcdefghijklmnopqrstuvwxyz\n' }, 40);
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('abcdefghijklmnopqrstuvwxyz\n'));
    await act(async () => m.view().dispatch({ selection: { anchor: 17 } }));
    // 새 본문: CRLF 줄 6개 + LF 줄 1개. 글자 수는 20 이지만 CodeMirror 상태에서는 CRLF 가 한 칸이라 14 다.
    // 커서 17 은 14 보다 크고 20 보다 작다: 글자 수로 자르면 RangeError 다.
    const theirs = 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\nh\n';
    expect(theirs.length).toBe(20);
    m.files[P] = theirs;
    await m.emit({ path: P, kind: 'modified' });
    await waitFor(() => expect(m.view().state.sliceDoc()).toBe(theirs));
    expect(m.view().state.doc.length).toBe(14);
    expect(m.view().state.selection.main.head).toBeLessThanOrEqual(14);
    await new Promise((r) => setTimeout(r, 200)); // 자동 저장 시간이 지나도
    expect(m.files[P]).toBe(theirs); // 밖에서 들어온 내용 그대로다
    expect(m.writes()).toBe(0);
    expect(dirtyMark()).toBeNull();
  });

  it('되돌려서 깨끗해지면 닫기 질문도 거둔다', async () => {
    const w = (() => {
      let handler: (e: { preventDefault(): void }) => void | Promise<void> = () => {};
      const api: WindowApi = {
        onCloseRequested: async (h) => {
          handler = h;
          return () => {};
        },
        destroy: async () => {},
      };
      return { api, close: () => act(async () => void (await handler({ preventDefault: () => {} }))) };
    })();
    const m = mount({ [P]: 'mine\n' }, 60_000, { windowApi: w.api });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('mine\n'));
    await m.type('!');
    m.files[P] = 'theirs\n';
    await w.close();
    expect(await screen.findByText(/저장하지 못해 창을 닫지 않았습니다/)).toBeTruthy();
    await act(async () => {
      m.view().dispatch({ changes: { from: 0, to: m.view().state.doc.length, insert: 'mine\n' } }); // 읽을 때의 본문으로 되돌렸다
    });
    expect(screen.queryByText(/저장하지 못해 창을 닫지 않았습니다/)).toBeNull();
  });

  it('줄바꿈이 섞인 노트의 소수 쪽 줄 끝은 눈에 보이는 기호로 나온다', async () => {
    const m = mount({ [P]: 'a\r\nb\nc\r\n' });
    await waitFor(() => expect(m.view().state.sliceDoc()).toBe('a\r\nb\nc\r\n'));
    expect(m.view().contentDOM.querySelectorAll('.cm-specialChar').length).toBe(1); // b 줄 끝의 단독 LF
    const pure = mount({ [P]: 'a\nb\n' });
    await waitFor(() => expect(pure.view().state.doc.toString()).toBe('a\nb\n'));
    expect(pure.view().contentDOM.querySelectorAll('.cm-specialChar').length).toBe(0); // 평범한 노트에는 기호가 없다
  });

  it('저장이 계속 실패하면 간격을 늘려 몇 번만 다시 시도하고 멈춘다 (경고는 남는다)', async () => {
    const m = mount({ [P]: 'a\n' }, 15, { failWrites: 1000 });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('a\n'));
    await m.type('b');
    await waitFor(() => expect(m.writes()).toBe(MAX_SAVE_ATTEMPTS), { timeout: 3000 }); // 15+30+60+120 ms 뒤
    await new Promise((r) => setTimeout(r, 400)); // 더 기다려도
    expect(m.writes()).toBe(MAX_SAVE_ATTEMPTS); // 더 시도하지 않는다
    expect(screen.getByText(/저장하지 못했습니다/)).toBeTruthy();
    expect(m.files[P]).toBe('a\n');
  });
});

/** 색이 들어갈 수 있는 값에서 var(--…) 참조를 걷어 내고 남는 것(16진수·rgb()·이름 있는 색)을 돌려준다. */
const bareColours = (value: string) =>
  (value.replace(/var\(--[\w-]+\)/g, '').match(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(|\b[a-z]{3,}\b/gi) ?? []).filter(
    (w) => !['solid', 'none', 'underline', 'line', 'through', 'italic'].includes(w),
  );

/** 마운트된 편집기의 그림자 루트에 들어간 스타일 전체(<style> 이든 adoptedStyleSheets 든). */
const shadowCss = (root: ShadowRoot) =>
  [
    ...Array.from(root.querySelectorAll('style')).map((s) => s.textContent ?? ''),
    ...Array.from(root.adoptedStyleSheets ?? []).map((sheet) => Array.from(sheet.cssRules).map((r) => r.cssText).join('\n')),
  ].join('\n');

/** 스타일 텍스트에서 `.클래스 { … color: X … }` 를 읽어 클래스 → 글자색. */
function colourByClass(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/^\.(\S+) \{([^}]*)\}/gm)) {
    const c = /(?:^|[;\s])color:\s*([^;]+)/.exec(m[2]);
    if (c) out.set(m[1], c[1].trim());
  }
  return out;
}

const COLOUR_PROP = /color|background|border|outline|shadow|decoration|fill|stroke/i;
const STRICT_PROP = /^(color|backgroundColor|background|caretColor|borderLeftColor)$/;
const SYSTEM = new Set(SYSTEM_COLOURS);

/**
 * 테마 스펙(EditorView.theme 의 객체)을 걸으며 박힌 색을 모은다. 비면 통과다. `checked` 에 본 선언을 적는다.
 * 시스템 색(Highlight, CanvasText …)은 키에 forced-colors 가 든 @-규칙 안에서만 허용한다: 그 밖에서는 토큰을 따라야 한다.
 */
function themeColourLeaks(spec: object, checked: string[] = [], atRule = ''): string[] {
  const leaks: string[] = [];
  for (const [prop, value] of Object.entries(spec)) {
    if (prop === 'tag') continue; // 구문 태그 객체는 색이 아니다
    if (value && typeof value === 'object') {
      leaks.push(...themeColourLeaks(value, checked, prop.startsWith('@') ? `${atRule} ${prop}`.trim() : atRule));
      continue;
    }
    if (!COLOUR_PROP.test(prop) || typeof value !== 'string') continue;
    checked.push(`${prop}: ${value}`);
    const forced = atRule.includes('forced-colors');
    const system = (w: string) => forced && SYSTEM.has(w.toLowerCase());
    const bare = bareColours(value).filter((w) => !system(w));
    if (bare.length) leaks.push(`${atRule} ${prop}: ${value}`.trim());
    else if (STRICT_PROP.test(prop) && !/^var\(--[\w-]+\)$/.test(value) && !system(value)) leaks.push(`${atRule} ${prop}: ${value}`.trim());
  }
  return leaks;
}

describe('편집기 테마', () => {
  it('에디터 테마가 색을 직접 박지 않고 토큰을 읽는다', () => {
    const checked: string[] = [];
    expect(themeColourLeaks(editorThemeSpec, checked)).toEqual([]);
    for (const spec of highlightSpec) expect(themeColourLeaks(spec, checked)).toEqual([]);
    expect(checked.length).toBeGreaterThan(10); // 검사기가 아무것도 안 본 게 아니다
    expect(checked).toContain('color: var(--text)');
    expect(checked).toContain('color: var(--accent)');
  });

  it('system colours pass only inside a forced-colors key', () => {
    expect(themeColourLeaks({ '@media (forced-colors: active)': { '.x': { outlineColor: 'Highlight' } } })).toEqual([]);
    expect(themeColourLeaks({ '@media (forced-colors: active)': { '.x': { outline: '2px solid CanvasText' } } })).toEqual([]);
    expect(themeColourLeaks({ '.x': { outlineColor: 'Highlight' } })).not.toEqual([]);
    // forced-colors 안에서도 시스템 색이 아닌 박힌 색은 걸린다
    expect(themeColourLeaks({ '@media (forced-colors: active)': { '.x': { outlineColor: 'red' } } })).not.toEqual([]);
    expect(themeColourLeaks({ '@media (forced-colors: active)': { '.x': { outline: '2px solid #fff' } } })).not.toEqual([]);
    // 다른 @media 키는 허용하지 않는다
    expect(themeColourLeaks({ '@media print': { '.x': { outlineColor: 'Highlight' } } })).not.toEqual([]);
  });

  it('forced-colors: the active table cell keeps a system-colour outline', () => {
    const fc = Object.entries(editorThemeSpec).filter(([k]) => k.includes('forced-colors'));
    expect(fc).toHaveLength(1);
    const rules = fc[0][1] as Record<string, Record<string, string>>;
    expect(rules['.lno-table .lno-cell-active']?.outline).toMatch(/Highlight|CanvasText/);
  });

  it('검사기는 박힌 색을 잡아낸다 (자기 점검)', () => {
    expect(bareColours('#fff')).not.toEqual([]);
    expect(bareColours('rgb(0,0,0)')).not.toEqual([]);
    expect(bareColours('red')).not.toEqual([]);
    expect(bareColours('underline red')).not.toEqual([]);
    expect(bareColours('1px solid var(--border)')).toEqual([]);
    expect(bareColours('line-through')).toEqual([]);
  });

  it('CodeMirror 기본 테마가 박아 두는 요소(활성 줄·거터·패널·단추·입력·툴팁)를 토큰으로 덮어 둔다', () => {
    // 이 테마는 dark 로 표시하지 않아 기본 테마의 라이트 규칙이 켜져 있다: 같은 선택자 길이로 덮는다.
    for (const sel of ['.cm-activeLine', '.cm-gutters', '.cm-activeLineGutter', '.cm-panels', '.cm-panels-top', '.cm-panels-bottom', '.cm-button', '.cm-textfield', '.cm-tooltip', '.cm-tooltip-section:not(:first-child)', '.cm-content', '.cm-specialChar', '.cm-content ::selection'])
      expect(Object.keys(editorThemeSpec), sel).toContain(sel);
  });

  it('선택 영역은 기본 글자색(--text)을 쓴다: 강조색·흐린 글자가 선택 배경 위에서 4.5:1 아래로 내려가지 않게', () => {
    expect(editorThemeSpec['.cm-content ::selection']).toEqual({ background: 'var(--bg-selection)', color: 'var(--text)' });
  });

  it('테마 확장은 한 번만 만든다 (노트를 열 때마다 새 스타일 모듈이 쌓이지 않게)', async () => {
    expect(Array.isArray(editorTheme)).toBe(true);
    const m = mount({ [P]: 'one\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('one\n'));
    const root = m.view().root as ShadowRoot;
    const before = shadowCss(root);
    m.files[P] = 'two\n';
    await m.emit({ path: P, kind: 'modified' }); // 조용한 다시 읽기: 상태를 새로 만든다
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('two\n'));
    expect(shadowCss(root)).toBe(before);
  });

  it('마운트된 편집기의 스타일이 토큰을 읽고, 기본 구문 강조의 박힌 색은 없다', async () => {
    const m = mount({ [P]: '# 제목\n본문\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('# 제목\n본문\n'));
    const css = shadowCss(m.view().root as ShadowRoot);
    expect(css).toContain('var(--text)');
    expect(css).toMatch(/::selection[^{]*\{[^}]*var\(--bg-selection\)/); // 네이티브 선택(살아 있는 규칙)이 토큰을 읽는다
    expect(css).toContain('var(--accent)'); // 구문 강조(링크 등)가 토큰에서 온다
    // 기본 구문 강조 모듈의 색은 실제 모듈에서 읽는다
    const baked = new Set<string>();
    for (const spec of defaultHighlightStyle.specs) if (typeof spec.color === 'string') baked.add(spec.color.toLowerCase());
    expect(baked.size).toBeGreaterThan(8);
    for (const c of baked) expect(css.toLowerCase(), c).not.toContain(`color: ${c}`);
  });

  it('목록 안의 본문은 강조색이 아니고, 목록 기호는 흐린 색이다', async () => {
    const m = mount({ [P]: '- item text\n- second\n' });
    await waitFor(() => expect(m.view().state.doc.toString()).toBe('- item text\n- second\n'));
    const root = m.view().root as ShadowRoot;
    const colours = colourByClass(shadowCss(root));
    const line = root.querySelector('.cm-line') as HTMLElement;
    const colourOf = (el: Element | null) => {
      for (let e = el; e && e !== line.parentElement; e = e.parentElement) {
        for (const cls of Array.from(e.classList)) if (colours.has(cls)) return colours.get(cls);
      }
      return undefined;
    };
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let textEl: Element | null = null;
    let markEl: Element | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent?.includes('item text')) textEl = n.parentElement;
      if (n.textContent === '-') markEl = n.parentElement;
    }
    expect(textEl).not.toBeNull();
    expect(markEl).not.toBeNull();
    expect(colourOf(textEl)).not.toBe('var(--accent)');
    expect(colourOf(markEl)).toBe('var(--text-muted)');
  });
});
