import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { LabnoteFs } from '@labnoteo/core';

/** `vault_modify` 의 응답. Rust 의 `ModifyResult` 직렬화 모양. */
type ModifyResult = { kind: 'ok' } | { kind: 'conflict'; current: string };

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** `modify` 가 낙관적 재시도를 소진할 때까지 시도하는 최대 횟수(첫 시도 포함). */
export const MAX_MODIFY_ATTEMPTS = 5;

/**
 * Rust 커맨드가 거부한 오류. `kind` 로 분기한다(`message` 는 표시용 문장).
 * 코어는 `code === 'ENOENT'` 로 "없는 파일"을 가리므로 notFound 에 그 코드를 단다.
 */
export class FsCommandError extends Error {
  readonly code?: string;
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'FsCommandError';
    if (kind === 'notFound') this.code = 'ENOENT';
  }
}

/** 다른 쓰기와 계속 부딪혀 `modify` 가 반영되지 못했다. 쓰기는 일어나지 않았다. */
export class ModifyConflictError extends Error {
  constructor(
    readonly path: string,
    readonly attempts: number,
  ) {
    super(`modify of ${path} lost the race ${attempts} times; nothing was written`);
    this.name = 'ModifyConflictError';
  }
}

function toError(e: unknown): unknown {
  if (e && typeof e === 'object' && 'kind' in e && typeof (e as { kind: unknown }).kind === 'string') {
    const { kind, message } = e as { kind: string; message?: unknown };
    return new FsCommandError(kind, typeof message === 'string' ? message : kind);
  }
  return e;
}

/** Task 3 의 vault_* 커맨드 위에 올린 `LabnoteFs`. 의미론은 Rust 가 책임진다. */
export class TauriLabnoteFs implements LabnoteFs {
  constructor(private readonly rawInvoke: InvokeFn = tauriInvoke) {}

  private async call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.rawInvoke<T>(cmd, args);
    } catch (e) {
      throw toError(e);
    }
  }

  read(path: string): Promise<string> {
    return this.call('vault_read', { path });
  }

  write(path: string, content: string): Promise<void> {
    return this.call('vault_write', { path, content });
  }

  /**
   * 읽고, updater 를 돌리고, 읽은 값을 expectedBefore 로 같이 보낸다. 비교와 쓰기는
   * Rust 가 경로 잠금 안에서 한다. Conflict 면 돌려받은 current 로 updater 를 다시
   * 돌린다(코어 계약상 동기 함수이므로 재실행해도 await 지점이 끼지 않는다).
   * MAX_MODIFY_ATTEMPTS 번 모두 지면 ModifyConflictError 로 거부한다 — 쓰기 없이 성공한
   * 척하지 않는다.
   */
  async modify(path: string, updater: (data: string) => string): Promise<void> {
    let current: string;
    try {
      current = await this.read(path);
    } catch (e) {
      if (!(e instanceof FsCommandError) || e.kind !== 'notFound') throw e;
      current = '';
    }
    for (let attempt = 1; attempt <= MAX_MODIFY_ATTEMPTS; attempt++) {
      const result = await this.call<ModifyResult>('vault_modify', {
        path,
        content: updater(current),
        expectedBefore: current,
      });
      if (result.kind === 'ok') return;
      current = result.current;
    }
    throw new ModifyConflictError(path, MAX_MODIFY_ATTEMPTS);
  }

  exists(path: string): Promise<boolean> {
    return this.call('vault_exists', { path });
  }

  mkdir(path: string): Promise<void> {
    return this.call('vault_mkdir', { path });
  }

  /** 빈 문자열은 보관함 루트. */
  list(dir: string): Promise<string[]> {
    return this.call('vault_list', { dir });
  }

  remove(path: string): Promise<void> {
    return this.call('vault_remove', { path });
  }

  rmdir(path: string): Promise<void> {
    return this.call('vault_rmdir', { path });
  }
}
