// @vitest-environment jsdom
import { createElement, createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, undoDepth } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { labnoteMarkdown } from '../../markdownSyntax';
import { Editor, type EditorHandle, type WindowApi } from '../../Editor';
import { ERROR_KINDS_FIXTURE } from '../../../__tests__/fixtures';
import type { VaultChange } from '../../../vault/useVaultEvents';
import { tableExtension, findTables } from '../field';
import { activeCell, activeCellView, focusCell } from '../cellEditor';
import { insertTable } from '../commands';
import { tableAwareInsert, tableAwareInsertPos } from '../target';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const T = '| a | b |\n| --- | --- |\n| 1 | 2 |';

const stateOf = (doc: string, br?: string) =>
  EditorState.create({ doc, extensions: [labnoteMarkdown(), ...(br ? [EditorState.lineSeparator.of(br)] : [])] });

/** `tableAwareInsert` 를 적용한 문서(상태의 줄 구분자로 이은 것)와 커서. */
function apply(state: EditorState, pos: number, text: string): { doc: string; head: number; next: EditorState } {
  const next = state.update(tableAwareInsert(state, pos, text)).state;
  return { doc: next.sliceDoc(), head: next.selection.main.head, next };
}

describe('tableAwareInsertPos', () => {
  it('표 밖의 위치는 그대로 둔다', () => {
    const s = stateOf(`앞\n\n${T}\n\n뒤`);
    expect(tableAwareInsertPos(s, 0)).toBe(0);
    expect(tableAwareInsertPos(s, 1)).toBe(1);
    expect(tableAwareInsertPos(s, s.doc.length)).toBe(s.doc.length);
    expect(tableAwareInsertPos(s, 2)).toBe(2); // 표 앞의 빈 줄
  });

  it('표의 처음·가운데·끝은 표 다음의 빈 줄 시작으로 간다', () => {
    const doc = `앞\n\n${T}\n\n뒤`;
    const s = stateOf(doc);
    const from = 3;
    const to = from + T.length;
    const blank = to + 1;
    for (const pos of [from, from + 4, from + 12, to - 1, to]) expect(tableAwareInsertPos(s, pos), String(pos)).toBe(blank);
    expect(doc.slice(blank, blank + 2)).toBe('\n뒤');
  });

  it('표 바로 다음 줄에 글이 있으면 표의 끝을 준다(새 줄은 tableAwareInsert 가 만든다)', () => {
    const doc = `${T}\n# 다음`;
    const s = stateOf(doc);
    expect(tableAwareInsertPos(s, 5)).toBe(T.length);
  });

  it('문서 끝의 표: 끝 줄바꿈이 있으면 그 빈 줄, 없으면 표의 끝', () => {
    const withBr = stateOf(`${T}\n`);
    expect(tableAwareInsertPos(withBr, 3)).toBe(T.length + 1);
    const bare = stateOf(T);
    expect(tableAwareInsertPos(bare, 3)).toBe(T.length);
    expect(tableAwareInsertPos(bare, T.length)).toBe(T.length);
  });

  it('CRLF 문서에서도 같은 규칙이다(위치는 줄바꿈을 한 칸으로 센다)', () => {
    const crlf = `앞\r\n\r\n${T.replace(/\n/g, '\r\n')}\r\n\r\n뒤`;
    const s = stateOf(crlf, '\r\n');
    const span = findTables(s)[0];
    expect(s.sliceDoc(span.from, span.to)).toBe(T.replace(/\n/g, '\r\n'));
    expect(tableAwareInsertPos(s, span.from + 2)).toBe(span.to + 1);
    expect(s.doc.lineAt(span.to + 1).length).toBe(0);
    const bare = stateOf(T.replace(/\n/g, '\r\n'), '\r\n');
    expect(tableAwareInsertPos(bare, 0)).toBe(bare.doc.length);
  });

  it('인용 안의 표는 격자가 아니므로 그대로 둔다', () => {
    const s = stateOf(`> | a |\n> | --- |\n> | 1 |`);
    expect(tableAwareInsertPos(s, 4)).toBe(4);
  });
});

