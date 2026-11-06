import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSpec,
  type Extension,
  type StateEffectType,
} from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from '@codemirror/view';
import { frontMatterNames, parseFrontMatterYaml } from '@labnoteo/core';
import { frontMatterText } from '../../labnote/frontMatterText';
import { t } from '../../i18n/t';

/**
 * 라이브 미리보기의 속성(Properties) 격자(계획 D7, Task 24: 보이기와 경계 지킴이만. 고치기는 Task 25).
 *
 * - 머리말(front matter)이 문서 0 에서 시작해 `---` 로 닫히고, 그 글에 `\r` 이 없고(섞인 줄 끝은 원문으로 둔다),
 *   코어 parseFrontMatterYaml 이 오류를 내지 않을 때만 격자가 머리말 전체를 블록 위젯으로 대신한다. 아니면 원문 그대로다.
 * - "YAML로 편집" 단추는 이 블록만 원문으로 돌린다(rawFront). 선택이 블록을 떠나면 다시 격자다(SP1 rawTables 와 같다).
 * - 격자가 보이는 동안 사용자 입력(input*·delete*)은 머리말을 건드리지 못한다(frontGuard). 명령(input.labnote)과
 *   격자 자신의 편집(input.properties), userEvent 없는 프로그램 편집은 그대로 지나간다.
 */

/** 격자 칸의 종류. readOnly 는 앱이 적는 키(last_updated_date). */
export interface FrontEntry {
  key: string;
  value: unknown;
  /** 블록 안의 0 기준 줄 번호(여는 `---` 가 0). */
  line: number;
  cell: 'scalar' | 'list' | 'wikilink' | 'nested' | 'readOnly';
}

export interface FrontBlock {
  from: 0;
  /** 닫는 `---` 줄의 끝. */
  to: number;
  /** state.doc.sliceString(0, to): LF 로 이은 글이라 위치와 1:1 이다. */
  text: string;
  entries: FrontEntry[];
}

const CLOSE = /^---[ \t]*$/;
const READ_ONLY = new Set(['last_updated_date']);
/** 줄 맨 앞의 YAML 키(따옴표 키, 또는 `:`·`#` 이 없는 평범한 키) 다음의 `:`. */
// 따옴표 글자는 \x22 와 \x27 로 쓴다: escapes.test.ts 는 소스의 따옴표 사이를 문자열로 읽는다.
const KEY_LINE = /^(?:\x22((?:[^\x22\\]|\\.)*)\x22|\x27((?:[^\x27]|\x27\x27)*)\x27|([^\s#:\x27\x22-][^:#]*?))[ \t]*:(?=[ \t]|$)/u;
const WIKI_VALUE = /^\s*\[\[[^\]]*\]\]\s*(?:#.*)?$/;
const WIKI_ITEM = /^\s*-\s+(?:\[\[[^\]]*\]\]|\x22\[\[[^\]\x22]*\]\]\x22|\x27\[\[[^\]\x27]*\]\]\x27)\s*$/;

/** 줄의 키(따옴표를 푼 것)와 `:` 뒤의 값 글. 키 줄이 아니면 null. */
function keyOfLine(line: string): { key: string; rest: string } | null {
  const m = KEY_LINE.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (m[1] !== undefined) {
    try {
      return { key: JSON.parse(`"${m[1]}"`) as string, rest };
    } catch {
      return { key: m[1], rest };
    }
  }
  if (m[2] !== undefined) return { key: m[2].replace(/''/g, "'"), rest };
  return { key: m[3], rest };
}

