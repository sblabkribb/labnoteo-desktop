import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { layoutStore } from '../ui/layoutStore';

export type Theme = 'system' | 'dark' | 'light';

export const THEME_KEY = 'labnoteo.theme';

/**
 * 네이티브 창의 테마를 바꾸고 창을 보이는 이음새. 기본은 Tauri 창. `null` 이면 창이 다시 OS 설정을 따른다.
 * 창은 숨긴 채 뜬다(tauri.conf.json `visible: false`): `show` 는 첫 `setTheme` 과 `layoutStore.ready()` 가 끝나면(성공이든 실패든) 또는
 * `SHOW_FALLBACK_MS` 뒤에 한 번만 부른다. React 가 아예 뜨지 못하면 lib.rs 의 3 초 대비책이 창을 보인다.
 */
export interface ThemeWindowApi {
  setTheme(theme: 'light' | 'dark' | null): Promise<void>;
  show(): Promise<void>;
}

/** 첫 `setTheme` 이 돌아오지 않을 때 창을 보이기까지 기다리는 시간. */
export const SHOW_FALLBACK_MS = 1500;

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

/** `system` 이면 속성을 지워 styles/tokens.css 의 prefers-color-scheme 규칙이 이기게 한다. */
function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/**
 * 제목 표시줄(네이티브 창)도 같은 테마로 맞춘다: 그러지 않으면 라이트 OS 에서 다크를 고른 사람이 다크 앱 위에 라이트 제목 표시줄을 본다.
 * 실패해도 앱 안의 테마는 이미 바뀌었으므로 조용히 넘어간다(권한이 없거나, Tauri 창이 없는 테스트 환경).
 * 차가운 시작: 창은 숨긴 채 뜨고, `first` 이면 이 첫 IPC 가 끝난 뒤(또는 SHOW_FALLBACK_MS 뒤) 한 번만 창을 보인다.
 * 그래서 제목 표시줄이 OS 테마로 한 프레임 비치지 않는다. 본문의 첫 프레임은 theme-boot.js 가 맞춘다.
 */
function applyToWindow(theme: Theme, win: ThemeWindowApi | undefined, first: boolean) {
  let w: ThemeWindowApi;
  try {
    w = win ?? (getCurrentWindow() as unknown as ThemeWindowApi);
  } catch {
    return; // 창 API 가 없다
  }
  let shown = !first;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = () => {
    if (shown) return;
    shown = true;
    if (timer !== undefined) clearTimeout(timer);
    try {
      Promise.resolve(w.show()).catch(() => undefined);
    } catch {
      // 보이지 못해도 lib.rs 의 대비책이 3 초 뒤에 보인다
    }
  };
  if (first) timer = setTimeout(show, SHOW_FALLBACK_MS);
  let applied: Promise<void>;
  try {
    applied = Promise.resolve(w.setTheme(theme === 'system' ? null : theme));
  } catch {
    applied = Promise.resolve();
  }
  // 배치(ui.json 의 사이드바 너비·숨김)도 걸린 뒤에 보인다: 첫 프레임에 너비가 튀거나 숨긴 사이드바가 비치지 않는다.
  // ready() 는 거부하지 않는다(load 가 실패를 삼킨다). 걸리면 위의 SHOW_FALLBACK_MS 가 창을 보인다.
  Promise.all([applied.catch(() => undefined), layoutStore.ready()])
    .catch(() => undefined)
    .finally(show);
}

/** 열린 useTheme 들의 setTheme. 팔레트의 테마 명령(theme.system/light/dark)이 chooseTheme 으로 부른다. */
const choosers = new Set<(theme: Theme) => void>();

/** 팔레트 명령처럼 React 밖에서 테마를 고른다. 화면의 useTheme 이 하나도 없으면 저장만 하고 바로 건다. */
export function chooseTheme(theme: Theme): void {
  if (choosers.size === 0) {
    apply(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // 저장하지 못해도 이번 실행에는 적용된다.
    }
    return;
  }
  for (const fn of [...choosers]) fn(theme);
}

export function useTheme(windowApi?: ThemeWindowApi): { theme: Theme; setTheme: (theme: Theme) => void } {
  const [theme, set] = useState<Theme>(load);
  const win = useRef(windowApi);
  win.current = windowApi;
  // 창을 보이는 일은 이 훅 인스턴스의 첫 적용에서 한 번만 한다(StrictMode 의 이중 효과에도 ref 는 남는다).
  const firstRun = useRef(true);
  // React 가 뜬 뒤의 기준은 이 훅이다. 그 전의 첫 프레임은 public/theme-boot.js 가 맡는다: index.html 의 <head> 에서
  // 같은 출처의 막는 고전 스크립트로 불려(CSP script-src 'self' 는 인라인 스크립트만 막는다) 같은 키의 저장값을 data-theme 에 미리 건다.
  // 그래서 수동 선택이 시스템 테마와 달라도 시스템 테마가 한 프레임 비치지 않는다. 여기서 다시 적용해도 같은 값이라 바뀌는 것이 없다.
  useLayoutEffect(() => apply(theme), [theme]);
  // 시작할 때도 건다: 저장된 선택이 다크면 제목 표시줄도 다크로 맞춘다.
  useEffect(() => {
    const first = firstRun.current;
    firstRun.current = false;
    applyToWindow(theme, win.current, first);
  }, [theme]);
  const setTheme = (next: Theme) => {
    set(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 저장하지 못해도 이번 실행에는 적용된다.
    }
  };
  const latest = useRef(setTheme);
  latest.current = setTheme;
  useEffect(() => {
    const fn = (next: Theme) => latest.current(next);
    choosers.add(fn);
    return () => void choosers.delete(fn);
  }, []);
  return { theme, setTheme };
}