describe('tableAwareInsert', () => {
  it('표 안의 위치에 넣은 글은 빈 줄로 떨어진 표 아래에 선다: 표의 행이 되지 않는다', () => {
    const s = stateOf(`${T}\n# 다음`);
    const r = apply(s, 5, '삽입');
    expect(r.doc).toBe(`${T}\n\n삽입\n\n# 다음`);
    expect(r.doc.slice(r.head - 2, r.head)).toBe('삽입');
    expect(findTables(r.next).map((t) => r.doc.slice(t.from, t.to))).toEqual([T]);
  });

  it('표 다음의 빈 줄을 쓴다', () => {
    const r = apply(stateOf(`${T}\n\n뒤`), 0, '삽입');
    expect(r.doc).toBe(`${T}\n\n삽입\n\n뒤`);
  });

  it('문서 끝의 표 아래에는 새 줄을 만든다', () => {
    expect(apply(stateOf(T), T.length, '삽입').doc).toBe(`${T}\n\n삽입`);
    expect(apply(stateOf(`${T}\n`), 2, '삽입').doc).toBe(`${T}\n\n삽입`);
  });

  it('CRLF 문서에는 CRLF 로 줄을 만든다', () => {
    const crlf = T.replace(/\n/g, '\r\n');
    // 표 바로 다음의 파이프 없는 글은 GFM 에서 표의 행이다: 제목으로 표를 끝낸다
    const s = stateOf(`${crlf}\r\n# 뒤`, '\r\n');
    const r = apply(s, 3, '삽입');
    expect(r.doc).toBe(`${crlf}\r\n\r\n삽입\r\n\r\n# 뒤`);
    expect(r.next.sliceDoc(r.head - 2, r.head)).toBe('삽입');
  });

  it('표 밖에서는 그 자리에 그대로 넣는다', () => {
    const r = apply(stateOf(`앞\n\n${T}`), 1, '!');
    expect(r.doc).toBe(`앞!\n\n${T}`);
    expect(r.head).toBe(2);
  });
});

// ---------------------------------------------------------------- 편집기 위에서

const views: EditorView[] = [];
function mountView(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [history(), labnoteMarkdown(), tableExtension({ save: () => {}, root: document })] }),
  });
  views.push(v);
  return v;
}
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

describe('칸에 포커스가 있을 때의 블록 넣기', () => {
  it('표 넣기는 칸 안이 아니라 표 아래에 들어간다(되돌리기 한 번)', () => {
    const doc = `${T}\n# 다음`;
    const v = mountView(doc);
    expect(focusCell(v, 0, 0, 1)).toBe(true); // 머리 행: 커서 줄 다음에 넣으면 표가 둘로 갈라진다
    expect(activeCellView(v)).not.toBeNull();
    expect(insertTable(v, 2, 1)).toBe(true);
    expect(v.state.doc.toString()).toBe(`${T}\n\n|  |\n| --- |\n|  |\n\n# 다음`);
    expect(v.state.field(activeCell)).toEqual({ tableFrom: T.length + 2, r: 0, c: 0 });
    expect(undoDepth(v.state)).toBe(1);
    undo(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('문서 끝의 표에서도 표를 나누지 않는다', () => {
    const v = mountView(T);
    expect(focusCell(v, 0, 0, 0)).toBe(true);
    insertTable(v, 2, 1);
    expect(v.state.doc.toString()).toBe(`${T}\n\n|  |\n| --- |\n|  |`);
  });
});

// ---------------------------------------------------------------- 노트 전환·닫기·큰 노트

function vault(files: Record<string, string>) {
  const calls: string[] = [];
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
    const path = args.path as string;
    if (cmd === 'vault_read') {
      if (!(path in files)) throw { kind: ERROR_KINDS_FIXTURE.notFound, message: 'x' };
      return files[path];
    }
    if (cmd === 'vault_modify') {
      const current = files[path] ?? '';
      const expected = args.expectedBefore as string | undefined;
      if (expected !== undefined && expected !== current) return { kind: 'conflict', current };
      files[path] = args.content as string;
      return { kind: 'ok' };
    }
    throw new Error(`unexpected ${cmd}`);
  }) as never;
  const listen = (async (_e: string, _h: (e: { payload: VaultChange }) => void) => () => {}) as never;
  return { files, calls, invoke, listen };
}

const shadowView = (container: HTMLElement) => {
  const root = (container.querySelector('section > div') as HTMLElement).shadowRoot!;
  return EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
};
const cellIn = (v: EditorView, table: number, r: number, c: number) =>
  v.dom.querySelectorAll<HTMLElement>('.lno-table-wrap')[table].querySelector<HTMLTableElement>(':scope > .lno-table-scroll > table')!.rows[r]
    .cells[c] as HTMLElement;
const press = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
function type(nv: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = nv.state.selection.main;
    nv.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' });
  }
}

