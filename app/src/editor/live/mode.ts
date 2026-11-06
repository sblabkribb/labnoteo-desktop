/**
 * 편집기 보기 방식의 저장소: 라이브 미리보기('live') 또는 소스 보기('source'). 사용자마다 하나(볼트 설정이 아니다 — 테마처럼
 * 화면 취향이다). 기본은 'live'.
 *
 * 편집기는 노트를 읽거나 다시 읽을 때마다 상태를 통째로 새로 만든다(Editor.tsx 의 adopt). 그래서 모드는 상태 안이 아니라
 * 이 모듈에 산다: 새 상태가 여기서 모드를 읽고, 바뀌면 띄워 둔 편집기마다 모드 칸(Compartment)을 갈아 끼운다.
 * 저장소가 없거나 던져도 편집기는 뜬다(lang.ts, useTheme 과 같다): 이번 실행에서는 메모리의 값이 쓰인다.
 */
export type EditorMode = 'live' | 'source';

export const MODE_KEY = 'labnoteo-editor-mode';

/** 라이브 미리보기와 소스 보기를 오가는 키(CodeMirror 표기). */
export const TOGGLE_MODE_KEY = 'Mod-e';

const isMode = (v: unknown): v is EditorMode => v === 'live' || v === 'source';

function stored(): EditorMode | undefined {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return isMode(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

let current: EditorMode = stored() ?? 'live';
const listeners = new Set<(m: EditorMode) => void>();

export function getMode(): EditorMode {
  return current;
}

/** 바꾸고 저장한 뒤 구독자에게 알린다. 저장하지 못해도 이번 실행에는 적용된다. 모르는 값은 받지 않는다. */
export function setMode(m: EditorMode): void {
  if (!isMode(m)) return;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // 저장소를 쓸 수 없다
  }
  if (m === current) return;
  current = m;
  for (const l of [...listeners]) l(m);
}

export function subscribeMode(fn: (m: EditorMode) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** 다른 모드로 바꾸고 새 모드를 돌려준다. */
export function toggleMode(): EditorMode {
  setMode(current === 'live' ? 'source' : 'live');
  return current;
}
