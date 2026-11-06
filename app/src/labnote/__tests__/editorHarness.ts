import { createElement, createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { Editor, type EditorHandle } from '../../editor/Editor';
import type { FakeVault } from '../../__tests__/fakeVault';
import type { ListenFn } from '../../vault/useVaultEvents';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
// 그림자 루트 안에서 포커스를 주면 CodeMirror 가 선택을 읽으려고 execCommand 를 부른다(jsdom 에는 없다).
document.execCommand ??= () => false;

/** 가짜 보관함 위에 편집기 하나를 연다. 자동 저장은 길게 두어 테스트가 저장 시점을 정한다. */
export function mountEditor(
  vault: FakeVault,
  path: string,
  extra: { initialReveal?: { line: number; ch?: number }; autosaveMs?: number } = {},
) {
  const ref = createRef<EditorHandle>();
  const utils = render(
    createElement(Editor, {
      ref,
      path,
      invoke: vault.invoke,
      listen: vault.listen as unknown as ListenFn,
      autosaveMs: extra.autosaveMs ?? 60_000,
      maxAutosaveMs: 600_000,
      windowApi: vault.window,
      initialReveal: extra.initialReveal,
    }),
  );
  const view = () => {
    const root = (utils.container.querySelector('section > div') as HTMLElement).shadowRoot!;
    return EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
  };
  /** 사용자가 `at`(기본: 끝)에 친 것과 같다. */
  const type = (text: string, at?: number) =>
    act(async () => {
      const v = view();
      v.dispatch({ changes: { from: at ?? v.state.doc.length, insert: text }, userEvent: 'input.type' });
    });
  const loaded = () => waitFor(() => expect(ref.current?.busy()).toBe(false));
  const writes = () => vault.log.filter((c) => c.cmd === 'vault_modify').length;
  return { ...utils, ref, view, type, loaded, writes };
}
