import { isolateHistory } from '@codemirror/commands';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import { minimalReplacement, parseFrontMatterYaml, serializeFrontMatterEntry } from '@labnoteo/core';
import { toDocBreaks } from '../../labnote/editTarget';
import { frontBlock, type FrontBlock, type FrontEntry } from './properties';

/**
 * 속성 격자의 편집(계획 D7, Task 25). 모든 편집은 머리말 글의 그 키 부분만 바꾸는 최소 변경 한 번이다:
 * - 값: 코어 serializeFrontMatterEntry 로 적은 항목에서 키 부분을 원래 적힌 토큰(따옴표 포함)으로 되돌려, 그 키의 줄(과 이어진 줄)만 갈아 끼운다.
 *   한 줄 값의 꼬리 주석(` # …`)은 남긴다. 바뀐 만큼만(minimalReplacement) 문서에 넣고, 줄바꿈은 문서의 것(toDocBreaks)으로.
 * - 키 이름 바꾸기는 토큰만, 지우기는 그 키의 줄들과 줄바꿈만, 더하기는 닫는 `---` 바로 앞의 한 줄이다.
 * - 한 번의 편집은 되돌리기 한 번(isolateHistory 'full'), userEvent 는 input.properties 다(frontGuard 가 지나보낸다).
 * 머리말이 격자로 보일 수 없거나(frontBlock 이 null), 키가 읽기 전용이면 null 이다.
 */

/** 앱이 적는 키. 격자에서 고치지 않는다. */
export const READ_ONLY_KEYS: ReadonlySet<string> = new Set(['last_updated_date']);

