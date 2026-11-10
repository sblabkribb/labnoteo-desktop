import { existsSync, readFileSync } from 'node:fs';

import OLD_APP_CSS_SELECTORS from './appCssSelectors.json';
import { allCss, declarations, literalColours, parseRules, readStyles, STYLE_FILES, SYSTEM_COLOURS } from './css';

/** 규칙마다 `@-규칙 머리 선택자` (맨 바깥이면 선택자만). appCssSelectors.json 과 같은 모양. */
function selectorKeys(css: string): Set<string> {
  return new Set(parseRules(css).flatMap((r) => r.selectors.map((s) => (r.atRule ? `${r.atRule} ${s}` : s))));
}

const SYSTEM = new Set(SYSTEM_COLOURS);

/** 파일 하나의 선언 값에 든 날것의 색. forced-colors 블록 안의 CSS 시스템 색(Highlight, CanvasText …)은 세지 않는다. */
function coloursIn(css: string): string[] {
  return parseRules(css).flatMap((r) =>
    declarations(r.body).flatMap((d) =>
      literalColours(d.value).filter((c) => !(r.atRule?.includes('forced-colors') && SYSTEM.has(c.toLowerCase()))),
    ),
  );
}

describe('styles/*.css', () => {
  it('여섯 파일이 있고 main.tsx 가 tokens, shell, tree, menus, dialogs, viewers 순서로 불러온다', () => {
    expect(STYLE_FILES).toEqual(['tokens', 'shell', 'tree', 'menus', 'dialogs', 'viewers']);
    for (const name of STYLE_FILES) expect(existsSync(`src/styles/${name}.css`), name).toBe(true);
    const main = readFileSync('src/main.tsx', 'utf-8');
    // 따옴표가 든 정규식은 String.raw 로 쓴다(escapes.test.ts 가 정규식 리터럴 안의 따옴표를 문자열의 시작으로 읽는다)
    const IMPORT = new RegExp(String.raw`^import '\./styles/([\w-]+)\.css';$`, 'gm');
    const imports = [...main.matchAll(IMPORT)].map((m) => m[1]);
    expect(imports).toEqual([...STYLE_FILES]);
    // 다른 .css 는 main.tsx 가 부르지 않는다(예전 app.css 포함)
    expect(main.split('.css').length - 1).toBe(STYLE_FILES.length);
  });

  it('src/app.css 는 없다', () => {
    expect(existsSync('src/app.css')).toBe(false);
  });

  it('readStyles 는 불러오는 순서대로 파일을 주고, allCss 는 그 이음이다', () => {
    const styles = readStyles();
    expect(styles.map((s) => s.file)).toEqual(STYLE_FILES.map((n) => `src/styles/${n}.css`));
    expect(allCss()).toBe(styles.map((s) => s.text).join('\n'));
  });

  it('날것의 색 값은 tokens.css 에만 있다 (forced-colors 의 시스템 색은 예외)', () => {
    for (const { file, text } of readStyles()) {
      if (file.endsWith('/tokens.css')) expect(coloursIn(text).length, file).toBeGreaterThan(20);
      else expect(coloursIn(text), file).toEqual([]);
    }
  });

  it('색 검사기 자기 점검: 다른 파일에 넣은 색을 잡고, forced-colors 안의 시스템 색만 통과시킨다', () => {
    expect(coloursIn('.a { color: #123456; }')).toEqual(['#123456']);
    expect(coloursIn('.a { border: 1px solid gray; }')).toEqual(['gray']);
    expect(coloursIn('@media (forced-colors: active) { .a { outline: 2px solid Highlight; } }')).toEqual([]);
    expect(coloursIn('@media (forced-colors: active) { .a { outline: 2px solid red; } }')).toEqual(['red']);
    expect(coloursIn('.a { outline: 2px solid Highlight; }')).toEqual(['Highlight']);
  });

  it('예전 app.css 의 선택자는 하나도 빠짐없이 옮겨졌다', () => {
    expect(OLD_APP_CSS_SELECTORS.length).toBeGreaterThan(300);
    const now = selectorKeys(allCss());
    // 새 팔레트(Task 2)가 일부러 없앤 것: 예전 시스템 다크 선택자(이제 :root:not([data-theme])),
    // 컨테이너마다 단추 바탕을 되돌리던 --button-bg 규칙, 상단 바 select 의 바탕 덮기(입력은 이제 모두 --bg)
    // 셸 재설계(Task 5)가 일부러 없앤 것: 상단 바와 그 안의 새 노트 입력, ⌘ 단추, 글자 사이드바 탭, 640px 쌓기(이제 820px 아래 떠 있는 독)
    const RETIRED = [
      '@media (prefers-color-scheme: dark) :root:not([data-theme="light"])',
      '.topbar select',
      '.search-results',
      '.topbar',
      '.topbar h1',
      '.topbar p',
      '.vault-name',
      '.topbar-actions',
      '.topbar form',
      '.topbar form p',
      ':where(.topbar form) p',
      '@media (max-width: 640px) .shell',
      '@media (max-width: 640px) .sidebar',
      '.palette-open::before',
      '.sidebar-tabs',
      '.sidebar-tab',
      '.sidebar-tab[aria-selected="true"]',
      '@media print .topbar',
      // 보기 머리(Task 7)가 일부러 없앤 것: 편집기의 경로 줄과 그 안의 상태 표시·노트 단추 묶음(이제 .view-header 와 상태 줄),
      // 상태 줄의 알림 묶음(이제 .statusbar-group)
      '.editor-path',
      '.editor-path [role="status"]',
      '.editor-actions',
      '.editor-actions .editor-qr',
      '.status-notes',
      '@media print .editor-path button',
    ];
    expect(OLD_APP_CSS_SELECTORS.filter((s) => !now.has(s) && !RETIRED.includes(s))).toEqual([]);
    for (const s of RETIRED) expect(now.has(s), s).toBe(false);
  });

  it('고대비와 인쇄의 창 틀 규칙은 맨 마지막 파일에 있다: 앞 파일들의 같은 특이도 규칙을 덮는다', () => {
    const styles = readStyles();
    const last = styles[styles.length - 1];
    const heads = (text: string) => parseRules(text).filter((r) => r.atRule).map((r) => `${r.atRule} ${r.selectors.join(', ')}`);
    expect(heads(last.text)).toEqual(expect.arrayContaining(['@media (forced-colors: active) :focus-visible', '@media print .shell']));
    for (const s of styles.slice(0, -1)) {
      // 앞 파일의 고대비 규칙은 tokens.css 의 토큰 대응 블록(:root …)뿐이다
      expect(heads(s.text).filter((h) => h.includes('forced-colors') && !h.includes(':root')), s.file).toEqual([]);
      // 앞 파일의 인쇄 규칙은 tokens.css 의 라이트 토큰 블록뿐이다
      expect(heads(s.text).filter((h) => h.startsWith('@media print') && !h.includes(':root')), s.file).toEqual([]);
    }
  });
});
