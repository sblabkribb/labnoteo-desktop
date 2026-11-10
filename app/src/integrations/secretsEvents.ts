/**
 * 키가 바뀌었다는 알림(D6, D9). 키 값은 웹뷰에 오지 않는다: 구독자는 슬롯마다 '설정됨' 여부와
 * 바뀐 횟수(epoch)만 받는다. 키를 저장하거나 지운 쪽(설정 대화상자의 KeyField, 플러그인 키 가져오기)이
 * `notifySecretsChange` 를 부르고, partbank 기능과 bfworkflow 준비 상태가 `onSecretsChange` 로 새로 고친다.
 */

export type Slot =
  | 'partbankDesktop'
  | 'partbankWeb'
  | 'llmOpenai'
  | 'bfwServer'
  | 'bfwDesktop'
  | 'slackBot'
  | 'github'
  | 'githubRefresh';

/**
 * 웹뷰가 secret_set / secret_clear 로 직접 저장하거나 지울 수 있는 슬롯. GitHub 토큰 두 슬롯은 Rust 의 GitHub 로그인만
 * 쓴다(secret_set 이 badInput 으로 거절한다). 그래서 일반 KeyField 는 이 타입만 받는다.
 */
export type KeySlot = Exclude<Slot, 'github' | 'githubRefresh'>;

/** Rust `secret_status` 의 모양. */
export interface SecretStatus {
  set: Record<Slot, boolean>;
  epoch: Record<Slot, number>;
}

const listeners = new Set<(status: SecretStatus) => void>();

/** 키가 바뀔 때마다 부른다. 돌려준 함수로 구독을 끝낸다. */
export function onSecretsChange(fn: (status: SecretStatus) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 구독자 모두에게 새 상태를 알린다. 한 구독자가 던져도 나머지는 받는다. */
export function notifySecretsChange(status: SecretStatus): void {
  for (const fn of [...listeners]) {
    try {
      fn(status);
    } catch {
      // 한 구독자의 실패가 다른 구독자를 막지 않는다.
    }
  }
}
