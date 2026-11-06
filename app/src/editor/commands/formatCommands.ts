/**
 * 서식 명령(D9, D10): 단축키, 표 칸으로 넘기기, 팔레트와 맥락 메뉴가 함께 쓰는 한 목록과 그것을 돌리는 runFormat.
 * 빌더(live/format.ts)는 순수하다. 어디에 쓸지(표 칸이면 칸의 셀 편집기, 블록 명령은 칸에서 하지 않는다), 조합 중이면
 * 미루기, 칸에서 쓴 뒤 바깥 기록 끊기는 여기서 정한다.
 */
import { isolateHistory } from '@codemirror/commands';
import { Prec, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin, runScopeHandlers } from '@codemirror/view';
import { t } from '../../i18n/t';
import type { CommandContext } from '../../labnote/commands/context';
import { openNote } from '../../labnote/openNotes';
import { cycleTask, insertLink, setHeading, toggleInline, toggleLinePrefix, wrapCodeBlock, type InlineMark } from '../live/format';
import { activeCellView, cellExtras, outerOf } from '../table/cellEditor';

export interface FormatKey {
  id: string;
  /** CodeMirror 키 표기(예: 'Mod-Shift-.'). 보여 줄 때는 displayKey 로 바꾼다. */
  key: string;
  /** 앱 번역 키(i18n/t.ts, ko·en). */
  nameKey: string;
  /** 한 줄 안의 서식이면 true: 표 칸에서도 쓴다. 블록 서식(제목, 목록, 인용, 코드 블록)은 칸에서 아무것도 하지 않는다. */
  inline: boolean;
  build(s: EditorState): TransactionSpec | null;
}

const mark = (id: string, key: string, nameKey: string, m: InlineMark): FormatKey => ({
  id,
  key,
  nameKey,
  inline: true,
  build: (s) => toggleInline(s, m),
});
const block = (id: string, key: string, nameKey: string, build: (s: EditorState) => TransactionSpec | null): FormatKey => ({
  id,
  key,
  nameKey,
  inline: false,
  build,
});

/** D10 의 서식 행. 제목 이름은 여섯 키를 따로 둔다: 번역 함수에 자리 표시를 넘기지 않는다. */
export const FORMAT_KEYS: readonly FormatKey[] = [
  mark('format-bold', 'Mod-b', 'cmd.format.bold', '**'),
  mark('format-italic', 'Mod-i', 'cmd.format.italic', '*'),
  mark('format-strikethrough', 'Mod-Shift-x', 'cmd.format.strike', '~~'),
  mark('format-code', 'Mod-`', 'cmd.format.code', '`'),
  mark('format-highlight', 'Mod-Shift-h', 'cmd.format.highlight', '=='),
  { id: 'format-link', key: 'Mod-k', nameKey: 'cmd.format.link', inline: true, build: insertLink },
  block('format-heading-1', 'Mod-1', 'cmd.format.heading1', (s) => setHeading(s, 1)),
  block('format-heading-2', 'Mod-2', 'cmd.format.heading2', (s) => setHeading(s, 2)),
  block('format-heading-3', 'Mod-3', 'cmd.format.heading3', (s) => setHeading(s, 3)),
  block('format-heading-4', 'Mod-4', 'cmd.format.heading4', (s) => setHeading(s, 4)),
  block('format-heading-5', 'Mod-5', 'cmd.format.heading5', (s) => setHeading(s, 5)),
  block('format-heading-6', 'Mod-6', 'cmd.format.heading6', (s) => setHeading(s, 6)),
  block('format-paragraph', 'Mod-0', 'cmd.format.paragraph', (s) => setHeading(s, 0)),
  block('format-bullet-list', 'Mod-Shift-8', 'cmd.format.bullet', (s) => toggleLinePrefix(s, 'bullet')),
  block('format-numbered-list', 'Mod-Shift-7', 'cmd.format.numbered', (s) => toggleLinePrefix(s, 'ordered')),
  block('format-task', 'Mod-l', 'cmd.format.task', cycleTask),
  block('format-quote', 'Mod-Shift-.', 'cmd.format.quote', (s) => toggleLinePrefix(s, 'quote')),
  block('format-code-block', 'Mod-Alt-c', 'cmd.format.codeBlock', wrapCodeBlock),
];

/** 조합이 끝나면 돌릴 서식(뷰마다 하나, 한 번만). */
const pending = new WeakMap<EditorView, FormatKey>();

/**
 * 서식 하나를 돌린다. 키를 먹었는지를 돌려준다(늘 true: 할 일이 없어도 키가 브라우저나 다른 keymap 으로 새지 않는다).
 * - 대상은 표 칸의 셀 편집기, 없으면 바깥 편집기. 칸에서 블록 서식은 아무것도 하지 않는다(칸은 한 줄이다).
 * - 한글 조합 중이면 버리지 않고 미뤄 두었다가 다음 compositionend 뒤(requestAnimationFrame) 한 번 돌린다.
 *   조합 중에 문서를 바꾸면 조합이 깨진다.
 * - 빌더의 트랜잭션은 그것만으로 되돌리기 한 번이다. 칸에서는 셀 편집기가 바깥 문서로 넘긴 뒤 바깥 기록도 끊는다:
 *   바로 이어 친 글자가 서식에 합쳐지지 않게(editorInserts.insertDate 와 같다).
 */
