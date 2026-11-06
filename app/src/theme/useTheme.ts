import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type Theme = 'system' | 'dark' | 'light';

export const THEME_KEY = 'labnoteo.theme';

/** 네이티브 창의 테마를 바꾸는 이음새. 기본은 Tauri 창. `null` 이면 창이 다시 OS 설정을 따른다. */
export interface ThemeWindowApi {
  setTheme(theme: 'light' | 'dark' | null): Promise<void>;
}

const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'dark' || v === 'light';

/** 저장소가 막혀 있거나 값이 이상하면 시스템 설정을 따른다. 읽기가 던져도 앱은 뜬다. */
function load(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** `system` 이면 속성을 지워 app.css 의 prefers-color-scheme 규칙이 이기게 한다. */
function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/**
 * 제목 표시줄(네이티브 창)도 같은 테마로 맞춘다: 그러지 않으면 라이트 OS 에서 다크를 고른 사람이 다크 앱 위에 라이트 제목 표시줄을 본다.
 * 실패해도 앱 안의 테마는 이미 바뀌었으므로 조용히 넘어간다(권한이 없거나, Tauri 창이 없는 테스트 환경).
 */
function applyToWindow(theme: Theme, win: ThemeWindowApi | undefined) {
  try {
    const w = win ?? (getCurrentWindow() as unknown as ThemeWindowApi);
    w.setTheme(theme === 'system' ? null : theme).catch(() => undefined);
  } catch {
    // 창 API 가 없다
  }
}

export function useTheme(windowApi?: ThemeWindowApi): { theme: Theme; setTheme: (theme: Theme) => void } {
  const [theme, set] = useState<Theme>(load);
  const win = useRef(windowApi);
  win.current = windowApi;
  // React 가 뜬 뒤의 기준은 이 훅이다. 그 전의 첫 프레임은 public/theme-boot.js 가 맡는다: index.html 의 <head> 에서
  // 같은 출처의 막는 고전 스크립트로 불려(CSP script-src 'self' 는 인라인 스크립트만 막는다) 같은 키의 저장값을 data-theme 에 미리 건다.
  // 그래서 수동 선택이 시스템 테마와 달라도 시스템 테마가 한 프레임 비치지 않는다. 여기서 다시 적용해도 같은 값이라 바뀌는 것이 없다.
  useLayoutEffect(() => apply(theme), [theme]);
  // 시작할 때도 건다: 저장된 선택이 다크면 제목 표시줄도 다크로 맞춘다.
  useEffect(() => applyToWindow(theme, win.current), [theme]);
  const setTheme = (next: Theme) => {
    set(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 저장하지 못해도 이번 실행에는 적용된다.
    }
  };
  return { theme, setTheme };
}
