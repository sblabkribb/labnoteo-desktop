// @vitest-environment jsdom
import { installFileDropGuard } from '../fileDropGuard';

/** jsdom 에는 DragEvent·DataTransfer 가 없다: 같은 모양의 사건을 꾸민다. */
function dragEvent(type: 'dragover' | 'drop', types: string[]): Event {
  // 실제 끌기 사건처럼 composed: 그림자 루트 밖으로 나오며 target 이 호스트로 바뀐다
  const ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types, files: [], dropEffect: 'copy' } });
  return ev;
}

let dispose: () => void = () => {};
afterEach(() => {
  dispose();
  document.body.innerHTML = '';
});

describe('창 전체의 파일 끌어 놓기 막이', () => {
  it('an OS file dragged over or dropped anywhere outside the editor is cancelled (no navigation to file://)', () => {
    dispose = installFileDropGuard(window);
    const sidebar = document.createElement('nav');
    document.body.appendChild(sidebar);
    const over = dragEvent('dragover', ['Files']);
    sidebar.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = dragEvent('drop', ['Files']);
    sidebar.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('a handler outside the editor that stops propagation does not let a file drop through', () => {
    dispose = installFileDropGuard(window);
    const panel = document.createElement('div');
    panel.addEventListener('drop', (e) => e.stopPropagation());
    document.body.appendChild(panel);
    const drop = dragEvent('drop', ['Files']);
    panel.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('inside the editor the drop reaches the editor uncancelled, and is cancelled after it if unhandled', () => {
    dispose = installFileDropGuard(window);
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const widget = document.createElement('div');
    editor.appendChild(widget);
    document.body.appendChild(editor);
    let seenByEditor: boolean | null = null;
    editor.addEventListener('drop', (e) => (seenByEditor = e.defaultPrevented));
    const drop = dragEvent('drop', ['Files']);
    widget.dispatchEvent(drop);
    expect(seenByEditor).toBe(false);
    expect(drop.defaultPrevented).toBe(true);
  });

  it('an editor inside an open shadow root (as Editor.tsx mounts it) still gets the drop uncancelled', () => {
    dispose = installFileDropGuard(window);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    editor.appendChild(content);
    shadow.appendChild(editor);
    let seenByEditor: boolean | null = null;
    content.addEventListener('drop', (e) => (seenByEditor = e.defaultPrevented));
    const drop = dragEvent('drop', ['Files']);
    content.dispatchEvent(drop);
    expect(seenByEditor).toBe(false);
    expect(drop.defaultPrevented).toBe(true);
    // 같은 호스트의 그림자 루트 안이라도 편집기 밖이면 막는다
    const other = document.createElement('div');
    shadow.appendChild(other);
    let seenOutside: boolean | null = null;
    other.addEventListener('drop', (e) => (seenOutside = e.defaultPrevented));
    other.dispatchEvent(dragEvent('drop', ['Files']));
    expect(seenOutside).toBe(true);
  });

  it('a drag without files (text, an in-page drag) is left alone', () => {
    dispose = installFileDropGuard(window);
    const over = dragEvent('dragover', ['text/plain']);
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    const drop = dragEvent('drop', ['text/plain']);
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
  });

  it('the disposer removes the listeners', () => {
    installFileDropGuard(window)();
    const drop = dragEvent('drop', ['Files']);
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
  });
});