/** 줄 맨 앞의 YAML 키(따옴표 키, 또는 `:`·`#` 이 없는 평범한 키) 다음의 `:`. */
// 따옴표 글자는 \x22 와 \x27 로 쓴다: escapes.test.ts 는 소스의 따옴표 사이를 문자열로 읽는다.
export const KEY_LINE = /^(?:\x22((?:[^\x22\\]|\\.)*)\x22|\x27((?:[^\x27]|\x27\x27)*)\x27|([^\s#:\x27\x22-][^:#]*?))[ \t]*:(?=[ \t]|$)/u;

/** 새로 만들거나 바꾼 키로 받는 이름. 따옴표 없이 적을 수 있는 이름이다. */
const NEW_KEY = /^[\p{L}_][\p{L}\p{N}_ .-]*$/u;

/** 줄의 키(따옴표를 푼 것)와 적힌 그대로의 토큰, `:` 뒤의 값 글. 키 줄이 아니면 null. */
export function keyOfLine(line: string): { key: string; token: string; rest: string } | null {
  const m = KEY_LINE.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  const token = m[0].slice(0, -1).replace(/[ \t]+$/, '');
  if (m[1] !== undefined) {
    try {
      return { key: JSON.parse(`"${m[1]}"`) as string, token, rest };
    } catch {
      return { key: m[1], token, rest };
    }
  }
  if (m[2] !== undefined) return { key: m[2].replace(/''/g, "'"), token, rest };
  return { key: m[3], token, rest };
}

/** 키의 이어진 줄(들여쓴 줄, 또는 `- ` 항목): 코어 setFrontMatterKeys 와 같은 규칙. */
const continues = (line: string) => /^\s+[^\s#]/.test(line) || /^-(\s|$)/.test(line);

/**
 * 블록 글 안의 그 키의 위치. [from, lineTo) 는 키 줄, [from, to) 는 이어진 줄까지. 줄바꿈은 들지 않는다.
 * 들여쓴 줄과 주석 줄의 키는 보지 않는다(중첩 맵의 안쪽 키가 아니다).
 */
export function keySpan(text: string, key: string): { from: number; to: number; lineTo: number; token: string } | null {
  const lines = text.split('\n');
  let at = lines[0].length + 1;
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    const found = /^[ \t]/.test(line) || line.startsWith('#') ? null : keyOfLine(line);
    if (found && found.key === key) {
      const from = at;
      const lineTo = from + line.length;
      let to = lineTo;
      // 빈 줄·주석 줄은 그 뒤에 이어진 줄이 또 있을 때만 이 키에 든다(목록 항목 사이의 빈 줄)
      for (let j = i + 1; j < lines.length - 1; j++) {
        if (!continues(lines[j])) {
          let k = j;
          while (k < lines.length - 1 && BLANK.test(lines[k]) && !continues(lines[k])) k++;
          if (k === j || k >= lines.length - 1 || !continues(lines[k])) break;
          for (; j < k; j++) to += 1 + lines[j].length;
        }
        to += 1 + lines[j].length;
      }
      return { from, to, lineTo, token: found.token };
    }
    at += line.length + 1;
  }
  return null;
}

/** 새 키를 YAML 로 적은 것: 따옴표 없이 읽히는 이름은 그대로, 아니면 JSON 문자열(YAML 의 큰따옴표 문자열). */
export function yamlKey(key: string): string {
  return NEW_KEY.test(key) && !/\s$/.test(key) ? key : JSON.stringify(key);
}

const WIKI = /^\[\[[^\]]*\]\]$/;
const WIKI_VALUE = /^\s*\[\[[^\]]*\]\]\s*(?:#.*)?$/;
const WIKI_ITEM = /^\s*-\s+(?:\[\[[^\]]*\]\]|\x22\[\[[^\]\x22]*\]\]\x22|\x27\[\[[^\]\x27]*\]\]\x27)\s*$/;
const BLANK = /^\s*(#.*)?$/;

/**
 * 값의 원문이 `[[…]]` 하나이거나 `[[…]]` 항목들의 목록인가. `sourceLines` 의 첫 줄은 키 줄의 `:` 뒤, 나머지는 이어진 줄이다.
 * (YAML 은 따옴표 없는 `[[a]]` 를 중첩 목록으로 읽는다: 원문으로 판단한다.)
 */
export function isWikilinkValue(sourceLines: string[]): boolean {
  if (!sourceLines.length) return false;
  const [first, ...rest] = sourceLines;
  if (WIKI_VALUE.test(first)) return rest.every((l) => BLANK.test(l));
  if (!BLANK.test(first)) return false;
  const items = rest.filter((l) => !BLANK.test(l));
  return items.length > 0 && items.every((l) => WIKI_ITEM.test(l));
}

/** 한 줄 `key: value` 끝의 ` # 주석`(따옴표 밖), 없으면 ''. `rest` 는 `:` 뒤의 글이다. */
function trailingComment(rest: string): string {
  let quote: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && i > 0 && /\s/.test(rest[i - 1])) {
      let s = i - 1;
      while (s > 0 && /[ \t]/.test(rest[s - 1])) s--;
      return rest.slice(s);
    }
  }
  return '';
}

/**
 * 입력한 글 하나를 YAML 값으로. 따옴표 없이 적어도 같은 스칼라로 읽히면(숫자·참거짓 포함) 그 값을, 아니면 글 그대로(필요하면 따옴표가 붙는다).
 * 빈 글은 null(`key: `)이다.
 */
