import { normalizeVaultPath } from '../fs/tauriLabnoteFs';

/**
 * 보관함 루트. 코어 로더(`loadWorkflows`, `ensureWorkflowResources` 등)는 falsy 루트에
 * 아무것도 돌려주지 않으므로 늘 `'.'` 를 넘긴다. `TauriLabnoteFs` 가 Rust 로 보낼 때 `''` 로 바꾼다.
 */
export const VAULT_ROOT = '.';

/** 실험 폴더의 README 파일 이름. */
export const README = 'README.labnote.md';

/** 보관함 경로를 비교할 키: 정규화한 경로의 소문자(NTFS 는 대소문자를 가리지 않는다). 보관함을 벗어나는 경로는 그대로 소문자로. */
export function pathKey(path: string): string {
  let p = path;
  try {
    p = normalizeVaultPath(path);
  } catch {
    // 보관함을 벗어나는 경로: 그대로 두면 보관함 안의 어떤 경로와도 맞지 않는다.
  }
  return p.toLowerCase();
}

/** 두 보관함 경로가 같은 파일을 가리키는가(대소문자 무관). */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && pathKey(a) === pathKey(b);
}
