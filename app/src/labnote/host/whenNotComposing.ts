import type { EditorView } from '@codemirror/view';
import type { AppHost } from './createAppHost';

/**
 * 사용자가 부르지 않은 대화상자(A9: 중복 ID·바뀐 ID 질문, Part C 의 MCP 승인)가 열린 뒤 Enter 와 Space 를 무시하는 시간.
 * 편집기에 치던 Enter 가 보지도 못한 질문에 답하지 않게 한다. Escape 는 그대로 닫는다.
 */
export const UNSOLICITED_ARM_MS = 500;

/** 조합이 끝났는지 다시 보는 간격: 조합 중에 뷰가 사라져 compositionend 가 오지 않아도 영원히 기다리지 않게. */
const RECHECK_MS = 1000;

/**
 * 편집기 뷰가 한글 조합 중이 아닐 때 풀린다. 뷰가 없거나 조합 중이 아니면 바로, 조합 중이면 그 뷰의 contentDOM 에
 * 다음 compositionend 가 온 뒤 다시 본다(아직 조합 중이면 또 기다린다). 뷰가 바뀌어도 부를 때마다 `view()` 로 다시 읽는다.
 */
export function whenNotComposing(view: () => EditorView | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    let target: HTMLElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detach = () => {
      target?.removeEventListener('compositionend', check);
      target = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    function check(): void {
      detach();
      const v = view();
      if (!v || !v.composing) {
        resolve();
        return;
      }
      target = v.contentDOM;
      target.addEventListener('compositionend', check);
      timer = setTimeout(check, RECHECK_MS);
    }
    check();
  });
}

/**
 * 사용자가 부르지 않은 질문을 하는 호스트(A9). confirm, pick, choose 는 활성 편집기의 조합이 끝나기를 기다린 뒤
 * `unsolicited: true` 로 연다: 확인은 취소 단추에 초점이 가고, 세 대화상자 모두 처음 `UNSOLICITED_ARM_MS` 동안
 * Enter 와 Space 를 무시한다. 나머지(fs, notify, t …)는 그대로다.
 */
export function unsolicitedHost(host: AppHost, view: () => EditorView | undefined): AppHost {
  return {
    ...host,
    confirm: async (message, opts) => {
      await whenNotComposing(view);
      return host.confirm(message, { ...opts, unsolicited: true });
    },
    pick: async (items, opts) => {
      await whenNotComposing(view);
      return host.pick(items, { ...opts, unsolicited: true });
    },
    choose: async (message, choices, opts) => {
      await whenNotComposing(view);
      return host.choose(message, choices, { ...opts, unsolicited: true });
    },
  };
}
