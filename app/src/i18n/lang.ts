/**
 * 화면 언어의 저장소. React 밖의 작은 저장소이고, 화면은 useLang(useSyncExternalStore)으로 읽는다.
 *
 * 왜 이 모양인가: 언어를 바꿔도 아무것도 다시 마운트하지 않는다. 저장소가 바뀌면 구독한 컴포넌트가 같은 자리에서
 * 다시 그려질 뿐이라, 편집기(CodeMirror 뷰)와 그 안의 저장 안 된 편집, 열린 대화상자, 입력 중인 글자가 그대로 남는다.
 * 루트의 key 를 바꿔 통째로 다시 그리는 방식은 그 모두를 버린다.
 *
 * 처음 고르기: 저장된 ko/en 이 있으면 그것, 없으면 navigator.language 가 ko 로 시작할 때만 ko, 그 밖에는 en.
 * public/lang-boot.js 가 첫 그림 전에 같은 규칙으로 html lang 을 건다(src/i18n/__tests__/langBoot.test.ts 가 맞춰 본다).
 * 저장소가 없거나 던져도 앱은 뜬다(useTheme 과 같다).
 */
export type Lang = 'ko' | 'en';

export const LANG_KEY = 'labnoteo.lang';

export const LANGS: readonly Lang[] = ['ko', 'en'];

/** 선택지마다 그 언어로 적은 이름: 지금 화면 언어를 못 읽는 사람도 자기 언어를 찾는다. 번역하지 않는다. */
export const LANG_NAMES: Record<Lang, string> = { ko: '한국어', en: 'English' };

export const isLang = (v: unknown): v is Lang => v === 'ko' || v === 'en';

function stored(): Lang | undefined {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return isLang(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function browser(): Lang {
  try {
    const l = navigator.language;
    return typeof l === 'string' && l.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}

let current: Lang = stored() ?? browser();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

/** 바꾸고 저장한다. 저장하지 못해도 이번 실행에는 적용된다. 모르는 값은 받지 않는다. */
export function setLang(next: Lang): void {
  if (!isLang(next)) return;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // 저장소를 쓸 수 없다
  }
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

export function subscribeLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** html lang: 화면 낭독기의 발음과 글꼴 선택이 화면 언어를 따른다. 첫 그림 전의 값은 lang-boot.js 가 건다. */
export function applyHtmlLang(lang: Lang): void {
  document.documentElement.lang = lang;
}
