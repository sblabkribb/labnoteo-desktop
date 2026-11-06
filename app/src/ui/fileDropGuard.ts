/**
 * 창 전체의 OS 파일 끌어 놓기 막이.
 *
 * 이미지 끌어 놓기(편집기의 pasteImages)가 웹뷰에서 파일을 받으려면 창의 `dragDropEnabled` 를 꺼야 한다
 * (tauri.conf.json). 그러면 WebView2 가 바깥 파일 끌어 놓기를 허용한 채로 두므로, 페이지가 막지 않은 곳(사이드바,
 * 도구 모음, 표·이미지 위젯)에 놓은 파일은 브라우저 기본 동작으로 `file:///…` 로 이동해 앱이 사라진다.
 * 여기서 파일을 실은 dragover·drop 의 기본 동작을 취소한다. 글이나 창 안의 끌기(파일 없음)는 건드리지 않는다.
 * - 편집기(`.cm-editor`) 밖: 잡기 단계에서 바로 취소한다(전파를 멈추는 처리기가 있어도 새지 않는다).
 * - 편집기 안: 버블 단계에서만 취소한다. CodeMirror 는 이미 취소된 사건을 처리하지 않으므로, 편집기의 drop 처리기
 *   (pasteImages)가 먼저 돌아야 한다. 위젯(ignoreEvent)에 놓은 것은 편집기가 처리하지 않고 여기까지 올라온다.
 */
function carriesFiles(e: Event): boolean {
  const types = (e as DragEvent).dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

/**
 * 편집기 밖에서 일어난 사건인가. 편집기는 그림자 루트 안에 있다(Editor.tsx): 창의 수신기에서 `e.target` 은 그림자 호스트로
 * 바뀌어 있으므로 `closest` 로는 편집기를 찾지 못한다. 그림자 경계를 넘는 `composedPath()` 로 본다.
 */
const outsideEditor = (e: Event) =>
  !e.composedPath().some((n) => n instanceof Element && n.classList.contains('cm-editor'));

/** 막이를 단다. 돌려준 함수로 뗀다. */
export function installFileDropGuard(target: Window = window): () => void {
  const early = (e: Event) => {
    if (carriesFiles(e) && outsideEditor(e)) e.preventDefault();
  };
  const late = (e: Event) => {
    if (carriesFiles(e)) e.preventDefault();
  };
  for (const type of ['dragover', 'drop']) {
    target.addEventListener(type, early, { capture: true });
    target.addEventListener(type, late);
  }
  return () => {
    for (const type of ['dragover', 'drop']) {
      target.removeEventListener(type, early, { capture: true });
      target.removeEventListener(type, late);
    }
  };
}
