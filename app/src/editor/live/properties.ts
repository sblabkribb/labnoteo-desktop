import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Annotation,
  type ChangeSpec,
  Facet,
  type Extension,
  type StateEffectType,
  type TransactionSpec,
} from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { frontMatterNames, parseFrontMatterYaml } from '@labnoteo/core';
import { frontMatterText } from '../../labnote/frontMatterText';
import { toDocBreaks } from '../../labnote/editTarget';
import { t } from '../../i18n/t';
import { addKey, APP_KEYS, editValue, isWikilinkValue, keyOfLine, READ_ONLY_KEYS, removeKey, renameKey } from './frontEdit';
import { tableOptions } from '../table/field';
import { toggleMode } from './mode';

/**
 * 라이브 미리보기의 속성(Properties) 격자(계획 D7: Task 24 보이기와 경계 지킴이, Task 25 고치기).
 *
 * - 머리말(front matter)이 문서 0 에서 시작해 `---` 로 닫히고, 그 글에 `\r` 이 없고(섞인 줄 끝은 원문으로 둔다),
 *   코어 parseFrontMatterYaml 이 오류를 내지 않을 때만 격자가 머리말 전체를 블록 위젯으로 대신한다. 아니면 원문 그대로다.
 * - "YAML로 편집" 단추는 이 블록만 원문으로 돌린다(rawFront). 선택이 블록을 떠나면 다시 격자다(SP1 rawTables 와 같다).
 * - 원문으로 보이던 머리말을 사용자가 고쳐(IME 조합 포함) 올바르게 되어도 격자는 그 자리에서 나타나지 않는다:
 *   rawFront 가 켜지고, 선택이 블록을 떠날 때 격자로 돌아간다(조합 중인 줄 위에 장식을 얹지 않는다).
 * - 격자가 보이는 동안 사용자 입력(input*·delete*)은 머리말을 건드리지 못한다(frontGuard). 명령(input.labnote)과
 *   격자 자신의 편집(input.properties), userEvent 없는 프로그램 편집은 그대로 지나간다.
 * - 칸은 입력이다(frontEdit 의 최소 편집). Enter·blur 로 적고 Escape 로 되돌리며, 한글 조합 중에는 적지 않는다.
 *   last_updated_date 는 읽기 전용, 중첩 값은 "YAML로 편집"으로, status 는 칩을 눌러 앱의 상태 명령으로 고친다.
 * - 키보드(Task 26): Ctrl+; 는 속성 추가(머리말이 없으면 빈 블록을 넣고 새 속성 칸으로), 본문 첫 줄의 ↑ 와 본문 첫 자리의 ←
 *   는 격자의 마지막 입력으로, 격자 입력의 Escape 는 본문 첫 자리로 돌아간다.
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

function frontNode(state: EditorState): { from: number; to: number } | null {
  if (!state.facet(language)) return null;
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, 4096), 20) ?? syntaxTree(state);
  const first = tree.topNode.firstChild;
  return first && first.name === 'Frontmatter' && first.from === 0 ? { from: 0, to: first.to } : null;
}

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** 값(또는 목록의 항목)에 줄바꿈이 든 글이 있는가. */
const hasLineBreak = (v: unknown): boolean =>
  typeof v === 'string' ? /[\r\n]/.test(v) : Array.isArray(v) && v.some((x) => typeof x === 'string' && /[\r\n]/.test(x));

/** 블록(`|`)·접힌(`>`) 스칼라의 머리: 키 줄의 `:` 뒤, 또는 목록 항목 `- ` 뒤. */
const BLOCK_SCALAR = /^\s*(?:-\s+)?[|>][-+0-9]*\s*(?:#.*)?$/;

/** 한 줄 입력이 실제로 지니는 글: HTML 은 input.value 에서 줄바꿈(CR·LF)을 지운다. */
const inputText = (s: string) => s.replace(/[\r\n]/g, '');

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
    if (READ_ONLY_KEYS.has(key)) cell = 'readOnly';
    // 여러 줄 글(블록·접힌 스칼라, 줄바꿈이 든 따옴표 글)은 한 줄 입력에 담기면 납작해진다: "YAML로 편집"으로만 고친다
    else if (hasLineBreak(value) || source.some((l) => BLOCK_SCALAR.test(l))) cell = 'nested';
    else if (isWikilinkValue(source) || (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'string' && /^\[\[.*\]\]$/.test(x))))
      cell = 'wikilink';
    else if (Array.isArray(value)) cell = value.every(isScalar) ? 'list' : 'nested';
    else cell = isScalar(value) ? 'scalar' : 'nested';
    return { key, value, line, cell };
  });
  // 파일 순서(자바스크립트 객체는 정수 같은 키를 앞으로 옮긴다). 줄을 찾지 못한 키는 맨 뒤에.
  entries.sort((a, b) => (a.line < 0 ? Infinity : a.line) - (b.line < 0 ? Infinity : b.line));
  return { from: 0, to: node.to, text, entries };
}

