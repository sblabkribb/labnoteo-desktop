/**
 * README "Related Workflows" 체크리스트에서 Workflow 노트 하나의 [ ] / [x] 를 찾고 바꾼다(Workflow 완료: 실험 탭의 체크박스,
 * 보기 머리의 칩, 팔레트 명령, 권유).
 * - 구역은 코어의 workflowChecklistSectionRange, 줄은 코어의 workflowChecklistEntryLink(`.labnote.md` 링크, 위키링크)로 읽는다.
 * - 예전(VS Code 시절) 보관함의 줄도 읽는다: `.md` 로 끝나는 링크(`[x] [WD090 …](./001_WD090_….md)`), `.labnote` 없는 위키링크.
 *   코어의 체크리스트 정규식은 `.labnote.md` 링크만 알아본다(플러그인 동작 그대로라 vendor 는 고치지 않는다).
 * - 맞추기: 먼저 파일 이름이 같은 줄(대소문자 무시), 없으면 확장자(`.labnote.md` / `.md`)를 뗀 이름이 같은 줄
 *   (이름만 바꾼 노트와 예전 링크가 서로를 찾는다).
 * - 바꾸기는 상자 글자만 바꾼다: 앞의 "- " 없는 줄, `*`, 들여쓰기, CRLF(`\r`)가 그대로 남는다.
 */
import * as posix from '@labnoteo/core/posix';
import { decodeChecklistLink, workflowChecklistEntryLink, workflowChecklistSectionRange } from '@labnoteo/core/lib/workflowStructure';

/** 예전 꼴의 마크다운 링크 줄: 상자, 이름, `.md` 로 끝나는 링크. */
const LEGACY_LINK_ENTRY = /^\s*(?:[-*+]\s+)?\[[ xX]\]\s*\[.+?\]\((?:\.\/)?(.+?\.md)\)/;
/** 예전 꼴의 위키링크 줄: `[[001_X]]`, `[[001_X|이름]]`. */
const LEGACY_WIKI_ENTRY = /^\s*(?:[-*+]\s+)?\[[ xX]\]\s*\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/;
/** 줄의 체크 상자(첫 번째). */
const BOX = /\[( |x|X)\]/;

const stem = (name: string) => name.toLowerCase().replace(/(\.labnote)?\.md$/, '');

/** 체크리스트 줄의 링크(파일 이름까지의 경로, 이스케이프를 푼 것). 체크리스트 줄이 아니면 undefined. */
export function checklistLineLink(line: string): string | undefined {
  const plain = line.replace(/\r$/, '');
  const core = workflowChecklistEntryLink(plain);
  if (core !== undefined) return core;
  const md = LEGACY_LINK_ENTRY.exec(plain);
  if (md) return decodeChecklistLink(md[1]);
  const wiki = LEGACY_WIKI_ENTRY.exec(plain);
  if (wiki) {
    const target = wiki[1].trim();
    return /\.md$/i.test(target) ? target : `${target}.md`;
  }
  return undefined;
}

/** 그 Workflow 노트(`fileName`)의 체크리스트 줄 번호(`text.split('\n')` 의 자리). 없으면 undefined. */
export function checklistLineOf(text: string, fileName: string): number | undefined {
  const range = workflowChecklistSectionRange(text);
  if (!range) return undefined;
  const lines = text.split('\n');
  const want = posix.basename(fileName).toLowerCase();
  const wantStem = stem(want);
  let byStem: number | undefined;
  for (let i = range.header + 1; i < range.end; i++) {
    const link = checklistLineLink(lines[i]);
    if (link === undefined || !BOX.test(lines[i])) continue;
    const name = posix.basename(link).toLowerCase();
    if (name === want) return i;
    if (byStem === undefined && stem(name) === wantStem) byStem = i;
  }
  return byStem;
}

/** README 글에서 그 Workflow 노트의 체크 상태. 체크리스트에 그 줄이 없으면 undefined. */
export function checklistTickOf(text: string, fileName: string): boolean | undefined {
  const at = checklistLineOf(text, fileName);
  if (at === undefined) return undefined;
  return BOX.exec(text.split('\n')[at])![1] !== ' ';
}

/** 그 Workflow 노트의 줄의 상자를 뒤집은 글과 뒤집은 뒤의 상태. 줄이 없으면 undefined. */
export function toggleChecklistTick(text: string, fileName: string): { text: string; ticked: boolean } | undefined {
  const at = checklistLineOf(text, fileName);
  if (at === undefined) return undefined;
  const lines = text.split('\n');
  const box = BOX.exec(lines[at])!;
  const ticked = box[1] === ' ';
  lines[at] = lines[at].slice(0, box.index) + (ticked ? '[x]' : '[ ]') + lines[at].slice(box.index + box[0].length);
  return { text: lines.join('\n'), ticked };
}

/** 체크리스트의 모든 줄(예전 꼴 포함): 상태와 링크. 셈(워크플로 n/m, 상태 권유)과 실험 탭의 체크가 쓴다. */
export function checklistEntries(text: string): Array<{ done: boolean; link: string }> {
  const range = workflowChecklistSectionRange(text);
  if (!range) return [];
  const lines = text.split('\n');
  const out: Array<{ done: boolean; link: string }> = [];
  for (let i = range.header + 1; i < range.end; i++) {
    const link = checklistLineLink(lines[i]);
    const box = link === undefined ? null : BOX.exec(lines[i]);
    if (link !== undefined && box) out.push({ done: box[1] !== ' ', link });
  }
  return out;
}
