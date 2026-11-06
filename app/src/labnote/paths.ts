/**
 * 보관함 루트. 코어 로더(`loadWorkflows`, `ensureWorkflowResources` 등)는 falsy 루트에
 * 아무것도 돌려주지 않으므로 늘 `'.'` 를 넘긴다. `TauriLabnoteFs` 가 Rust 로 보낼 때 `''` 로 바꾼다.
 */
export const VAULT_ROOT = '.';

/** 실험 폴더의 README 파일 이름. */
export const README = 'README.labnote.md';