/** 칸에 보일 글. 목록은 쉼표로 잇고, 위키링크는 이름만 보인다(고치면 `[[…]]` 로 다시 적는다). */
function cellText(e: FrontEntry): string {
  // 쉼표가 든 이름은 `[[…]]` 째로 보인다(고칠 때 쉼표로 나뉘지 않게)
  if (e.cell === 'wikilink') return frontMatterNames(e.value).map((n) => (n.includes(',') ? `[[${n}]]` : n)).join(', ');
  if (e.cell === 'list') return (e.value as unknown[]).map((x) => (x === null ? '' : String(x))).join(', ');
  if (e.cell === 'nested') return JSON.stringify(e.value);
  return e.value === null || e.value === undefined ? '' : String(e.value);
}

/** 이 블록을 원문(YAML)으로 보인다(true) / 격자로 돌린다(false). */
export const editYaml: StateEffectType<boolean> = StateEffect.define<boolean>();

/** 머리말을 고치는 사용자 입력·지움인가(명령과 격자 자신의 편집은 빼고). IME 조합(input.type.compose)도 여기 든다. */
function isUserEdit(tr: Transaction): boolean {
  if (!(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return false;
  return !(tr.isUserEvent('input.properties') || tr.isUserEvent('input.labnote'));
}

/**
 * "YAML로 편집"이 켜져 있는가. 선택이 머리말을 떠나면 꺼진다(켜는 그 트랜잭션에서는 끄지 않는다).
 * 격자가 없던 머리말 안에서 사용자가 고치면 저절로 켜진다: 고친 결과가 올바른 머리말이어도 격자가 입력 밑에서 나타나지 않는다.
 */
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
    if (!on && !set && tr.docChanged && isUserEdit(tr) && gridEnd(tr.startState) === null) {
      const node = frontNode(tr.state);
      if (node && tr.state.selection.main.head <= node.to) return true;
    }
    if (!on || set || (!tr.selection && !tr.docChanged)) return on;
    const node = frontNode(tr.state);
    if (!node) return false;
    return tr.state.selection.ranges.some((r) => r.from <= node.to);
  },
});

function editYamlButton(view: EditorView): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lno-btn lno-props-edit';
  b.textContent = t('props.editYaml');
  b.setAttribute('aria-label', t('props.editYaml'));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    editYamlCommand(view);
  });
  return b;
}

/** 격자가 앱에 넘기는 일. 상태 칩은 직접 쓰지 않고 앱의 "실험 상태 바꾸기" 명령을 부른다(Editor 의 onChangeStatus). */
export interface PropertiesActions {
  onChangeStatus?: () => void;
}

export const propertiesActions: Facet<PropertiesActions, PropertiesActions> = Facet.define<PropertiesActions, PropertiesActions>({
  combine: (values) => values[0] ?? {},
});

/** 원래 값(되돌리기·바뀌었는지 비교용). */
const ORIG = 'orig';

/**
 * 편집기가 잠겨 있는가(Editor.tsx 의 LOCKED: 바깥 변경·충돌 대화 상자, 불러오는 중, 오류). 격자의 입력은 ignoreEvent 위젯 안의
 * 브라우저 입력이라 편집기의 readOnly·editable 이 막지 못한다: 잠긴 동안 입력은 읽기 전용, 단추는 쓰지 못하게 한다.
 */
const locked = (state: EditorState) => state.readOnly || !state.facet(EditorView.editable);

