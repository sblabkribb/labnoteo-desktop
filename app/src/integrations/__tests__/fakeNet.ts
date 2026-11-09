import { NetError, type InvokeFn, type NetErrorKind, type SecretStatus, type Slot } from '../netIpc';

/** 이 파일이 쓰는 슬롯 전부. `secretStatusOf` 가 빠진 슬롯을 채울 때 쓴다. */
const SLOTS: readonly Slot[] = ['partbankDesktop', 'partbankWeb', 'llmOpenai', 'bfwServer', 'bfwDesktop', 'slackBot'];

/**
 * Rust 흉내 invoke. 알려진 커맨드만 답하고(경로 함수가 던지면 그 값으로 거절), 모르는 커맨드는
 * `{kind:'badInput', message:'unrouted <cmd>'}` 로 거절한다. 보낸 커맨드와 인자를 차례로 기록한다.
 */
export function fakeInvoke(routes: Record<string, (args: Record<string, unknown>) => unknown>): {
  invoke: InvokeFn;
  calls: Array<[string, Record<string, unknown>]>;
} {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push([cmd, args]);
    const route = routes[cmd];
    if (!route) throw { kind: 'badInput', message: `unrouted ${cmd}` };
    return route(args);
  };
  return { invoke: invoke as InvokeFn, calls };
}

/**
 * Rust 가 거절할 때의 모양 `{kind, message, status?, body?, location?}`. `message` 는 늘 'raw-rust-text' 라서
 * 테스트가 이 글이 사용자에게 가지 않는지 확인할 수 있다.
 */
export function netError(
  kind: NetErrorKind,
  extra: { status?: number; body?: string; location?: string } = {},
): NetError {
  return new NetError(kind, 'raw-rust-text', extra.status, extra.body, extra.location);
}

/** 빠진 슬롯은 `false` 와 `0` 으로 채운 `secret_status` 답. */
export function secretStatusOf(
  set: Partial<Record<Slot, boolean>>,
  epoch: Partial<Record<Slot, number>> = {},
): SecretStatus {
  return {
    set: Object.fromEntries(SLOTS.map((s) => [s, set[s] ?? false])) as Record<Slot, boolean>,
    epoch: Object.fromEntries(SLOTS.map((s) => [s, epoch[s] ?? 0])) as Record<Slot, number>,
  };
}
