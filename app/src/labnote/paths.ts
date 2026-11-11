import type { LabnoteFs } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { normalizeVaultPath } from '../fs/tauriLabnoteFs';

/**
 * 보관함 루트. 코어 로더(`loadWorkflows`, `ensureWorkflowResources` 등)는 falsy 루트에
 * 아무것도 돌려주지 않으므로 늘 `'.'` 를 넘긴다. `TauriLabnoteFs` 가 Rust 로 보낼 때 `''` 로 바꾼다.
 */
export const VAULT_ROOT = '.';

/** 실험 폴더의 README 파일 이름(새 이름: 앱과 플러그인이 만드는 것). */
export const README = 'README.labnote.md';

/** 예전(VS Code 시절) 실험 폴더의 README 이름. 사용자의 보관함에는 아직 이 이름이 있다. */
export const LEGACY_README = 'README.md';

/** 실험 README 로 보는 이름들, 고르는 차례(README.labnote.md 먼저). 앱의 맥락 사슬(context/chain.ts)과 같은 차례다. */
const README_NAMES = [README, LEGACY_README].map((n) => n.toLowerCase());

/** 그 파일 이름이 실험 README 의 이름(새 이름이든 예전 이름이든, 대소문자 무관)인가. */
export function isReadmeName(name: string): boolean {
  return README_NAMES.includes(name.toLowerCase());
}

/** 폴더 목록에서 실험 README 의 이름(디스크 철자): README.labnote.md, 없으면 README.md. 둘 다 없으면 undefined. */
export function readmeNameIn(names: readonly string[]): string | undefined {
  for (const want of README_NAMES) {
    const found = names.find((n) => n.toLowerCase() === want);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 실험 폴더의 README 경로: README.labnote.md 가 있으면 그것, 없고 README.md 가 있으면 그것(예전 보관함).
 * 둘 다 없으면 README.labnote.md 경로(새로 만들 이름, "README 가 없다" 알림이 그 이름을 말한다).
 */
export async function resolveReadmePath(fs: Pick<LabnoteFs, 'exists'>, dir: string): Promise<string> {
  const current = posix.join(dir, README);
  if (await fs.exists(current)) return current;
  const legacy = posix.join(dir, LEGACY_README);
  return (await fs.exists(legacy)) ? legacy : current;
}

/** 예전 Workflow 노트: 실험 폴더 바로 안의 `NNN_Wxxx_이름.md`(`.labnote.md` 가 아니다). */
const LEGACY_WORKFLOW_NOTE = /^\d{3}_[A-Z]{2}\d{3}_.+\.md$/;

/**
 * Workflow 노트인가: 코어의 isValidWorkflowPath(`.labnote.md`), 또는 예전 이름(`NNN_Wxxx_*.md`, 실험 폴더 바로 안).
 * Workflow 완료(보기 머리의 칩, 팔레트 명령, 권유, 실험 탭의 줄)와 노트 위치가 쓴다.
 */
export function isWorkflowNote(path: string): boolean {
  if (isValidWorkflowPath(path)) return true;
  const normalized = path.replace(/\\/g, '/');
  const name = posix.basename(normalized);
  if (/\.labnote\.md$/i.test(name) || !LEGACY_WORKFLOW_NOTE.test(name)) return false;
  const dir = posix.dirname(normalized);
  return dir !== '.' && getExperimentDir(dir) === posix.normalize(dir);
}

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