/** 격자 안의 입력·쓰는 단추를 잠금에 맞춘다. */
function applyLock(box: HTMLElement, on: boolean): void {
  for (const input of box.querySelectorAll<HTMLInputElement>('input.lno-props-input')) input.readOnly = on;
  for (const b of box.querySelectorAll<HTMLButtonElement>('.lno-props-remove, .lno-props-add-btn, .lno-props-status')) b.disabled = on;
}

/** 잠금이 바뀌면(장식은 그대로) 보이는 격자에 알린다. */
const lockSync = ViewPlugin.define(() => ({
  update(u: ViewUpdate) {
    const on = locked(u.state);
    if (on === locked(u.startState)) return;
    for (const box of u.view.dom.querySelectorAll<HTMLElement>('.lno-props')) applyLock(box, on);
  },
}));

const focused = (el: Element) => (el.getRootNode() as Document | ShadowRoot).activeElement === el;

/** 조합 중인 키인가(한글 IME). 조합 중의 Enter·Escape 는 IME 의 것이다. */
const composingKey = (e: KeyboardEvent, composing: boolean) => composing || e.isComposing || e.keyCode === 229;

/** Ctrl(맥은 Cmd)+E. 입력 안의 키는 편집기 keymap 에 닿지 않으므로(ignoreEvent) 여기서 모드를 바꾼다. 한글 자판이어도 물리 키로 맞춘다. */
const isToggleMode = (e: KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'e' || e.code === 'KeyE');

/** Ctrl(맥은 Cmd)+S. 입력 안의 키는 편집기 keymap 에 닿지 않으므로 칸에서 적은 뒤 편집기의 저장을 부른다. */
const isSave = (e: KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 's' || e.code === 'KeyS');

/** 편집기의 저장(표 확장이 실은 tableOptions.save, Editor.tsx 의 Mod-s 와 같은 저장). */
const save = (view: EditorView) => view.state.facet(tableOptions)?.save();

interface InputOpts {
  className: string;
  value: string;
  label: string;
  /** 고친 글로 만든 편집. null 이면 받지 않는다(입력을 되돌린다). */
  edit: (state: EditorState, raw: string) => TransactionSpec | null;
  /** 편집을 보낸 뒤(격자가 다시 그려진 뒤) 할 일. */
  after?: () => void;
}

/**
 * 격자의 입력 칸. Enter 나 초점을 잃을 때 한 번의 편집으로 적고, Escape 는 원래 값으로 되돌린다.
 * 조합 중(compositionstart~end, isComposing, keyCode 229)에는 아무것도 적지 않는다.
 */
function gridInput(view: EditorView, o: InputOpts): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = `lno-props-input ${o.className}`;
  input.value = o.value;
  // 비교는 입력이 실제로 지닌 글로: 보이는 것만 다른(줄바꿈이 지워진) 값이 적히는 일이 없게
  input.dataset[ORIG] = input.value;
  input.setAttribute('aria-label', o.label);
  input.spellcheck = false;
  input.readOnly = locked(view.state);
  let composing = false;
  const commit = () => {
    const orig = input.dataset[ORIG] ?? '';
    if (input.value === orig) return;
    if (input.readOnly || locked(view.state)) {
      input.value = orig;
      return;
    }
    const spec = o.edit(view.state, input.value);
    if (!spec) {
      input.value = orig;
      return;
    }
    input.dataset[ORIG] = input.value; // 다시 그리는 사이의 blur 가 한 번 더 적지 않게
    view.dispatch(spec);
    o.after?.();
  };
  input.addEventListener('compositionstart', () => (composing = true));
  input.addEventListener('compositionend', () => {
    composing = false;
    // 조합 중에 초점을 잃었으면(blur 는 적지 않았다) 조합이 끝난 글을 여기서 적는다
    queueMicrotask(() => {
      if (input.isConnected && !focused(input)) commit();
    });
  });
  input.addEventListener('keydown', (e) => {
    if (composingKey(e, composing)) return;
    if (isToggleMode(e)) {
      e.preventDefault();
      commit();
      toggleMode();
      view.focus();
    } else if (isSave(e)) {
      e.preventDefault();
      commit();
      save(view);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // 먼저 되돌린다: 본문으로 초점을 옮기며 생기는 blur 가 적을 것이 없게
      input.value = input.dataset[ORIG] ?? '';
      returnToBody(view);
    }
  });
  input.addEventListener('blur', () => {
    // 격자를 다시 그리며 떼어 낸 입력, 조합 중의 blur 는 적지 않는다
    if (!input.isConnected || composing) return;
    commit();
  });
  return input;
}