export function runFormat(outer: EditorView, f: FormatKey): boolean {
  const cell = activeCellView(outer);
  const target = cell ?? outer;
  if (cell && !f.inline) return true;
  if (target.composing) {
    const waiting = pending.has(target);
    pending.set(target, f);
    if (!waiting) {
      target.contentDOM.addEventListener(
        'compositionend',
        () =>
          requestAnimationFrame(() => {
            const g = pending.get(target);
            pending.delete(target);
            if (g && outer.dom.isConnected) runFormat(outer, g);
          }),
        { once: true },
      );
    }
    return true;
  }
  const spec = f.build(target.state);
  if (!spec) return true;
  target.dispatch(spec);
  if (cell) outer.dispatch({ annotations: isolateHistory.of('after') });
  return true;
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** CodeMirror 키의 마지막 이름 → KeyboardEvent.code. 서식 키에 쓰는 것만. */
function codeOf(name: string): string | undefined {
  if (/^[a-z]$/i.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  return { '.': 'Period', '`': 'Backquote', ';': 'Semicolon' }[name];
}

/** 물리 키(code)와 수식키로 CodeMirror 키를 맞춘다. 조합 중의 keydown 은 key 가 자모나 'Process' 이고 keyCode 가 229 다. */
function matchesCode(cmKey: string, e: KeyboardEvent): boolean {
  const parts = cmKey.split(/-(?!$)/);
  const name = parts.pop() ?? '';
  const want = { ctrl: false, meta: false, shift: false, alt: false };
  for (const p of parts) {
    if (p === 'Mod') want[isMac ? 'meta' : 'ctrl'] = true;
    else if (p === 'Ctrl') want.ctrl = true;
    else if (p === 'Shift') want.shift = true;
    else if (p === 'Alt') want.alt = true;
    else if (p === 'Meta' || p === 'Cmd') want.meta = true;
  }
  return (
    e.ctrlKey === want.ctrl && e.metaKey === want.meta && e.shiftKey === want.shift && e.altKey === want.alt && codeOf(name) === e.code
  );
}

/**
 * 조합 중의 서식 키. CodeMirror 는 조합 중의 키 사건을 keymap 에 넘기지 않는다(ignoreDuringComposition): 그래서 contentDOM 에
 * 직접 듣고, 물리 키로 맞춰 runFormat 에 넘긴다(runFormat 이 compositionend 까지 미룬다). keymap 이 이미 처리한 사건은
 * (defaultPrevented) 건너뛴다. 셀 편집기에도 실어(cellExtras) 칸의 조합도 같다.
 */
const composingFormatKeys = ViewPlugin.define((view) => {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (!(view.composing || e.isComposing || e.keyCode === 229)) return;
    const f = FORMAT_KEYS.find((k) => matchesCode(k.key, e));
    if (!f) return;
    e.preventDefault();
    runFormat(outerOf(view) ?? view, f);
  };
  view.contentDOM.addEventListener('keydown', onKeyDown);
  return { destroy: () => view.contentDOM.removeEventListener('keydown', onKeyDown) };
});

/**
 * Ctrl+Alt+글자의 물리 키 대체(D9). CodeMirror 의 keymap 은 한글 자판의 자모 key 를 keyCode 의 영문 이름으로 바꿔 맞추지만,
 * Windows 의 Ctrl+Alt 는 AltGr 일 수 있어 그 대체를 하지 않는다. 그래서 Mod-Alt-c(코드 블록)와 SP1 의 표 넣기 키 Mod-Alt-t 는
 * e.code 로 영문 글자를 정해 같은 뷰의 keymap 을 다시 돌린다. 셀 편집기에서는 그 편집기의 keymap(cellOuterKeys 포함)이 돈다.
 */
export const ctrlAltCodeFallback: Extension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (!e.ctrlKey || !e.altKey || e.metaKey) return false;
      const m = /^Key([CT])$/.exec(e.code);
      if (!m) return false;
      const letter = m[1].toLowerCase();
      if (e.key.toLowerCase() === letter) return false; // 영문 key 는 keymap 이 그대로 맞춘다
      const as = new KeyboardEvent('keydown', { key: letter, code: e.code, ctrlKey: true, altKey: true, shiftKey: e.shiftKey });
      return runScopeHandlers(view, as, 'editor');
    },
  }),
);

/** 바깥 편집기에 싣는 서식 확장(키 바인딩 말고): 조합 중의 서식 키, Ctrl+Alt 물리 키 대체, 그리고 셀 편집기에도 같은 둘. */
export function formatExtensions(): Extension {
  return [composingFormatKeys, ctrlAltCodeFallback, cellExtras.of([composingFormatKeys, ctrlAltCodeFallback])];
}

/**
 * 팔레트와 맥락 메뉴에서 돌릴 때: 열린 노트의 뷰(ctx.activeView())에 runFormat. 노트가 없으면 noNote 알림, 노트가 열려 있는데
 * 뷰가 없으면(읽는 중, 풀리지 않은 바깥 변경) noteBusy 알림(editorInserts.resolve 와 같다). 돌렸는지를 돌려준다.
 */
export function runFormatCommand(ctx: CommandContext, f: FormatKey): boolean {
  const path = ctx.activePath();
  const view = path ? ctx.activeView() : undefined;
  if (!view) {
    if (path && openNote(path)) ctx.host.notify('warn', t('command.noteBusy'));
    else ctx.host.notify('info', t('cmd.format.noNote'));
    return false;
  }
  return runFormat(view, f);
}