describe('편집기 통합', () => {
  const A = 'lab/a.labnote.md';
  const B = 'lab/b.labnote.md';
  const TWO = `# 두 표\n\n${T}\n\n사이 글\n\n| x | y |\n| :-- | --: |\n| 3 | 4 |\n`;

  it('두 표가 있는 노트에서 칸을 고치고 다른 노트로 갔다가 돌아오면 파일 내용이 정확하다', async () => {
    const vfs = vault({ [A]: TWO, [B]: '# B\n' });
    const ref = createRef<EditorHandle>();
    const el = (path: string) => createElement(Editor, { key: path, ref, path, invoke: vfs.invoke, listen: vfs.listen, autosaveMs: 60_000 });
    const u = render(el(A));
    await waitFor(() => expect(shadowView(u.container).state.readOnly).toBe(false));
    expect(shadowView(u.container).state.doc.toString()).toBe(TWO);

    const v = shadowView(u.container);
    const td = cellIn(v, 1, 1, 1);
    await act(async () => void press(td));
    const nv = activeCellView(v)!;
    expect(nv).not.toBeNull();
    nv.dispatch({ selection: { anchor: nv.state.doc.length } });
    await act(async () => type(nv, '0 mM'));

    // App 이 하듯이: 넘어가기 전에 flush, 그다음 key 를 바꿔 새로 마운트
    let ok = false;
    await act(async () => void (ok = await ref.current!.flush()));
    expect(ok).toBe(true);
    const want = TWO.replace('| 3 | 4 |', '| 3 | 40 mM |');
    expect(vfs.files[A]).toBe(want);
    u.rerender(el(B));
    await waitFor(() => expect(shadowView(u.container).state.doc.toString()).toBe('# B\n'));
    u.rerender(el(A));
    await waitFor(() => expect(shadowView(u.container).state.doc.toString()).toBe(want));
    expect(vfs.files[A]).toBe(want);
    expect(vfs.files[B]).toBe('# B\n');
    u.unmount();
  });

  it('창을 닫을 때의 저장(close-flush)에 칸에서 친 마지막 글자가 들어간다', async () => {
    const vfs = vault({ [A]: `${T.replace(/\n/g, '\r\n')}\r\n` });
    let handler: (e: { preventDefault(): void }) => void | Promise<void> = () => {};
    let destroyed = 0;
    const windowApi: WindowApi = {
      onCloseRequested: async (h) => {
        handler = h;
        return () => {};
      },
      destroy: async () => void destroyed++,
    };
    const u = render(createElement(Editor, { path: A, invoke: vfs.invoke, listen: vfs.listen, autosaveMs: 60_000, windowApi }));
    await waitFor(() => expect(shadowView(u.container).state.readOnly).toBe(false));
    const v = shadowView(u.container);
    await act(async () => void press(cellIn(v, 0, 1, 0)));
    const nv = activeCellView(v)!;
    nv.dispatch({ selection: { anchor: nv.state.doc.length } });
    await act(async () => type(nv, '23'));
    await act(async () => void (await handler({ preventDefault: () => {} })));
    expect(vfs.files[A]).toBe('| a | b |\r\n| --- | --- |\r\n| 123 | 2 |\r\n');
    expect(destroyed).toBe(1);
    u.unmount();
  });

  it('큰 노트(30×6 표 60개)도 jsdom 에서 1초 안에 열린다', async () => {
    const table = (k: number) => {
      const row = (r: number) => `| ${Array.from({ length: 6 }, (_, c) => `t${k}r${r}c${c}`).join(' | ')} |`;
      return [row(0), `| ${Array(6).fill('---').join(' | ')} |`, ...Array.from({ length: 29 }, (_, r) => row(r + 1))].join('\n');
    };
    const doc = `# 큰 노트\n\n${Array.from({ length: 60 }, (_, k) => table(k)).join('\n\n')}\n`;
    const vfs = vault({ [A]: doc });
    const started = performance.now();
    const u = render(createElement(Editor, { path: A, invoke: vfs.invoke, listen: vfs.listen, autosaveMs: 60_000 }));
    await waitFor(() => expect(shadowView(u.container).state.readOnly).toBe(false));
    const v = shadowView(u.container);
    expect(findTables(v.state).length).toBeGreaterThan(0);
    const tree = ensureSyntaxTree(v.state, v.state.doc.length, 5000)!;
    expect(tree.topNode.getChildren('Table')).toHaveLength(60);
    expect(v.dom.querySelectorAll('.lno-table-wrap').length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(v.state.doc.toString()).toBe(doc);
    u.unmount();
  });
});