/** 격자에서 본문 첫 자리(to + 1)로 돌아간다. 격자가 없으면 초점만 돌려준다. */
function returnToBody(view: EditorView): void {
  const to = gridEnd(view.state);
  if (to !== null) view.dispatch({ selection: { anchor: Math.min(to + 1, view.state.doc.length) }, userEvent: 'select' });
  view.focus();
}

/** 다시 그린 격자에서 그 입력에 초점을 준다. */
function refocus(view: EditorView, selector: string): void {
  const el = view.dom.querySelector<HTMLElement>(`.lno-props ${selector}`);
  if (el) el.focus();
  else view.focus();
}

const cssString = (s: string) => JSON.stringify(s);

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
    box.append(addRow(view));
    applyLock(box, locked(view.state));
    // 블록 위젯의 뿌리는 바깥 여백(margin)이 없어야 한다: CodeMirror 는 테두리 상자로 높이를 재므로 여백만큼 아래 줄의
    // 클릭 위치가 어긋난다. 간격은 감싼 틀의 padding 이 맡는다.
    const wrap = document.createElement('div');
    wrap.className = 'lno-props-wrap';
    wrap.append(box);
    // 격자의 단추에 초점이 있을 때 누른 글자는 버린다: 편집 가능한 본문 안이라 브라우저가 앞서 고치던 입력으로 초점을 옮겨
    // 그 값에 글을 덧붙인다. Enter·Space·Tab·단축키는 그대로 둔다.
    wrap.addEventListener('keydown', (e) => {
      if (!(e.target instanceof HTMLButtonElement)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.key.length === 1 && e.key !== ' ') || e.key === 'Process' || e.keyCode === 229) e.preventDefault();
    });
    return wrap;
  }

  private row(e: FrontEntry, view: EditorView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'lno-props-row';
    row.dataset.key = e.key;
    row.dataset.cell = e.cell;
    const editable = e.cell !== 'readOnly' && e.cell !== 'nested';
    // status 는 앱의 상태 명령으로만 고친다: 이름 바꾸기·지우기도 격자에서 하지 않는다
    const appKey = APP_KEYS.has(e.key);
    const key = editable && !appKey
      ? gridInput(view, {
          className: 'lno-props-key',
          value: e.key,
          label: t('props.keyName', e.key),
          edit: (state, raw) => renameKey(state, e.key, raw),
          after: () => refocus(view, `.lno-props-row[data-key=${cssString(e.key)}] input.lno-props-key`),
        })
      : document.createElement('span');
    if (!editable || appKey) {
      key.className = 'lno-props-key';
      key.textContent = e.key;
    }
    row.append(key, this.value(e, view));
    const actions = document.createElement('span');
    actions.className = 'lno-props-actions';
    if (e.cell === 'nested') actions.append(editYamlButton(view));
    if (e.cell !== 'readOnly' && !appKey) actions.append(removeButton(view, e.key));
    row.append(actions);
    return row;
  }

  private value(e: FrontEntry, view: EditorView): HTMLElement {
    if (e.key === 'status' && e.cell === 'scalar') {
      // 상태는 칩: 누르면 앱의 상태 바꾸기 명령(허용된 상태만 고르게 하고, 노트 목록·기록도 함께 맞춘다)
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lno-chip lno-props-value lno-props-status';
      chip.textContent = cellText(e);
      chip.title = t('props.changeStatus');
      chip.addEventListener('click', (ev) => {
        ev.preventDefault();
        view.state.facet(propertiesActions).onChangeStatus?.();
      });
      return chip;
    }
    if (e.cell === 'readOnly' || e.cell === 'nested') {
      const value = document.createElement('span');
      value.className = 'lno-props-value';
      value.textContent = cellText(e);
      if (e.cell === 'readOnly') value.title = t('props.readOnly');
      return value;
    }
    return gridInput(view, {
      className: 'lno-props-value',
      value: cellText(e),
      label: t('props.value', e.key),
      edit: (state, raw) => editValue(state, e.key, raw),
    });
  }

  /** 같은 키들(같은 순서·종류)이면 값만 제자리에서 바꾼다. 초점이 있고 고치던 입력은 건드리지 않는다. */
  updateDOM(root: HTMLElement, view: EditorView): boolean {
    const dom = root.querySelector<HTMLElement>(':scope > .lno-props');
    if (!dom) return false;
    const rowEls = [...dom.querySelectorAll<HTMLElement>(':scope > .lno-props-row')];
    const entries = this.block.entries;
    if (rowEls.length !== entries.length) return false;
    if (rowEls.some((r, i) => r.dataset.key !== entries[i].key || r.dataset.cell !== entries[i].cell)) return false;
    rowEls.forEach((r, i) => {
      const v = r.querySelector<HTMLElement>('.lno-props-value');
      const text = cellText(entries[i]);
      if (v instanceof HTMLInputElement) {
        if (v.dataset[ORIG] === inputText(text)) return;
        if (focused(v) && v.value !== v.dataset[ORIG]) return; // 고치는 중이다: 사용자의 글을 덮지 않는다
        v.value = text;
        v.dataset[ORIG] = v.value;
      } else if (v && v.textContent !== text) v.textContent = text;
    });
    dom.setAttribute('aria-label', t('props.label'));
    applyLock(dom, locked(view.state));
    return true;
  }

  get estimatedHeight(): number {
    return 32 + 28 * (this.block.entries.length + 1);
  }

  /** 격자 안의 누름·키는 편집기가 받지 않는다(단추와 입력이 스스로 처리한다). */
  ignoreEvent(): boolean {
    return true;
  }
}

