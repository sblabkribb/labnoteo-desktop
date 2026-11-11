import { isolateHistory } from '@codemirror/commands';
import { WidgetType, type EditorView } from '@codemirror/view';
import { t } from '../../i18n/t';
import { getLang, type Lang } from '../../i18n/lang';

/**
 * 라이브 미리보기의 위젯들(계획 D4). 위젯의 CSS 는 theme.ts 에만 있다.
 */

/** 글머리 목록의 `- ` 대신 보이는 점. 모양이 늘 같으므로 모듈 하나를 함께 쓰고 eq 는 늘 참이다(다시 그리지 않는다). */
export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lno-bullet';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = '•';
    return span;
  }
}

export const bulletWidget = new BulletWidget();

/**
 * A label drawn in place of the source word, display only: the UO Meta `- Experimenter:` reads 실험자 in Korean.
 * The file keeps `Experimenter` (plugin compatibility); the line holding the cursor shows the source.
 */
export class LabelWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(o: LabelWidget): boolean {
    return o.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lno-meta-label';
    span.textContent = this.text;
    return span;
  }
}

/**
 * 할 일 표시 `[ ]`·`[x]` 대신 보이는 체크박스. 문서가 상태를 정한다: 체크 상태가 같으면(eq) 다시 그리지 않고,
 * 다르면 새로 그린다. 누름은 inline.ts 의 taskHandlers 가 받아 toggleTaskAt 으로 문서를 고친다.
 */
export class CheckboxWidget extends WidgetType {
  /** `lang`: 이름표(aria-label)를 그린 언어. 언어가 바뀌면 다시 그린다(editorLang). */
  constructor(
    readonly checked: boolean,
    readonly lang: Lang = getLang(),
  ) {
    super();
  }

  eq(o: CheckboxWidget): boolean {
    return this.checked === o.checked && this.lang === o.lang;
  }

  toDOM(): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'lno-task';
    box.checked = this.checked;
    box.setAttribute('aria-label', t('live.task.toggle'));
    return box;
  }

  /** false: 편집기의 domEventHandlers(taskHandlers)가 이 위젯의 누름을 받는다. */
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * `markerFrom`(할 일 표시 `[` 의 위치) 다음 한 글자만 바꾼다: ' ' 는 'x' 로, 'x'·'X' 는 ' ' 로.
 * 한 번의 거래(userEvent 'input.toggle', 되돌리기 한 단계). 읽기 전용이거나 그 자리가 할 일 표시가 아니면 false.
 */
export function toggleTaskAt(view: EditorView, markerFrom: number): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  if (markerFrom < 0 || markerFrom + 3 > state.doc.length) return false;
  const marker = state.sliceDoc(markerFrom, markerFrom + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return false;
  const insert = marker[1] === ' ' ? 'x' : ' ';
  view.dispatch({
    changes: { from: markerFrom + 1, to: markerFrom + 2, insert },
    userEvent: 'input.toggle',
    annotations: isolateHistory.of('full'),
  });
  return true;
}
