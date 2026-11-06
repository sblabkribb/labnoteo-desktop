/**
 * 테스트가 함께 쓰는 작은 CSS 도구: 규칙 나누기, 선언 나누기, 특이도, 날것의 색 찾기.
 * 브라우저의 CSS 파서가 아니다. app.css 와 CodeMirror 가 그림자 루트에 넣는 스타일 정도를 읽으려고 만들었다.
 * 던지는 경우는 이것뿐이다: 중괄호 짝이 안 맞을 때, 스타일 규칙 안에 블록이 또 있을 때(CSS 중첩 — 읽을 줄 모른다),
 * 콜론 없는 선언. 그 밖의 낯선 모양(이상한 선택자, 모르는 @-규칙)은 그대로 문자열로 돌려줄 뿐 검사하지 않는다.
 */

/**
 * CSS 시스템 색(소문자): 운영체제가 정하는 색이라 토큰을 따르지 않는다. 고대비(forced-colors) 블록 안에서만 쓸 수 있다
 * (tokens.test.ts 의 rawColoursOutside, Editor.test.tsx 의 themeColourLeaks).
 */
export const SYSTEM_COLOURS = [
  'accentcolor', 'accentcolortext', 'activetext', 'buttonborder', 'buttonface', 'buttontext', 'canvas', 'canvastext',
  'field', 'fieldtext', 'graytext', 'highlight', 'highlighttext', 'linktext', 'mark', 'marktext', 'selecteditem',
  'selecteditemtext', 'visitedtext',
];

/** CSS Color 4 의 이름 있는 색 전부와 시스템 색. `transparent`·`currentColor` 는 일부러 뺐다(토큰을 따르는 값). */
export const NAMED_COLOURS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond', 'blue',
  'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
  'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue',
  'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey',
  'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod',
  'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow',
  'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon',
  'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin',
  'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen',
  'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple',
  'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
  'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal',
  'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
  // 시스템 색
  ...SYSTEM_COLOURS,
];

const NAMED = new RegExp(String.raw`(?<![\w-])(?:${NAMED_COLOURS.join('|')})(?![\w-])`, 'gi');
/** 색을 만드는 함수. `var(` 와 그라디언트는 색이 아니다(그 안의 인자는 따로 걸린다). */
const FUNCTIONS = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk)\(/gi;
/** `#abc` 와, data: URL 안에서 퍼센트 인코딩된 `%23abc`. */
const HEX = /(?:#|%23)[0-9a-f]{3,8}(?![\w-])/gi;

/** 선언 값 하나에 들어 있는 날것의 색. `var(--…)`, `transparent`, `currentColor`, `inherit`, `none` 은 색으로 세지 않는다. */
export function literalColours(value: string): string[] {
  return [...(value.match(HEX) ?? []), ...(value.match(FUNCTIONS) ?? []), ...(value.match(NAMED) ?? [])];
}

export interface Rule {
  selectors: string[];
  body: string;
  /** 이 규칙을 감싼 @-규칙의 머리(예: `@media (max-width: 640px)`). 맨 바깥이면 없다. */
  atRule?: string;
  /** 문서 안 순서. 특이도가 같으면 큰 쪽이 이긴다. */
  order: number;
}

/** 괄호와 따옴표 밖의 `sep` 로 나눈다. */
export function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 주석을 지우고 중괄호 깊이를 세어 스타일 규칙을 꺼낸다. @-규칙 안의 규칙은 `atRule` 에 그 머리를 달아 돌려준다
 * (버리지 않는다: 버릴지 말지는 묻는 쪽이 정한다). @keyframes 안의 단계(0%, 50%)도 그 머리를 단 규칙으로 나온다.
 * 중괄호가 짝이 맞지 않으면 던진다.
 */
export function parseRules(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const stack: string[] = []; // 열린 블록의 머리
  let start = 0;
  let quote = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') {
      const parent = stack[stack.length - 1];
      if (parent !== undefined && !parent.startsWith('@'))
        throw new Error(`중첩된 규칙은 읽지 못한다: ${parent} { ${css.slice(start, i).trim()} { … } }`);
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (ch === '}') {
      const head = stack.pop();
      if (head === undefined) throw new Error(`짝 없는 } (위치 ${i})`);
      const body = css.slice(start, i);
      // 본문에 또 다른 블록이 있었다면(@media 의 몸통) 그 규칙들은 이미 나왔다: 이것은 @-규칙의 닫는 괄호다.
      if (!head.startsWith('@')) {
        const at = stack.filter((h) => h.startsWith('@'));
        rules.push({ selectors: splitTop(head, ','), body: body.trim(), atRule: at.length ? at.join(' ') : undefined, order: rules.length });
      }
      start = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1; // 맨 바깥의 @import 같은 문장
    }
  }
  if (stack.length) throw new Error(`닫히지 않은 블록: ${stack.join(' / ')}`);
  return rules;
}

export interface Declaration {
  prop: string;
  value: string;
  important: boolean;
}

/** 규칙 본문을 선언으로 나눈다. 같은 속성이 두 번 있으면 둘 다 나온다(뒤의 것이 이긴다). */
export function declarations(body: string): Declaration[] {
  return splitTop(body, ';').map((d) => {
    const colon = d.indexOf(':');
    if (colon < 0) throw new Error(`선언이 아니다: ${d}`);
    const raw = d.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(raw);
    return { prop: d.slice(0, colon).trim().toLowerCase(), value: raw.replace(/!\s*important\s*$/i, '').trim(), important };
  });
}

/** 선택자 하나의 특이도 [id, 클래스·속성·가상 클래스, 요소·가상 요소]. 클래스 이름은 유니코드(CodeMirror 의 `ͼ1`)도 읽는다. */
export function specificity(selector: string): [number, number, number] {
  let [a, b, c] = [0, 0, 0];
  let s = selector.replace(/:(?:not|has|is)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, arg: string) => {
    // :not(a, b) 는 인자 중 가장 높은 특이도를 쓴다
    const best = splitTop(arg, ',').map(specificity).sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0];
    a += best[0];
    b += best[1];
    c += best[2];
    return '';
  });
  s = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, ''); // :where() 는 0
  s = s.replace(/\[[^\]]*\]/g, () => (b++, ''));
  s = s.replace(/::[\w-]+|:(?:before|after|first-line|first-letter)(?![\w-])/g, () => (c++, ''));
  s = s.replace(/:[\w-]+/g, () => (b++, ''));
  s = s.replace(/#[\p{L}\p{N}_-]+/gu, () => (a++, ''));
  s = s.replace(/\.[\p{L}\p{N}_-]+/gu, () => (b++, ''));
  s = s.replace(/(^|[\s>+~])([a-z][\w-]*)/gi, (_m, p: string) => (c++, p));
  return [a, b, c];
}

/** x 가 y 보다 높으면 양수, 같으면 0. */
export const compareSpecificity = (x: number[], y: number[]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
