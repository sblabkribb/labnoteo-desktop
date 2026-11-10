// @vitest-environment jsdom
/** focusableIn: 대화상자의 Tab 가두기가 도는 요소들. 숨은 쪽(hidden, inert, aria-hidden)과 꺼진 요소는 빠진다. */
import { afterEach, describe, expect, it } from 'vitest';
import { focusableIn } from '../focusable';

afterEach(() => {
  document.body.textContent = '';
});

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const ids = (els: HTMLElement[]) => els.map((el) => el.id);

describe('focusableIn', () => {
  it('lists tabbable controls in document order', () => {
    const root = mount(`
      <button id="b"></button>
      <input id="i" />
      <select id="s"></select>
      <textarea id="t"></textarea>
      <a id="a" href="#x"></a>
      <a id="nohref"></a>
      <div id="tab0" tabindex="0"></div>
      <div id="tabneg" tabindex="-1"></div>
      <div id="ce" contenteditable="true"></div>
      <details><summary id="sum">more</summary></details>
    `);
    expect(ids(focusableIn(root))).toEqual(['b', 'i', 's', 't', 'a', 'tab0', 'ce', 'sum']);
  });

  it('skips disabled controls', () => {
    const root = mount(`<button id="on"></button><button id="off" disabled></button><input id="x" disabled />`);
    expect(ids(focusableIn(root))).toEqual(['on']);
  });

  it('skips anything under a [hidden], [inert] or [aria-hidden="true"] ancestor inside root', () => {
    const root = mount(`
      <button id="first"></button>
      <section hidden><button id="h"></button></section>
      <div inert><button id="in"></button></div>
      <div aria-hidden="true"><div><button id="ah"></button></div></div>
      <div aria-hidden="false"><button id="shown"></button></div>
      <button id="self-hidden" hidden></button>
      <button id="last"></button>
    `);
    expect(ids(focusableIn(root))).toEqual(['first', 'shown', 'last']);
  });

  it('only checks ancestors up to root (a hidden root still lists its children)', () => {
    const outer = mount(`<div id="r" aria-hidden="true"><button id="b"></button></div>`);
    const root = outer.querySelector<HTMLElement>('#r')!;
    expect(ids(focusableIn(root))).toEqual(['b']);
  });
});