function frontNode(state: EditorState): { from: number; to: number } | null {
  if (!state.facet(language)) return null;
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, 4096), 20) ?? syntaxTree(state);
  const first = tree.topNode.firstChild;
  return first && first.name === 'Frontmatter' && first.from === 0 ? { from: 0, to: first.to } : null;
}

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** 격자로 보일 머리말. 위 조건 중 하나라도 어기면 null(원문). */
export function frontBlock(state: EditorState): FrontBlock | null {
  const node = frontNode(state);
  if (!node) return null;
  const text = state.doc.sliceString(0, node.to);
  if (text.includes('\r')) return null;
  const lines = text.split('\n');
  if (lines.length < 2 || !CLOSE.test(lines[lines.length - 1])) return null;
  const parsed = parseFrontMatterYaml(frontMatterText(text));
  if (parsed.parseError) return null;

  // 키의 줄: 들여쓰지 않은 키 줄과 그 아래 들여쓴(또는 `- `) 줄들
  const spans = new Map<string, { line: number; source: string[] }>();
  let current: { line: number; source: string[] } | null = null;
  for (let i = 1; i < lines.length - 1; i++) {
    const l = lines[i];
    const found = /^[ \t]/.test(l) || l.startsWith('#') ? null : keyOfLine(l);
    if (found) {
      current = { line: i, source: [found.rest] };
      if (!spans.has(found.key)) spans.set(found.key, current);
    } else if (current && (/^[ \t]/.test(l) || l.startsWith('- '))) {
      current.source.push(l);
    } else if (!/^\s*(#.*)?$/.test(l)) {
      current = null;
    }
  }

  const entries = Object.entries(parsed.frontMatter).map(([key, value]): FrontEntry => {
    const span = spans.get(key);
    const line = span?.line ?? -1;
    const source = span?.source ?? [];
    let cell: FrontEntry['cell'];
    if (READ_ONLY.has(key)) cell = 'readOnly';
    else if (isWikilinkSource(source) || (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'string' && /^\[\[.*\]\]$/.test(x))))
      cell = 'wikilink';
    else if (Array.isArray(value)) cell = value.every(isScalar) ? 'list' : 'nested';
    else cell = isScalar(value) ? 'scalar' : 'nested';
    return { key, value, line, cell };
  });
  // 파일 순서(자바스크립트 객체는 정수 같은 키를 앞으로 옮긴다). 줄을 찾지 못한 키는 맨 뒤에.
  entries.sort((a, b) => (a.line < 0 ? Infinity : a.line) - (b.line < 0 ? Infinity : b.line));
  return { from: 0, to: node.to, text, entries };
}

