// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { Editor } from '../Editor';
import { setMode, type EditorMode } from '../live/mode';
import { compareSpecificity, declarations, literalColours, parseRules, specificity, SYSTEM_COLOURS, type Rule } from '../../__tests__/css';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/**
 * 편집기 그림자 루트에 날것의 색이 새어 들지 않게 막는 가드.
 *
 * 편집기는 늘 CodeMirror 의 라이트 기본 클래스를 단다(theme.ts 머리말). 그래서 기본 테마와 확장이 가져오는 `&light`·범위 없는
 * 규칙의 박힌 색이 다크 모드에서도 그대로 걸린다. 이 테스트는 앱이 실제로 싣는 확장으로 편집기를 띄우고, 그림자 루트에 들어간
 * CSS 전체에서 날것의 색(#hex, rgb(), hsl(), 이름 있는 색, 새 색 함수)을 쓰는 선언을 하나씩 찾아 다음 중 하나임을 요구한다:
 *  1. 덮였다: 같은 대상(편집기 루트 클래스를 `&` 로 바꾼 선택자가 같다)에 같은 속성(또는 그 속성을 덮는 단축 속성, 그 색 하위
 *     속성)을 날것의 색 없이 선언한 규칙이, 특이도가 더 높거나 같은 특이도로 뒤에 있다. !important 는 !important 로만 덮인다.
 *     @-규칙 안의 선언은 덮는 쪽으로 치지 않는다(조건부라서).
 *  2. 다크 클래스에 걸린 규칙: 편집기 루트에 다크 클래스가 없음을 같은 테스트에서 확인한다.
 *  3. DORMANT 목록에 있다: 그 요소를 그리는 확장이 아직 설치되지 않은 규칙. 목록은 정확해야 한다 — 쓰이지 않는 항목도 실패다.
 *     확장이 설치되지 않았음은 (a) 소스가 그 이름을 CodeMirror 에서 가져오지 않고 (b) 띄운 편집기에 그 요소가 없음으로 확인한다.
 *
 * "같은 대상" 은 선택자 글자로 비교한다: 다른 선택자로 같은 요소를 덮는 것은 덮인 것으로 치지 않는다(보수적이다 — 놓치지 않고 더 자주 빨개진다).
 */

/**
 * 기본 테마(@codemirror/view)에 들어 있지만 그 요소를 그리는 확장이 아직 없는 규칙. 키는 루트 클래스를 `&` 로 바꾼 선택자.
 * 해당 확장을 설치하는 사람은 이 항목을 지우고 theme.ts 에 토큰으로 덮는 규칙을 넣어야 한다 — 아래 검사가 그렇게 시킨다.
 */
