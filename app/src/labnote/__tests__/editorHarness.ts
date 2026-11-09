import { createElement, createRef, type ReactNode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { Editor, type EditorHandle } from '../../editor/Editor';
import type { FakeVault } from '../../__tests__/fakeVault';
import type { ListenFn } from '../../vault/useVaultEvents';
import type { OpenTarget } from '../../editor/live/links';
import { toggleMode } from '../../editor/live/mode';
import type { SampleEditorConfig } from '../../samples/editorConfig';
import type { SampleEnv } from '../../samples/env';

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
  extra: {
    initialReveal?: { line: number; ch?: number };
    autosaveMs?: number;
    onContextMenu?: (e: MouseEvent, view: EditorView) => void;
    headerActions?: (busy: boolean) => ReactNode;
    onOpenLink?: (t: OpenTarget) => void;
    samples?: SampleEditorConfig | null;
    sampleEnv?: () => SampleEnv | undefined;
  } = {},
) {
  const ref = createRef<EditorHandle>();
  const props = (samples: SampleEditorConfig | null | undefined) =>
    createElement(Editor, {
      ref,
      path,
      invoke: vault.invoke,
      listen: vault.listen as unknown as ListenFn,
      autosaveMs: extra.autosaveMs ?? 60_000,
      maxAutosaveMs: 600_000,
      windowApi: vault.window,
      initialReveal: extra.initialReveal,
      onContextMenu: extra.onContextMenu,
      headerActions: extra.headerActions,
      onOpenLink: extra.onOpenLink,
      samples,
      sampleEnv: extra.sampleEnv,
    });
  const utils = render(props(extra.samples));
  /** 같은 props 에 새 샘플 설정으로 다시 그린다(앱이 저장소 판이 오른 뒤 하는 것과 같다). */
  const setSamples = (cfg: SampleEditorConfig | null) => utils.rerender(props(cfg));
  const view = () => {
    const root = (utils.container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
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
  /** 라이브 미리보기 ↔ 소스 보기(편집기의 Mod-e 와 같은 명령). 바꾼 뒤의 모드를 돌려준다. */
  const toggle = () => {
    void view();
    return toggleMode();
  };
  return { ...utils, ref, view, type, loaded, writes, toggleMode: toggle, setSamples };
}