/** 값이 `[[…]]` 하나이거나 `[[…]]` 항목들의 목록인가(원문으로 본다: YAML 은 `[[a]]` 를 중첩 목록으로 읽는다). */
function isWikilinkSource(source: string[]): boolean {
  if (!source.length) return false;
  const [first, ...rest] = source;
  if (WIKI_VALUE.test(first)) return rest.every((l) => /^\s*(#.*)?$/.test(l));
  if (!/^\s*(#.*)?$/.test(first)) return false;
  const items = rest.filter((l) => !/^\s*(#.*)?$/.test(l));
  return items.length > 0 && items.every((l) => WIKI_ITEM.test(l));
}

/** 칸에 보일 글. 이 Task 에서는 읽기 전용 글이다. */
function cellText(e: FrontEntry): string {
  if (e.cell === 'wikilink') return frontMatterNames(e.value).join(', ');
  if (e.cell === 'list') return (e.value as unknown[]).map((x) => (x === null ? '' : String(x))).join(', ');
  if (e.cell === 'nested') return JSON.stringify(e.value);
  return e.value === null || e.value === undefined ? '' : String(e.value);
}

/** 이 블록을 원문(YAML)으로 보인다(true) / 격자로 돌린다(false). */
export const editYaml: StateEffectType<boolean> = StateEffect.define<boolean>();

/** "YAML로 편집"이 켜져 있는가. 선택이 머리말을 떠나면 꺼진다(켜는 그 트랜잭션에서는 끄지 않는다). */
export const rawFront = StateField.define<boolean>({
  create: () => false,
  update(on, tr) {
    let set = false;
    for (const e of tr.effects) {
      if (e.is(editYaml)) {
        on = e.value;
        set = true;
      }
    }
    if (!on || set || (!tr.selection && !tr.docChanged)) return on;
    const node = frontNode(tr.state);
    if (!node) return false;
    return tr.state.selection.ranges.some((r) => r.from <= node.to);
  },
});

function showRaw(view: EditorView): void {
  view.dispatch({ effects: editYaml.of(true), selection: { anchor: Math.min(4, view.state.doc.length) }, userEvent: 'select' });
  view.focus();
}

function editYamlButton(view: EditorView): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lno-btn lno-props-edit';
  b.textContent = t('props.editYaml');
  b.setAttribute('aria-label', t('props.editYaml'));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    showRaw(view);
  });
  return b;
}

/** 머리말 대신 보이는 키·값 격자. 글이 같으면(eq) 다시 그리지 않는다. */
export class PropertiesWidget extends WidgetType {
  constructor(readonly block: FrontBlock) {
    super();
  }

  eq(o: PropertiesWidget): boolean {
    return this.block.text === o.block.text;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'lno-widget lno-props';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('props.label'));
    const head = document.createElement('div');
    head.className = 'lno-props-head';
    const title = document.createElement('span');
    title.className = 'lno-props-title';
    title.textContent = t('props.label');
    head.append(title, editYamlButton(view));
    box.append(head);
    for (const e of this.block.entries) box.append(this.row(e, view));
    return box;
  }

  private row(e: FrontEntry, view: EditorView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'lno-props-row';
    row.dataset.key = e.key;
    row.dataset.cell = e.cell;
    const key = document.createElement('span');
    key.className = 'lno-props-key';
    key.textContent = e.key;
    const value = document.createElement('span');
    value.className = 'lno-props-value';
    value.textContent = cellText(e);
    if (e.cell === 'readOnly') value.title = t('props.readOnly');
    row.append(key, value);
    if (e.cell === 'nested') row.append(editYamlButton(view));
    return row;
  }

  /** 같은 키들(같은 순서·종류)이면 값 글만 제자리에서 바꾼다. 포커스된 입력은 갈아 끼우지 않는다. */
  updateDOM(dom: HTMLElement): boolean {
    const rowEls = [...dom.querySelectorAll<HTMLElement>(':scope > .lno-props-row')];
    const entries = this.block.entries;
    if (rowEls.length !== entries.length) return false;
    if (rowEls.some((r, i) => r.dataset.key !== entries[i].key || r.dataset.cell !== entries[i].cell)) return false;
    rowEls.forEach((r, i) => {
      const v = r.querySelector<HTMLElement>('.lno-props-value');
      const text = cellText(entries[i]);
      if (v && v.textContent !== text) v.textContent = text;
    });
    dom.setAttribute('aria-label', t('props.label'));
    return true;
  }

  get estimatedHeight(): number {
    return 32 + 28 * this.block.entries.length;
  }

  /** 격자 안의 누름·키는 편집기가 받지 않는다(단추와 입력이 스스로 처리한다). */
  ignoreEvent(): boolean {
    return true;
  }
}

function buildGrid(state: EditorState): DecorationSet {
  if (state.field(rawFront, false)) return Decoration.none;
  const block = frontBlock(state);
  if (!block) return Decoration.none;
  return Decoration.set([Decoration.replace({ widget: new PropertiesWidget(block), block: true }).range(block.from, block.to)]);
}

/** 격자 블록 장식. 원자 범위이기도 하다: 커서가 격자 안에 떨어지지 않는다. */
export const propertiesField = StateField.define<DecorationSet>({
  create: buildGrid,
  update(deco, tr) {
    const changed =
      tr.docChanged ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.state.field(rawFront, false) !== tr.startState.field(rawFront, false);
    return changed ? buildGrid(tr.state) : deco;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
});

/** 지금 보이는 격자의 끝(닫는 `---` 줄의 끝). 격자가 없으면 null. */
function gridEnd(state: EditorState): number | null {
  const deco = state.field(propertiesField, false);
  if (!deco || deco.size === 0) return null;
  let end: number | null = null;
  deco.between(0, 0, (_from, to) => {
    end = to;
    return false;
  });
  return end;
}

/**
 * 격자가 보이는 동안 사용자 입력이 머리말을 건드리지 못하게 한다.
 * - 0 이나 `to` (또는 그 사이)에 넣는 글은 본문 첫 자리(to + 1)로 옮긴다. 문서가 `to` 에서 끝나면 줄바꿈을 먼저 넣는다.
 * - [0, to + 1) 에 닿는 지움은 통째로 버린다.
 */
const guardFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (!(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return tr;
  if (tr.isUserEvent('input.properties') || tr.isUserEvent('input.labnote')) return tr;
  const to = gridEnd(tr.startState);
  if (to === null) return tr;
  const start = tr.startState;
  let drop = false;
  let moved = false;
  const specs: ChangeSpec[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (toA > fromA) {
      if (fromA < to + 1) drop = true;
      specs.push({ from: fromA, to: toA, insert: inserted });
      return;
    }
    if (fromA > to) {
      specs.push({ from: fromA, insert: inserted });
      return;
    }
    moved = true;
    const text = inserted.toString();
    if (start.doc.length === to) specs.push({ from: to, insert: start.lineBreak + text });
    else specs.push({ from: to + 1, insert: text });
  });
  if (drop) return [];
  if (!moved) return tr;
  const changes = ChangeSet.of(specs, start.doc.length, start.lineBreak);
  const after = changes.mapPos(Math.min(to + 1, start.doc.length), 1);
  const ranges = start.selection.ranges.map((r) =>
    r.head <= to ? EditorSelection.cursor(after) : EditorSelection.range(changes.mapPos(r.anchor, 1), changes.mapPos(r.head, 1)),
  );
  const userEvent = tr.annotation(Transaction.userEvent);
  return {
    changes,
    selection: EditorSelection.create(ranges, start.selection.mainIndex),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: userEvent ? [Transaction.userEvent.of(userEvent)] : [],
  };
});

/** Ctrl+Home: 격자가 보이면 본문 첫 자리로(격자 앞 0 이 아니라). */
const guardKeys = Prec.high(
  keymap.of([
    {
      key: 'Mod-Home',
      run: (view) => {
        const to = gridEnd(view.state);
        if (to === null) return false;
        const at = Math.min(to + 1, view.state.doc.length);
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: 'select' });
        return true;
      },
    },
  ]),
);

export const frontGuard: Extension = [guardFilter, guardKeys];
