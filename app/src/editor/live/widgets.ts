import { WidgetType } from '@codemirror/view';

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
