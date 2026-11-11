// @vitest-environment jsdom
/**
 * 상호작용 방식(키보드·포인터) 추적과, 돌려준 초점의 고리(data-focus-ring).
 * 키보드로 일하던 사람에게만 돌려준 초점 자리에 고리를 보인다. 마우스로 닫았으면 고리가 없다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getInteractionModality, startModalityTracking } from '../interactionModality';
import { captureFocus, restoreFocusTo } from '../returnFocus';

let stop: () => void = () => {};

beforeEach(() => {
  stop = startModalityTracking();
});

afterEach(() => {
  stop();
  document.body.textContent = '';
});

const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const point = () => document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
const mouse = () => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

function button(id: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.id = id;
  document.body.append(b);
  return b;
}

describe('interaction modality', () => {
  it('starts as pointer and follows keydown and pointerdown', () => {
    expect(getInteractionModality()).toBe('pointer');
    key('Tab');
    expect(getInteractionModality()).toBe('keyboard');
    point();
    expect(getInteractionModality()).toBe('pointer');
    key('Enter');
    expect(getInteractionModality()).toBe('keyboard');
    mouse();
    expect(getInteractionModality()).toBe('pointer');
  });

  it('a lone modifier key does not count as keyboard use', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) key(k);
    expect(getInteractionModality()).toBe('pointer');
  });

  it('stop removes the listeners', () => {
    stop();
    key('Tab');
    expect(getInteractionModality()).toBe('pointer');
    stop = startModalityTracking();
  });

  it('starting twice keeps tracking until both are stopped', () => {
    const second = startModalityTracking();
    second();
    key('Tab');
    expect(getInteractionModality()).toBe('keyboard');
  });
});

describe('returned focus ring', () => {
  it('after keyboard use the returned element gets data-focus-ring, removed on blur', () => {
    const opener = button('opener');
    opener.focus();
    const restore = captureFocus();
    button('inside').focus();
    key('Escape');
    restore();
    expect(document.activeElement).toBe(opener);
    expect(opener.hasAttribute('data-focus-ring')).toBe(true);
    opener.blur();
    expect(opener.hasAttribute('data-focus-ring')).toBe(false);
  });

  it('after pointer use the returned element gets no ring', () => {
    const opener = button('opener');
    opener.focus();
    const restore = captureFocus();
    button('inside').focus();
    point();
    restore();
    expect(document.activeElement).toBe(opener);
    expect(opener.hasAttribute('data-focus-ring')).toBe(false);
  });

  it('restoreFocusTo ignores a detached or missing element', () => {
    const gone = button('gone');
    gone.remove();
    key('Tab');
    restoreFocusTo(gone);
    expect(gone.hasAttribute('data-focus-ring')).toBe(false);
    restoreFocusTo(null);
  });

  it('restoreFocusTo does not scroll: the editor keeps the place the user was reading', () => {
    // 편집기의 contentDOM 은 문서 전체만큼 길다. 스크롤을 막지 않으면 focus() 가 그 머리로 끌어올려 본문이 맨 위로 간다.
    const editor = document.createElement('div');
    editor.tabIndex = 0;
    document.body.append(editor);
    const calls: (FocusOptions | undefined)[] = [];
    const focus = editor.focus.bind(editor);
    editor.focus = (options?: FocusOptions) => {
      calls.push(options);
      focus(options);
    };
    restoreFocusTo(editor);
    expect(document.activeElement).toBe(editor);
    expect(calls).toEqual([{ preventScroll: true }]);
  });
});
