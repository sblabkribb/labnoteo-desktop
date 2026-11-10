import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { DialogLayer } from '../DialogLayer';
import { closeAllDialogs } from '../dialogStore';

/**
 * 앱처럼 .shell 과 그 밖의 DialogLayer 를 그린다. .shell 안에는 대화상자가 열리기 전 초점을 가질 단추가 있다.
 * `pet` 이면 App.tsx 처럼 .shell 밖에 #pet-layer(단추 하나)도 그린다.
 */
function Harness({ pet }: { pet?: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="shell" ref={shell}>
        <button type="button">outside</button>
      </div>
      <DialogLayer blockRef={shell} />
      {pet ? (
        <div id="pet-layer">
          <button type="button">pet</button>
        </div>
      ) : null}
    </>
  );
}

export function renderLayer(opts: { pet?: boolean } = {}) {
  const view = render(<Harness pet={opts.pet} />);
  const shell = view.container.querySelector('.shell') as HTMLElement;
  const outside = view.container.querySelector('.shell button') as HTMLButtonElement;
  const petLayer = document.getElementById('pet-layer');
  const petButton = petLayer?.querySelector('button') ?? null;
  return { ...view, shell, outside, petLayer, petButton };
}

/** 대화상자를 연다: 저장소 변경이 React 갱신이므로 act 안에서. */
export function openIn<R>(open: () => Promise<R>): Promise<R> {
  let p!: Promise<R>;
  act(() => {
    p = open();
  });
  return p;
}

/** 해결 여부를 동기적으로 엿본다. */
export function settled<R>(p: Promise<R>): { done: boolean; value?: R } {
  const state: { done: boolean; value?: R } = { done: false };
  void p.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
}

export function cleanupDialogs(): void {
  act(() => closeAllDialogs());
}

/** 그려진 DOM 에 style 속성이 하나도 없다(CSP style-src 'self'). */
export function styleAttributes(): string[] {
  return [...document.querySelectorAll('[style]')].map((el) => el.outerHTML.slice(0, 80));
}