function scalarOf(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  const parsed = parseFrontMatterYaml(`---\nk: ${text}\n---\n`);
  if (!parsed.parseError && Object.keys(parsed.frontMatter).length === 1) {
    const v = parsed.frontMatter.k;
    if ((typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && serializeFrontMatterEntry('k', v) === `k: ${text}`) return v;
  }
  return text;
}

const splitList = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** `k:` 로 시작하는 코어의 항목에서 키를 `token` 으로 바꾼다. */
const withToken = (entry: string, token: string) => token + entry.slice(1);

/** 칸의 종류에 맞춰 입력을 YAML 항목(`token: …`, 여러 줄일 수 있다)으로 적는다. */
function entryText(cell: FrontEntry['cell'], token: string, raw: string): string {
  if (cell === 'wikilink') {
    const links = splitList(raw).map((s) => (WIKI.test(s) ? s : `[[${s}]]`));
    if (links.length === 0) return `${token}: `;
    if (links.length === 1) return `${token}: ${links[0]}`;
    return [`${token}:`, ...links.map((l) => `  - ${JSON.stringify(l)}`)].join('\n');
  }
  if (cell === 'list') return withToken(serializeFrontMatterEntry('k', splitList(raw).map(scalarOf)), token);
  return withToken(serializeFrontMatterEntry('k', scalarOf(raw)), token);
}

function spec(state: EditorState, from: number, to: number, insert: string): TransactionSpec {
  return {
    changes: { from, to, insert: toDocBreaks(insert, state) },
    userEvent: 'input.properties',
    annotations: isolateHistory.of('full'),
  };
}

function editable(state: EditorState, key: string): { block: FrontBlock; entry: FrontEntry } | null {
  const block = frontBlock(state);
  if (!block || READ_ONLY_KEYS.has(key)) return null;
  const entry = block.entries.find((e) => e.key === key);
  if (!entry || entry.cell === 'readOnly') return null;
  return { block, entry };
}

/** 그 키의 값을 입력한 글로 바꾼다. 목록 칸은 쉼표로 나눈 항목들, 위키링크 칸은 `[[…]]` 들이다. 바뀌는 것이 없으면 null. */
export function editValue(state: EditorState, key: string, raw: string): TransactionSpec | null {
  const found = editable(state, key);
  if (!found || found.entry.cell === 'nested') return null;
  const { block, entry } = found;
  const span = keySpan(block.text, key);
  if (!span) return null;
  let next = entryText(entry.cell, span.token, raw);
  if (span.to === span.lineTo && !next.includes('\n')) {
    const comment = trailingComment(block.text.slice(span.from + span.token.length, span.lineTo).replace(/^[ \t]*:/, ''));
    if (comment) next = next.replace(/[ \t]+$/, '') + comment;
  }
  const m = minimalReplacement(block.text.slice(span.from, span.to), next);
  if (!m) return null;
  return spec(state, span.from + m.start, span.from + m.end, m.text);
}

/** 키 이름만 바꾼다(값과 주석은 그대로). 새 이름이 이미 있거나 받을 수 없는 이름이면 null. */
export function renameKey(state: EditorState, from: string, to: string): TransactionSpec | null {
  const name = to.trim();
  const found = editable(state, from);
  if (!found || name === from || !NEW_KEY.test(name) || READ_ONLY_KEYS.has(name)) return null;
  if (found.block.entries.some((e) => e.key === name)) return null;
  const span = keySpan(found.block.text, from);
  if (!span) return null;
  return spec(state, span.from, span.from + span.token.length, yamlKey(name));
}

/** 닫는 `---` 바로 앞에 `key: value` 한 줄을 더한다. 이미 있는 키나 받을 수 없는 이름이면 null. */
export function addKey(state: EditorState, key: string, raw: string): TransactionSpec | null {
  const name = key.trim();
  const block = frontBlock(state);
  if (!block || !NEW_KEY.test(name) || READ_ONLY_KEYS.has(name)) return null;
  if (block.entries.some((e) => e.key === name) || keySpan(block.text, name)) return null;
  const at = block.text.lastIndexOf('\n') + 1;
  return spec(state, at, at, `${withToken(serializeFrontMatterEntry('k', scalarOf(raw)), yamlKey(name))}\n`);
}

/** 그 키의 줄들과 그 뒤의 줄바꿈을 지운다. */
export function removeKey(state: EditorState, key: string): TransactionSpec | null {
  const found = editable(state, key);
  if (!found) return null;
  const span = keySpan(found.block.text, key);
  if (!span) return null;
  return spec(state, span.from, span.to + 1, '');
}
