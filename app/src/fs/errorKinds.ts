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
  /** Windows 가 경로를 너무 길다고 거부했다(오류 206). 없는 파일은 경로가 길어도 notFound 다. */
  pathTooLong: 'pathTooLong',
  /** rename 대상에 다른 파일·폴더가 이미 있다. */
  exists: 'exists',
  /** `vault_read_image` 대상이 이미지 확장자의 일반 파일이 아니다. */
  notImage: 'notImage',
  /** `vault_read_image` 대상이 20 MiB 를 넘는다. */
  tooLarge: 'tooLarge',
  /** 인자가 잘못됐다(예: `vault_created_times` 에 경로가 `MAX_CREATED_TIMES` 보다 많다). */
  badInput: 'badInput',
  /** 다른 프로그램(예: CSV 를 연 Excel)이 파일을 공유 없이 잡고 있다. code 는 EBUSY. */
  locked: 'locked',
  io: 'io',
} as const;

export type ErrorKind = (typeof ERROR_KINDS)[keyof typeof ERROR_KINDS];

/** Rust 커맨드가 거부한 값이 이 `kind` 인가. */
export function hasErrorKind(e: unknown, kind: ErrorKind): boolean {
  return !!e && typeof e === 'object' && (e as { kind?: unknown }).kind === kind;
}
