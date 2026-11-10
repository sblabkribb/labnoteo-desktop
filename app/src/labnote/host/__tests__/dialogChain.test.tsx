// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { confirmDialog, promptDialog } from '../dialogStore';
import { cleanupDialogs, renderLayer } from './harness';

/**
 * 명령은 대화상자를 이어 연다(확인 뒤 입력). 앞 대화상자를 닫은 React 커밋보다 명령의 다음 줄(마이크로태스크)이 먼저 돈다.
 * act 가 React 를 동기로 비우면 이 순서가 가려지므로 act 환경을 끄고 진짜 click 과 타이머로 돌린다.
 */
const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const tick = () => new Promise((r) => setTimeout(r, 0));
const layerButton = (cls: string) => document.querySelector<HTMLButtonElement>(`.dialog-layer button.${cls}`);

describe('이어 연 대화상자의 초점 복귀', () => {
  let prev: boolean | undefined;
  beforeEach(() => (prev = env.IS_REACT_ACT_ENVIRONMENT));
  afterEach(() => {
    env.IS_REACT_ACT_ENVIRONMENT = prev;
    cleanupDialogs();
  });

  async function chain(focusTarget: HTMLElement, isFocused: () => boolean) {
    env.IS_REACT_ACT_ENVIRONMENT = false;
    focusTarget.focus();
    const command = (async () => {
      if (await confirmDialog('넣을까요?')) return promptDialog({ title: '이름' });
      return undefined;
    })();
    await tick();
    layerButton('primary')?.click();
    await tick();
    expect(document.querySelector('.dialog-layer input')).toBeTruthy();
    layerButton('primary')?.click();
    await expect(command).resolves.toBe('');
    await tick();
    expect(document.querySelector('.dialog-layer')).toBeNull();
    expect(isFocused()).toBe(true);
  }

  it('confirm then prompt: focus returns to the .shell element', async () => {
    const { outside } = renderLayer();
    await chain(outside, () => document.activeElement === outside);
  });

  it('confirm then prompt: focus returns inside a shadow root', async () => {
    const { shell } = renderLayer();
    const host = document.createElement('div');
    act(() => void shell.appendChild(host));
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.tabIndex = 0;
    root.appendChild(inner);
    await chain(inner, () => root.activeElement === inner);
  });

  it('confirm then prompt: focus returns to a button in #pet-layer, which is not inert between or after', async () => {
    const { petLayer, petButton } = renderLayer({ pet: true });
    let inertAtFocus: boolean | undefined;
    petButton!.addEventListener('focus', () => (inertAtFocus = petLayer!.hasAttribute('inert')));
    let inertMidChain = false;
    const seen = new MutationObserver(() => {
      if (document.querySelector('.dialog-layer')) inertMidChain ||= petLayer!.hasAttribute('inert');
    });
    seen.observe(document.body, { subtree: true, childList: true, attributes: true });
    await chain(petButton!, () => document.activeElement === petButton);
    seen.disconnect();
    expect(inertMidChain).toBe(true);
    expect(petLayer!.hasAttribute('inert')).toBe(false);
    expect(inertAtFocus).toBe(false);
  });
});