function removeButton(view: EditorView, key: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lno-btn lno-props-remove';
  b.textContent = '×'; // 기호(글자 아님): 읽어 주는 이름은 aria-label
  b.title = t('props.remove');
  b.setAttribute('aria-label', t('props.removeKey', key));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    const spec = removeKey(view.state, key);
    if (!spec) return;
    view.dispatch(spec);
    refocus(view, `input[aria-label=${cssString(t('props.add'))}]`);
  });
  return b;
}

/** 새 속성 줄: 이름과 값을 적고 Enter(또는 단추)로 닫는 `---` 앞에 더한다. 초점을 잃는 것만으로는 더하지 않는다. */
function addRow(view: EditorView): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lno-props-add';
  const key = document.createElement('input');
  key.type = 'text';
  key.className = 'lno-props-input lno-props-key';
  key.setAttribute('aria-label', t('props.add'));
  key.spellcheck = false;
  const value = document.createElement('input');
  value.type = 'text';
  value.className = 'lno-props-input lno-props-new-value';
  value.setAttribute('aria-label', t('props.newValue'));
  value.spellcheck = false;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lno-btn lno-props-add-btn';
  button.textContent = t('props.add');
  const add = () => {
    if (locked(view.state)) return;
    // 이름이 비었으면 실패로 표시하지 않고 이름 칸으로 데려간다(단추에 초점이 남으면 다음 글자가 엉뚱한 입력으로 간다)
    if (key.value.trim() === '') {
      key.removeAttribute('aria-invalid');
      key.focus();
      return;
    }
    const spec = addKey(view.state, key.value, value.value);
    if (!spec) {
      key.setAttribute('aria-invalid', 'true');
      return;
    }
    view.dispatch(spec);
    refocus(view, `input[aria-label=${cssString(t('props.add'))}]`);
  };
  for (const input of [key, value]) {
    let composing = false;
    input.addEventListener('compositionstart', () => (composing = true));
    input.addEventListener('compositionend', () => (composing = false));
    input.addEventListener('input', () => key.removeAttribute('aria-invalid'));
    input.addEventListener('keydown', (e) => {
      if (composingKey(e, composing)) return;
      if (isToggleMode(e)) {
        e.preventDefault();
        toggleMode();
        view.focus();
      } else if (isSave(e)) {
        e.preventDefault();
        save(view);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        add();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        key.value = '';
        value.value = '';
        key.removeAttribute('aria-invalid');
        returnToBody(view);
      }
    });
  }
  button.addEventListener('click', (e) => {
    e.preventDefault();
    add();
  });
  row.append(key, value, button);
  return row;
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
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f)), lockSync],
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
 * - [0, to + 1) 에 닿는 지움은 to + 1 부터로 자른다(머리말은 그대로, 본문 쪽만 지운다). 남는 바뀜이 없으면 버린다.
 * - 옮긴 트랜잭션은 userEvent·addToHistory·isolateHistory·remote 주석을 그대로 지닌다.
 */
const guardFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !isUserEdit(tr)) return tr;
  const to = gridEnd(tr.startState);
  if (to === null) return tr;
  const start = tr.startState;
  const body = to + 1;
  let moved = false;
  let kept = 0;
  const specs: ChangeSpec[] = [];
  /** 머리말에 닿은 넣기는 본문 첫 자리로. 문서가 `to` 에서 끝나면 줄바꿈을 먼저 넣는다. */
  const insertAtBody = (text: string) => {
    if (!text) return;
    kept++;
    if (start.doc.length === to) specs.push({ from: to, insert: start.lineBreak + text });
    else specs.push({ from: body, insert: text });
  };
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA >= body || (toA === fromA && fromA > to)) {
      kept++;
      specs.push({ from: fromA, to: toA, insert: inserted });
      return;
    }
    moved = true;
    // [0, to + 1) 에 닿는 지움은 본문 쪽만 남긴다(Ctrl+A 뒤 입력·지움, Ctrl+Shift+Home 뒤 입력)
    if (toA > body) {
      kept++;
      specs.push({ from: body, to: toA, insert: inserted });
    } else insertAtBody(inserted.toString());
  });
  if (!moved) return tr;
  if (!kept) return [];
  const changes = ChangeSet.of(specs, start.doc.length, start.lineBreak);
  const after = changes.mapPos(Math.min(body, start.doc.length), 1);
  const wanted = tr.selection;
  const ranges = start.selection.ranges.map((r, i) => {
    if (r.head <= to) return EditorSelection.cursor(after);
    if (wanted?.ranges[i]?.empty) return EditorSelection.cursor(changes.mapPos(r.head, 1));
    return EditorSelection.range(changes.mapPos(r.anchor, 1), changes.mapPos(r.head, 1));
  });
  const annotations: Annotation<unknown>[] = [];
  const userEvent = tr.annotation(Transaction.userEvent);
  if (userEvent) annotations.push(Transaction.userEvent.of(userEvent));
  const addToHistory = tr.annotation(Transaction.addToHistory);
  if (addToHistory !== undefined) annotations.push(Transaction.addToHistory.of(addToHistory));
  const isolate = tr.annotation(isolateHistory);
  if (isolate !== undefined) annotations.push(isolateHistory.of(isolate));
  const remote = tr.annotation(Transaction.remote);
  if (remote !== undefined) annotations.push(Transaction.remote.of(remote));
  return {
    changes,
    selection: EditorSelection.create(ranges, start.selection.mainIndex),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations,
  };
});

/** 속성 추가의 단축키(Editor.tsx 의 Prec.highest keymap, 표 칸의 cellOuterKeys, 팔레트의 보이는 키). */
export const PROPS_ADD_KEY = 'Mod-;';

/** 보이는 격자의 새 속성 이름 칸에 초점을 준다. 격자가 없거나 잠겨 있으면 false. */
function focusAddRow(view: EditorView): boolean {
  const input = view.dom.querySelector<HTMLInputElement>('.lno-props .lno-props-add input.lno-props-key');
  if (!input || input.readOnly) return false;
  input.focus();
  return true;
}

/**
 * 속성 추가(Ctrl+;, 팔레트). 머리말이 없으면 문서 맨 앞에 빈 블록 `---\n---\n` 을 넣고(input.properties, 한 번의 되돌리기),
 * 격자가 보이면 새 속성 이름 칸에 초점을 준다. 격자가 없으면(소스 보기, "YAML로 편집", 격자로 못 보이는 머리말) 닫는 `---`
 * 앞에 빈 줄을 열고 커서를 둔다. 잠긴 편집기에서는 아무것도 하지 않는다(false).
 */
