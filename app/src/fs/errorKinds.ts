/**
 * Rust 의 `FsError` 직렬화가 주는 `kind` 값(`vault/fs.rs`). 분기는 이 상수로만 한다.
 * 문자열은 `src-tauri/tests/ipc-errors.json` 과 같아야 하고, 양쪽 테스트가 그 파일을 읽어 확인한다.
 */
export const ERROR_KINDS = {
  forbidden: 'forbidden',
  escape: 'escape',
  vaultNotFound: 'vaultNotFound',
  noVault: 'noVault',
  notFound: 'notFound',
  io: 'io',
} as const;

export type ErrorKind = (typeof ERROR_KINDS)[keyof typeof ERROR_KINDS];

/** Rust 커맨드가 거부한 값이 이 `kind` 인가. */
export function hasErrorKind(e: unknown, kind: ErrorKind): boolean {
  return !!e && typeof e === 'object' && (e as { kind?: unknown }).kind === kind;
}
