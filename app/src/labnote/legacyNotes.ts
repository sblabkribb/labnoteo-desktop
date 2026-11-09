/**
 * 예전(VS Code 시절) 보관함의 실험 노트 이름 바꾸기 계획: `labnote/###_name/README.md` 와 `labnote/###_name/###_name.md` 를
 * `.labnote.md` 로. 코어(isValidWorkflowPath, 실험 README 찾기)는 `.labnote.md` 만 알아보므로 예전 노트는 실험으로 보이지 않는다.
 * - 후보는 실험 폴더(부모 폴더가 `###_`, 그 부모가 대소문자 무관 `labnote`, 깊이는 어디든: isValidWorkflowPath 와 같은 규칙)
 *   바로 안의 파일뿐이다. resources/, images/, 하위 폴더 안은 보지 않는다.
 * - 바꿀 이름이 이미 있으면(대소문자 무관, 앞선 후보가 차지한 이름 포함) 바꾸지 않고 충돌로 돌려준다.
 * 순수 함수다: 실제 이름 바꾸기는 legacyConvert.ts 가 링크를 고치는 이름 바꾸기 길로 한다.
 */

export interface LegacyRename {
  from: string;
  to: string;
}

export interface LegacyRenamePlan {
  renames: LegacyRename[];
  conflicts: LegacyRename[];
}

const EXPERIMENT_DIR = /^\d{3}_/;
const WORKFLOW_NOTE = /^\d{3}_.+\.md$/i;
const README_MD = /^readme\.md$/i;
const LABNOTE_MD = /\.labnote\.md$/i;

/** `.labnote.md` 로 바꿀 이름. 후보가 아니면 undefined. */
function targetName(name: string): string | undefined {
  if (LABNOTE_MD.test(name)) return undefined;
  if (README_MD.test(name)) return 'README.labnote.md';
  if (WORKFLOW_NOTE.test(name)) return `${name.slice(0, -'.md'.length)}.labnote.md`;
  return undefined;
}

/** 실험 폴더 바로 안의 예전 노트를 `.labnote.md` 로 바꿀 계획. 결과는 원래 경로 순서다. */
export function planLegacyLabnoteRenames(paths: readonly string[]): LegacyRenamePlan {
  const normalized = paths.map((p) => p.replace(/\\/g, '/'));
  const taken = new Set(normalized.map((p) => p.toLowerCase()));
  const candidates: LegacyRename[] = [];
  for (const from of normalized) {
    const parts = from.split('/');
    if (parts.length < 3) continue;
    const name = parts[parts.length - 1];
    const experiment = parts[parts.length - 2];
    const labnote = parts[parts.length - 3];
    if (labnote.toLowerCase() !== 'labnote' || !EXPERIMENT_DIR.test(experiment)) continue;
    const to = targetName(name);
    if (to === undefined) continue;
    candidates.push({ from, to: [...parts.slice(0, -1), to].join('/') });
  }
  candidates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const plan: LegacyRenamePlan = { renames: [], conflicts: [] };
  for (const c of candidates) {
    const key = c.to.toLowerCase();
    if (taken.has(key)) plan.conflicts.push(c);
    else {
      taken.add(key);
      plan.renames.push(c);
    }
  }
  return plan;
}