export function addPropertyCommand(view: EditorView): boolean {
  const state = view.state;
  if (locked(state)) return false;
  const live = state.field(propertiesField, false) !== undefined && !state.field(rawFront, false);
  const node = frontNode(state);
  if (!node) {
    // 소스 보기에서는 빈 줄을 품은 블록을 넣는다: 커서가 그 빈 줄에 서서 바로 `키: 값` 을 적는다
    view.dispatch({
      changes: { from: 0, insert: toDocBreaks(live ? '---\n---\n' : '---\n\n---\n', state) },
      selection: { anchor: 4 },
      scrollIntoView: true,
      userEvent: 'input.properties',
      annotations: isolateHistory.of('full'),
    });
    if (focusAddRow(view)) return true;
    view.focus();
    return true;
  }
  if (gridEnd(state) !== null) {
    view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });
    if (focusAddRow(view)) return true;
  }
  // 원문으로 보이는 머리말: 닫는 `---` 줄 앞에 빈 줄을 열고 그 줄에 커서를 둔다
  const close = state.doc.lineAt(node.to).from;
  view.dispatch({
    changes: { from: close, insert: state.lineBreak },
    selection: { anchor: close },
    scrollIntoView: true,
    userEvent: 'input.properties',
    annotations: isolateHistory.of('full'),
  });
  view.focus();
  return true;
}

/** 속성을 YAML로 편집(팔레트): 머리말을 원문으로 보이고 커서를 그 안(4)에 둔다. 머리말이 없으면 false. */
export function editYamlCommand(view: EditorView): boolean {
  if (!frontNode(view.state)) return false;
  view.dispatch({
    effects: editYaml.of(true),
    selection: { anchor: Math.min(4, view.state.doc.length) },
    scrollIntoView: true,
    userEvent: 'select',
  });
  view.focus();
  return true;
}

/** 보이는 격자의 마지막 입력에 초점을 준다(키보드로 격자에 들어가기). 격자가 없거나 입력이 없으면 false. */
export function focusGridLast(view: EditorView): boolean {
  if (gridEnd(view.state) === null) return false;
  const inputs = view.dom.querySelectorAll<HTMLInputElement>('.lno-props input');
  const last = inputs[inputs.length - 1];
  if (!last) return false;
  last.focus();
  return true;
}

/** 빈 커서 하나뿐이면 그 위치. */
function soleCursor(state: EditorState): number | null {
  const sel = state.selection;
  return sel.ranges.length === 1 && sel.main.empty ? sel.main.head : null;
}

/** ↑: 커서가 본문 첫 줄(줄바꿈으로 접힌 줄이면 그 첫 화면 줄)에 있으면 격자로. */
function arrowUpIntoGrid(view: EditorView): boolean {
  const to = gridEnd(view.state);
  const head = soleCursor(view.state);
  if (to === null || head === null || head <= to) return false;
  if (view.state.doc.lineAt(head).from !== to + 1) return false;
  // 접힌 첫 줄의 둘째 화면 줄이면 위로 움직여도 그 줄 안이다: 편집기에 맡긴다
  const up = view.moveVertically(view.state.selection.main, false);
  if (up.head > to && up.head < head) return false;
  return focusGridLast(view);
}

/** ←: 커서가 본문 첫 자리(to + 1)면 격자로. */
function arrowLeftIntoGrid(view: EditorView): boolean {
  const to = gridEnd(view.state);
  return to !== null && soleCursor(view.state) === to + 1 && focusGridLast(view);
}

/** Ctrl+Home: 격자가 보이면 본문 첫 자리로(격자 앞 0 이 아니라). */
const guardKeys = Prec.high(
  keymap.of([
    { key: PROPS_ADD_KEY, preventDefault: true, run: addPropertyCommand },
    { key: 'ArrowUp', run: arrowUpIntoGrid },
    { key: 'ArrowLeft', run: arrowLeftIntoGrid },
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

/**
 * IME 조합이 격자 왼쪽 끝(0 등, 머리말 안)의 커서에서 시작하면 DOM 조합은 그 자리에 남고 글은 본문으로 옮겨져 어긋난다.
 * 조합을 여는 keydown(Process / keyCode 229)에서 커서를 먼저 본문 첫 자리로 옮긴다(조합이 시작되기 전이다).
 */
const guardCompose = EditorView.domEventHandlers({
  keydown(e, view) {
    if (view.composing || !(e.keyCode === 229 || e.key === 'Process')) return false;
    const to = gridEnd(view.state);
    const main = view.state.selection.main;
    if (to === null || !main.empty || main.head > to) return false;
    view.dispatch({ selection: { anchor: Math.min(to + 1, view.state.doc.length) }, userEvent: 'select' });
    return false;
  },
});

export const frontGuard: Extension = [guardFilter, guardKeys, guardCompose];
