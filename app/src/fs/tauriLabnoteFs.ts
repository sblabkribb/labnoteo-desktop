import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { LabnoteFs } from '@labnoteo/core';
import { ERROR_KINDS } from './errorKinds';

/** `vault_modify` 의 응답. Rust 의 `ModifyResult` 직렬화 모양. */
type ModifyResult = { kind: 'ok' } | { kind: 'conflict'; current: string };

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** `modify` 가 낙관적 재시도를 소진할 때까지 시도하는 최대 횟수(첫 시도 포함). */
export const MAX_MODIFY_ATTEMPTS = 5;

/** Node 식 오류 코드. 코어는 이 코드로 오류를 가린다(`ENOENT`, `isPathTooLongError` 의 `ENAMETOOLONG`, 잠긴 파일의 `EBUSY`). */
const NODE_CODES: Partial<Record<string, string>> = {
  [ERROR_KINDS.notFound]: 'ENOENT',
  [ERROR_KINDS.pathTooLong]: 'ENAMETOOLONG',
  [ERROR_KINDS.exists]: 'EEXIST',
  // 포트한 isFileLocked 는 EBUSY/EPERM/EACCES 로 "다른 프로그램이 연 파일"을 가린다.
  [ERROR_KINDS.locked]: 'EBUSY',
};

/**
 * Rust 커맨드가 거부한 오류. `kind` 로 분기한다(`message` 는 표시용 문장).
 * 코어는 `code === 'ENOENT'` 로 "없는 파일"을, `ENAMETOOLONG` 으로 너무 긴 경로를 가리므로
 * 해당 kind 에 그 코드를 단다.
 */
export class FsCommandError extends Error {
  readonly code?: string;
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'FsCommandError';
    const code = NODE_CODES[kind];
    if (code) this.code = code;
  }
}

/**
 * 코어가 쓰는 보관함 상대 경로를 Rust `confine` 이 받는 정규형으로 바꾼다.
 * 코어 로더는 루트로 `'.'` 를 넘기고(빈 루트에는 아무것도 돌려주지 않는다), `join('.', x)` 는
 * `./x` 를 만들 수 있다. Rust 는 `.` 과 빈 구성요소를 거부하므로 여기서 지운다.
 * `'.'`·`'./'`·`''` -> `''`(루트), `'./x'` -> `'x'`, `'a/./b'` -> `'a/b'`, `\` -> `/`.
 * `..` 구성요소나 `/` 로 시작하는 경로는 루트를 벗어날 수 있으므로 escape 로 거부한다.
 */
export function normalizeVaultPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  if (slashed.startsWith('/')) throw new FsCommandError(ERROR_KINDS.escape, `path escapes the vault: ${p}`);
  const parts: string[] = [];
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new FsCommandError(ERROR_KINDS.escape, `path escapes the vault: ${p}`);
    parts.push(part);
  }
  return parts.join('/');
}

/** 앱 명령이 쓰는 파일 시스템: 코어의 `LabnoteFs` 에 이름 바꾸기와 휴지통 삭제를 더한다. */
export interface AppFs extends LabnoteFs {
  /** 파일·폴더를 옮기거나 이름을 바꾼다. 대상에 다른 항목이 있으면 `exists`(EEXIST) 로 거부한다. */
  rename(from: string, to: string): Promise<void>;
  /** Windows 휴지통으로 보낸다. 없는 경로는 성공. 영구 삭제로 대신하지 않는다. */
  trash(path: string): Promise<void>;
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

/**
 * Task 3 의 vault_* 커맨드 위에 올린 `LabnoteFs`. 의미론은 Rust 가 책임진다.
 * 모든 경로는 `normalizeVaultPath` 를 거친다. 정규화가 거부하면 invoke 없이 reject 한다.
 */
export class TauriLabnoteFs implements AppFs {
  constructor(private readonly rawInvoke: InvokeFn = tauriInvoke) {}

  private async call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.rawInvoke<T>(cmd, args);
    } catch (e) {
      throw toError(e);
    }
  }

  async read(path: string): Promise<string> {
    return this.call('vault_read', { path: normalizeVaultPath(path) });
  }

  async write(path: string, content: string): Promise<void> {
    return this.call('vault_write', { path: normalizeVaultPath(path), content });
  }

  /**
   * 읽고, updater 를 돌리고, 읽은 값을 expectedBefore 로 같이 보낸다. 비교와 쓰기는
   * Rust 가 경로 잠금 안에서 한다. Conflict 면 돌려받은 current 로 updater 를 다시
   * 돌린다(코어 계약상 동기 함수이므로 재실행해도 await 지점이 끼지 않는다).
   * MAX_MODIFY_ATTEMPTS 번 모두 지면 ModifyConflictError 로 거부한다 — 쓰기 없이 성공한
   * 척하지 않는다.
   */
  async modify(rawPath: string, updater: (data: string) => string): Promise<void> {
    const path = normalizeVaultPath(rawPath);
    let current: string;
    try {
      current = await this.read(path);
    } catch (e) {
      if (!(e instanceof FsCommandError) || e.kind !== ERROR_KINDS.notFound) throw e;
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

  /** 루트(`'.'`, `''`)는 늘 있다: invoke 하지 않는다(Rust `confine` 은 빈 경로를 거부한다). */
  async exists(rawPath: string): Promise<boolean> {
    const path = normalizeVaultPath(rawPath);
    if (path === '') return true;
    return this.call('vault_exists', { path });
  }

  /** 루트를 만들라는 요청은 할 일이 없다: invoke 하지 않는다. */
  async mkdir(rawPath: string): Promise<void> {
    const path = normalizeVaultPath(rawPath);
    if (path === '') return;
    return this.call('vault_mkdir', { path });
  }

  /** 빈 문자열과 `'.'` 은 보관함 루트. */
  async list(dir: string): Promise<string[]> {
    return this.call('vault_list', { dir: normalizeVaultPath(dir) });
  }

  async remove(path: string): Promise<void> {
    return this.call('vault_remove', { path: normalizeVaultPath(path) });
  }

  async rmdir(path: string): Promise<void> {
    return this.call('vault_rmdir', { path: normalizeVaultPath(path) });
  }

  async rename(from: string, to: string): Promise<void> {
    return this.call('vault_rename', { from: normalizeVaultPath(from), to: normalizeVaultPath(to) });
  }

  /** 사용자가 보는 삭제는 이것으로만: 휴지통으로 간다. 코어의 정리용 `remove` 는 그대로 영구 삭제. */
  async trash(path: string): Promise<void> {
    return this.call('vault_trash', { path: normalizeVaultPath(path) });
  }
}
