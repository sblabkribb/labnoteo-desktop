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
  // 첫 그림 전에 적용해 라이트가 번쩍이지 않게 한다.
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
