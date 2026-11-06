import { useLayoutEffect, useState } from 'react';

export type Theme = 'system' | 'dark' | 'light';

export const THEME_KEY = 'labnoteo.theme';

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

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const [theme, set] = useState<Theme>(load);
  // React 가 뜬 뒤의 기준은 이 훅이다. 그 전의 첫 프레임은 public/theme-boot.js 가 맡는다: index.html 의 <head> 에서
  // 같은 출처의 막는 고전 스크립트로 불려(CSP script-src 'self' 는 인라인 스크립트만 막는다) 같은 키의 저장값을 data-theme 에 미리 건다.
  // 그래서 수동 선택이 시스템 테마와 달라도 시스템 테마가 한 프레임 비치지 않는다. 여기서 다시 적용해도 같은 값이라 바뀌는 것이 없다.
  useLayoutEffect(() => apply(theme), [theme]);
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