const DORMANT: Record<string, { extension: string; probe: string | null }> = {
  '& .cm-selectionBackground': { extension: 'drawSelection', probe: '.cm-selectionLayer, .cm-selectionBackground' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { extension: 'drawSelection', probe: '.cm-selectionLayer' },
  '& .cm-cursor': { extension: 'drawSelection', probe: '.cm-cursorLayer, .cm-cursor' },
  // 끌어 놓는 동안에만 그려지므로 띄운 편집기에서 찾을 수 없다: 탐침이 헛돌아 가져오기 검사만 이 항목을 지킨다
  '& .cm-dropCursor': { extension: 'dropCursor', probe: null },
  '& .cm-placeholder': { extension: 'placeholder', probe: '.cm-placeholder' }, // 빈 노트에서만 그려진다: 빈 노트로도 띄워 본다
  '& .cm-highlightSpace': { extension: 'highlightWhitespace', probe: '.cm-highlightSpace' },
  '& .cm-highlightTab': { extension: 'highlightWhitespace', probe: '.cm-highlightTab' },
  '& .cm-trailingSpace': { extension: 'highlightTrailingWhitespace', probe: '.cm-trailingSpace' },
};
/** 위 확장을 한꺼번에 싣는 묶음. 이 이름을 가져와도 같은 규칙이 살아난다. */
const BUNDLES = ['basicSetup', 'minimalSetup'];

/** 그림자 루트의 스타일 텍스트. jsdom 은 그림자 루트 안 <style> 의 sheet 를 만들지 않으므로 텍스트를 직접 읽는다. */
function shadowCss(root: ShadowRoot): string {
  const sheets = Array.from(root.adoptedStyleSheets ?? []);
  const adopted = sheets.map((s) => Array.from(s.cssRules).map((r) => r.cssText).join('\n'));
  return [...Array.from(root.querySelectorAll('style')).map((s) => s.textContent ?? ''), ...adopted].join('\n');
}

/** 이 속성의 선언이 literal 속성의 색을 덮는가: 같은 속성, 그 단축 속성(border → border-top), 또는 색 하위 속성(border-left → border-left-color). */
const covers = (over: string, literal: string, literalValue: string) =>
  over === literal ||
  literal.startsWith(`${over}-`) ||
  // `-color` 하위 속성은 색 층만 덮는다: 그림 층(그라디언트, url, image-set, element, cross-fade) 안의 색은 그대로 남는다
  // (background: radial-gradient(#aaa …)). 그림 층이 있는 단축 속성은 색 층이 함께 있어도 덮인 것으로 치지 않는다(보수적이다).
  (over === `${literal}-color` && !/gradient\(|url\(|image-set\(|element\(|cross-fade\(/i.test(literalValue));

const SYSTEM = new Set(SYSTEM_COLOURS);

interface Finding {
  selector: string;
  target: string;
  prop: string;
  value: string;
  status: 'overridden' | 'dark' | 'dormant' | 'system' | 'LEAK';
}

/** 그림자 루트 CSS 의 날것의 색 선언을 하나씩 분류한다. rootClasses 는 편집기 루트에 붙은 CodeMirror 클래스, dark 는 다크 클래스. */
function audit(css: string, rootClasses: string[], dark: string): Finding[] {
  const rules = parseRules(css);
  const scope = new RegExp(rootClasses.map((c) => `\\.${c}(?![\\p{L}\\p{N}_-])`).join('|'), 'gu');
  const darkRe = new RegExp(`\\.${dark}(?![\\p{L}\\p{N}_-])`, 'u');
  const target = (sel: string) => sel.replace(scope, '&').replace(/&+/g, '&').replace(/\s+/g, ' ').trim();
  const out: Finding[] = [];
  const all = rules.flatMap((r: Rule) => r.selectors.map((selector) => ({ r, selector, decls: declarations(r.body) })));
  for (const { r, selector, decls } of all) {
    for (const d of decls) {
      if (literalColours(d.value).length === 0) continue;
      const t = target(selector);
      const base = { selector, target: t, prop: d.prop, value: d.value };
      if (darkRe.test(selector)) {
        out.push({ ...base, status: 'dark' });
        continue;
      }
      // 고대비(forced-colors) 블록 안의 시스템 색(Highlight, CanvasText …)은 운영체제가 정하는 색이라 토큰을 따르지 않는다
      if (r.atRule?.includes('forced-colors') && literalColours(d.value).every((c) => SYSTEM.has(c.toLowerCase()))) {
        out.push({ ...base, status: 'system' });
        continue;
      }
      const spec = specificity(selector);
      const overridden =
        !r.atRule &&
        all.some(
          (o) =>
            !o.r.atRule &&
            target(o.selector) === t &&
            (compareSpecificity(specificity(o.selector), spec) > 0 || (compareSpecificity(specificity(o.selector), spec) === 0 && o.r.order > r.order)) &&
            o.decls.some((od) => covers(od.prop, d.prop, d.value) && literalColours(od.value).length === 0 && (od.important || !d.important)),
        );
      if (overridden) out.push({ ...base, status: 'overridden' });
      else if (!r.atRule && t in DORMANT) out.push({ ...base, status: 'dormant' });
      else out.push({ ...base, status: 'LEAK' });
    }
  }
  return out;
}

// 정규식은 String.raw 로 쓴다: escapes.test.ts 가 따옴표 안의 역슬래시를 문자열로 읽기 때문이다.
const CM = String.raw`['"](?:@codemirror/[\w-]+|codemirror)['"]`;
/** 이름으로 가져오거나 다시 내보내기: `import { a }`, `import X, { a }`, `import type { a }`, `export { a } from`, `export type { a } from`. */
const NAMED_IMPORT = new RegExp(String.raw`(?:import|export)\s*(?:type\s*)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*` + CM, 'g');
/** 무엇을 쓰는지 이름으로 알 수 없는 것: 기본 가져오기(이름과 함께여도), `import * as`, `export *`(as 포함), `import()`. */
const OPAQUE_IMPORT = new RegExp(
  [
    String.raw`import\s+[\w$]+\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+)\s*)?from\s*` + CM,
    String.raw`import\s*\*\s*as\s+[\w$]+\s*from\s*` + CM,
    String.raw`export\s*\*(?:\s*as\s+[\w$]+)?\s*from\s*` + CM,
    String.raw`import\(\s*` + CM,
  ].join('|'),
);
const BARE_PACKAGE = new RegExp(String.raw`from\s*['"]codemirror['"]`);

/** 소스 한 개가 CodeMirror 패키지에서 가져오는 이름들. 이름으로 알 수 없는 가져오기는 `*` 로 남긴다. */
function importsIn(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(NAMED_IMPORT))
    for (const n of m[1].split(',')) if (n.trim()) names.add(n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]);
  if (OPAQUE_IMPORT.test(src)) names.add('*');
  if (BARE_PACKAGE.test(src)) names.add('codemirror');
  return names;
}

/** 소스(테스트 제외) 전체가 CodeMirror 패키지에서 가져오는 이름들. */
function codemirrorImports(dir = 'src'): Set<string> {
  const names = new Set<string>();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') codemirrorImports(p).forEach((n) => names.add(n));
      continue;
    }
    if (/\.tsx?$/.test(name)) importsIn(readFileSync(p, 'utf-8')).forEach((n) => names.add(n));
  }
  return names;
}

// 끝 공백, 탭, 섞인 줄바꿈: 공백 강조나 끝 공백 확장이 설치돼 있다면 그 요소가 그려질 본문.
// 라이브 미리보기의 제목·굵게·인라인 코드·하이라이트도 그려지게 한다(그 표시의 색도 이 검사를 받는다).
const SAMPLE = '# 제목  \n\t- [링크](https://x) 본문 \r\n## h\n**b** `c` ==h==\n';

/** 앱이 싣는 확장으로 편집기를 그 모드(live/source)로 띄운다. */
async function mountShipped(text = SAMPLE, mode: EditorMode = 'live') {
  setMode(mode);
  const invoke = (async () => text) as never;
  const listen = (async () => () => {}) as never;
  const windowApi = { onCloseRequested: async () => () => {}, destroy: async () => {} };
  const { container } = render(<Editor path="a.labnote.md" invoke={invoke} listen={listen} windowApi={windowApi} />);
  const shadow = (container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
  // 불러오기가 끝나 편집할 수 있게 됐을 때까지 기다린다(빈 노트도 같은 상태가 된다)
  await waitFor(() => expect(shadow.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true'));
  const view = EditorView.findFromDOM(shadow.querySelector('.cm-editor') as HTMLElement)!;
  expect(view.state.doc.length === 0).toBe(text === ''); // 빈 노트를 원했으면 정말 비었고, 아니면 본문이 들어 있다
  return { shadow, view };
}

/** 다크 표시를 한 편집기에만 붙는 클래스 = CodeMirror 의 다크 기본 클래스. */
function darkClass(): string {
  const light = new EditorView({});
  const dark = new EditorView({ extensions: EditorView.darkTheme.of(true) });
  const extra = Array.from(dark.dom.classList).filter((c) => !light.dom.classList.contains(c));
  light.destroy();
  dark.destroy();
  expect(extra).toHaveLength(1);
  return extra[0];
}

const report = (fs: Finding[]) => fs.map((f) => `${f.selector} { ${f.prop}: ${f.value} }`);

// Node 의 자체 localStorage 가 jsdom 의 것을 가리므로 메모리 저장소를 꽂는다(useTheme.test.ts 와 같다).
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  setMode('live');
});
afterEach(() => vi.unstubAllGlobals());

describe('편집기 그림자 루트의 날것의 색', () => {
  it.each(['live', 'source'] as const)('no LEAK in %s mode: 박힌 색은 모두 토큰으로 덮였거나 다크 전용이거나 아직 그려지지 않는 요소의 것이다', async (m) => {
    const { shadow, view } = await mountShipped(SAMPLE, m);
    const css = shadowCss(shadow);
    const rootClasses = Array.from(view.dom.classList).filter((c) => /^ͼ/.test(c));
    const dark = darkClass();
    expect(rootClasses.length).toBeGreaterThanOrEqual(3); // 기본, 라이트, 우리 테마
    expect(rootClasses).not.toContain(dark);
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);

    const findings = audit(css, rootClasses, dark);
    // 검사기가 실제로 일했다: 기본 테마의 박힌 색을 여럿 보았고, 그중 상당수는 우리 테마가 덮었다
    expect(findings.length).toBeGreaterThan(20);
    expect(findings.filter((f) => f.status === 'overridden').length).toBeGreaterThan(10);
    expect(findings.filter((f) => f.status === 'dark').length).toBeGreaterThan(5);
    expect(report(findings.filter((f) => f.status === 'LEAK'))).toEqual([]);

    // DORMANT 는 정확하다: 항목마다 실제로 잠든 규칙이 있다(낡은 항목이 남지 않게)
    const dormant = new Set(findings.filter((f) => f.status === 'dormant').map((f) => f.target));
    expect([...dormant].sort()).toEqual(Object.keys(DORMANT).sort());
  });

  it('잠든 규칙의 확장은 정말 설치돼 있지 않다: 소스가 가져오지 않고, 띄운 편집기에 그 요소도 없다', async () => {
    const imported = codemirrorImports();
    expect(imported.has('EditorView')).toBe(true); // 가져오기 목록을 실제로 읽었다
    expect(imported.has('*'), 'CodeMirror 를 이름 없이(기본 가져오기, import * as, export * from, import()) 가져오면 이 검사가 확장을 볼 수 없다').toBe(false);
    for (const name of [...new Set(Object.values(DORMANT).map((d) => d.extension)), ...BUNDLES, 'codemirror'])
      expect(imported.has(name), `${name} 을 설치하면 DORMANT 의 해당 항목을 지우고 theme.ts 에서 토큰으로 덮어야 한다`).toBe(false);
    // 요소 탐침: 본문이 있는 노트(공백·탭·끝 공백)와 빈 노트(placeholder 는 빈 본문에서만 그려진다) 둘 다에서 찾는다.
    const shadows = [(await mountShipped()).shadow, (await mountShipped('')).shadow, (await mountShipped(SAMPLE, 'source')).shadow];
    for (const [sel, { probe }] of Object.entries(DORMANT)) {
      if (probe === null) continue; // 헛도는 탐침: 가져오기 검사만 이 항목을 지킨다
      for (const shadow of shadows) expect(shadow.querySelector(probe), `${sel}: ${probe}`).toBeNull();
    }
  });

  it('가져오기 검사기 자기 점검: 이름 있는·기본+이름·다시 내보내기·통째 다시 내보내기·이름 없는 가져오기를 모두 본다', () => {
    const q = String.fromCharCode(39); // 작은따옴표: 이 테스트 문자열 안에 따옴표를 겹쳐 쓰지 않으려고
    const from = (spec: string) => `${spec} from ${q}@codemirror/view${q};`;
    const seen = (src: string) => [...importsIn(src)].sort();
    expect(seen(from('import { EditorView, drawSelection as ds, type Rect }'))).toEqual(['EditorView', 'Rect', 'drawSelection']);
    expect(seen(from('import View, { drawSelection }'))).toEqual(['*', 'drawSelection']);
    expect(seen(from('export { drawSelection }'))).toEqual(['drawSelection']);
    expect(seen(from('export type { Rect }'))).toEqual(['Rect']);
    expect(seen(from('export * as cm'))).toEqual(['*']);
    expect(seen(from('export *'))).toEqual(['*']);
    expect(seen(from('import * as cm'))).toEqual(['*']);
    expect(seen(from('import View'))).toEqual(['*']);
    expect(seen(`const m = await import(${q}@codemirror/view${q});`)).toEqual(['*']);
    expect(seen(`import { basicSetup } from ${q}codemirror${q};`)).toEqual(['basicSetup', 'codemirror']);
    // CodeMirror 가 아닌 패키지는 세지 않는다
    expect(seen(`import { drawSelection } from ${q}./mine${q}; export * from ${q}react${q};`)).toEqual([]);
  });

  it('검사기 자기 점검: 덮이지 않은 색, 낮은 특이도·앞선 순서의 덮기, @media 안의 덮기, !important 를 가려낸다', () => {
    const roots = ['ͼ1', 'ͼ2', 'ͼo'];
    const status = (css: string) => audit(css, roots, 'ͼ3').map((f) => `${f.target}|${f.prop}|${f.status}`);
    // background 단축 속성의 그림 층(그라디언트·url) 안 색은 background-color 로 덮이지 않는다
    expect(status('.ͼ1 .cm-y{background:radial-gradient(#aaa 20%,transparent 0)} .ͼo .cm-y{background-color:var(--x)}')).toEqual(['& .cm-y|background|LEAK']);
    expect(status(`.ͼ1 .cm-y{background:url('data:image/svg+xml,<svg stroke="%23888"/>')} .ͼo .cm-y{background-color:var(--x)}`)).toEqual(['& .cm-y|background|LEAK']);
    // 색만 든 background 는 background-color 로 덮인다
    expect(status('.ͼ2 .cm-y{background:#d9d9d9} .ͼo .cm-y{background-color:var(--x)}')).toEqual(['& .cm-y|background|overridden']);
    // 같은 특이도, 뒤에서 토큰으로 덮음
    expect(status('.ͼ2 .cm-x {color: red;} .ͼo .cm-x {color: var(--text);}')).toEqual(['& .cm-x|color|overridden']);
    // 덮는 규칙이 앞에 있으면 지는 쪽이다
    expect(status('.ͼo .cm-x {color: var(--text);} .ͼ2 .cm-x {color: red;}')).toEqual(['& .cm-x|color|LEAK']);
    // 특이도가 더 높은 박힌 색은 뒤의 덮기로도 못 이긴다
    expect(status('.ͼ2.cm-focused .cm-x {background: #d7d4f0;} .ͼo .cm-x {background: var(--bg);}')).toEqual(['&.cm-focused .cm-x|background|LEAK']);
    // 덮는 값에 박힌 색이 있으면 덮은 것이 아니다 (덮은 쪽도 함께 걸린다)
    expect(status('.ͼ2 .cm-x {color: red;} .ͼo .cm-x {color: blue;}')).toEqual(['& .cm-x|color|LEAK', '& .cm-x|color|LEAK']);
    // @media 안의 덮기는 조건부라 치지 않는다
    expect(status('.ͼ2 .cm-x {color: red;} @media (prefers-color-scheme: dark) {.ͼo .cm-x {color: var(--text);}}')).toEqual(['& .cm-x|color|LEAK']);
    // !important 는 !important 로만
    expect(status('.ͼ2 .cm-x {color: red !important;} .ͼo .cm-x {color: var(--text);}')).toEqual(['& .cm-x|color|LEAK']);
    // 단축 속성이 하위 속성의 색을 덮고, 색 하위 속성이 단축 속성의 색을 덮는다
    expect(status('.ͼ2 .cm-x {border-top: 1px solid #ddd;} .ͼo .cm-x {border: 1px solid var(--border);}')).toEqual(['& .cm-x|border-top|overridden']);
    expect(status('.ͼ1 .cm-x {border-left: 1px solid black;} .ͼo .cm-x {border-left-color: var(--text);}')).toEqual(['& .cm-x|border-left|overridden']);
    // 다른 속성은 덮지 않는다
    expect(status('.ͼ2 .cm-x {color: red;} .ͼo .cm-x {background-color: var(--bg);}')).toEqual(['& .cm-x|color|LEAK']);
    // 다크 클래스 규칙, 루트에 없는 클래스(구문 강조)의 박힌 색
    expect(status('.ͼ3 .cm-x {color: #f78;} .ͼa {color: #708;}')).toEqual(['.ͼ3 .cm-x|color|dark', '.ͼa|color|LEAK']);
    // data: URL 안의 퍼센트 인코딩된 색, 새 색 함수
    expect(status(`.ͼ1 .cm-y {background-image: url('data:image/svg+xml,<svg><path stroke="%23888"/></svg>');}`)).toEqual(['& .cm-y|background-image|LEAK']);
    expect(status('.ͼ1 .cm-y {color: oklch(0.5 0.1 200);}')).toEqual(['& .cm-y|color|LEAK']);
    // 시스템 색은 forced-colors 블록 안에서만 통과한다. 그 블록 안의 다른 박힌 색, 다른 @media 안의 시스템 색은 걸린다
    expect(status('@media (forced-colors: active) {.ͼo .cm-x {outline: 2px solid Highlight;}}')).toEqual(['& .cm-x|outline|system']);
    expect(status('@media (forced-colors: active) {.ͼo .cm-x {outline: 2px solid #fff;}}')).toEqual(['& .cm-x|outline|LEAK']);
    expect(status('@media print {.ͼo .cm-x {outline: 2px solid Highlight;}}')).toEqual(['& .cm-x|outline|LEAK']);
    expect(status('.ͼo .cm-x {outline: 2px solid Highlight;}')).toEqual(['& .cm-x|outline|LEAK']);
    // 토큰과 투명은 색으로 세지 않는다
    expect(status('.ͼ1 .cm-y {color: var(--text); background: transparent; border-color: currentColor;}')).toEqual([]);
  });

  it('image-set / element backgrounds are not covered by background-color', () => {
    const status = (css: string) => audit(css, ['ͼ1', 'ͼ2', 'ͼo'], 'ͼ3').map((f) => `${f.target}|${f.prop}|${f.status}`);
    expect(status('.ͼ1 .cm-y{background:image-set("a.png" 1x) #aaa} .ͼo .cm-y{background-color:var(--x)}')).toEqual(['& .cm-y|background|LEAK']);
    expect(status('.ͼ1 .cm-y{background:element(#a) #aaa} .ͼo .cm-y{background-color:var(--x)}')).toEqual(['& .cm-y|background|LEAK']);
    expect(status('.ͼ1 .cm-y{background:cross-fade(#aaa, #bbb)} .ͼo .cm-y{background-color:var(--x)}')).toEqual(['& .cm-y|background|LEAK']);
  });

  it('table toolbar buttons use the widget base', async () => {
    const { shadow } = await mountShipped('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(shadow.querySelector('.lno-table-tool')!.classList.contains('lno-btn')).toBe(true);
  });
});
