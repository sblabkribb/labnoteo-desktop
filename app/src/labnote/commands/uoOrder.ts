/**
 * Workflow 노트 안의 Unit Operation 위로·아래로(실험 탭의 UO 줄 메뉴와 Alt+Shift+↑/↓).
 * - 구역 하나 = `### [CODE 이름] 별칭` 제목부터 다음 UO 제목, 또는 다음 `#`/`##` 제목 앞까지(코드 울타리 안은 보지 않는다).
 *   개요 패널에서 제목을 끌어 옮기는 것과 같은 단위다.
 * - 이웃한 두 구역의 본문을 맞바꾸고(구역 끝의 빈 줄은 제자리에 둔다), 코어 computeUnitOpSyncEdits 로 `## Related Unit Operations`
 *   목차와 `---` 구분선을 맞춘다. 한 번의 processNote: 열린 노트면 되돌리기 한 번이다.
 * - UO 에는 번호가 없어 이름 바꾸기도 링크 고침도 없다. 다만 제목이 같은 두 UO 를 맞바꾸면 `#x`, `#x-1` 앵커가 서로 바뀌어
 *   그 제목으로 가는 링크가 엇갈린다: 그때는 옮기지 않고 알린다.
 */
import { applyTextEdits, computeUnitOpSyncEdits } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { NoteBusyError } from '../noteErrors';
import { processNote } from '../openNotes';
import type { CommandContext } from './context';
import { readmeStamp } from './stamp';

/** UO 구역 하나(`text.split('\n')` 의 줄, `end` 는 들지 않는다). `body` 는 끝의 빈 줄을 뺀 끝. */
export interface UoBlock {
  start: number;
  body: number;
  end: number;
  heading: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** 코어 workflowSectionParser 의 UNIT_OP_HEADING_PATTERN(패키지가 내보내지 않는다). */
const UNIT_OP_HEADING = /^###\s+\[([A-Z]+\d+)\s+(.+?)\]\s*(.*)/;
/** 코어 githubHeadingAnchor 와 같은 앵커(패키지가 내보내지 않는다): 같은 제목인지 보는 데만 쓴다. */
const anchorOf = (text: string) =>
  text
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');

/** 노트의 UO 구역들, 문서 차례. */
export function unitOpBlocks(md: string): UoBlock[] {
  const lines = md.split('\n');
  const text = (i: number) => lines[i].replace(/\r$/, '');
  const kinds: Array<'uo' | 'stop' | undefined> = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(text(i));
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined;
      kinds.push(undefined);
      continue;
    }
    if (m) {
      fence = m[1];
      kinds.push(undefined);
      continue;
    }
    kinds.push(UNIT_OP_HEADING.test(text(i)) ? 'uo' : /^#{1,2}\s/.test(text(i)) ? 'stop' : undefined);
  }
  const out: UoBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] !== 'uo') continue;
    let end = i + 1;
    while (end < lines.length && kinds[end] === undefined) end++;
    let body = end;
    while (body > i + 1 && text(body - 1).trim() === '') body--;
    out.push({ start: i, body, end, heading: text(i).replace(/^###\s+/, '').trim() });
  }
  return out;
}

export type UoSwap = { ok: true; text: string; line: number } | { ok: false; reason: 'none' | 'duplicate'; heading?: string };

/** 제목 줄 `line`(0부터)의 UO 를 한 칸 위나 아래로 옮긴 글과 옮긴 뒤의 제목 줄. */
export function swapUnitOp(md: string, line: number, dir: 'up' | 'down'): UoSwap {
  const blocks = unitOpBlocks(md);
  const k = blocks.findIndex((b) => b.start === line);
  const j = dir === 'up' ? k - 1 : k + 1;
  if (k < 0 || j < 0 || j >= blocks.length) return { ok: false, reason: 'none' };
  const [first, second] = k < j ? [blocks[k], blocks[j]] : [blocks[j], blocks[k]];
  // 두 구역 사이에 다른 것이 있으면(이웃이 아니다) 옮기지 않는다
  if (first.end !== second.start) return { ok: false, reason: 'none' };
  if (anchorOf(first.heading) === anchorOf(second.heading)) return { ok: false, reason: 'duplicate', heading: first.heading };
  const lines = md.split('\n');
  const a = lines.slice(first.start, first.body);
  const gapA = lines.slice(first.body, first.end);
  const b = lines.slice(second.start, second.body);
  const gapB = lines.slice(second.body, second.end);
  // 마지막 줄의 \r 은 자리를 따른다: 줄 바꿈 꼴이 섞이지 않게 맞춘다
  const crlf = lines[first.start].endsWith('\r');
  const fix = (l: string[]) => (crlf ? l.map((x) => (x.endsWith('\r') ? x : `${x}\r`)) : l);
  const swapped = [...fix(b), ...gapA, ...fix(a), ...gapB];
  // 글의 마지막 줄에는 \r 이 없다
  if (crlf && second.end === lines.length && !lines[lines.length - 1].endsWith('\r')) {
    swapped[swapped.length - 1] = swapped[swapped.length - 1].replace(/\r$/, '');
  }
  const next = [...lines.slice(0, first.start), ...swapped, ...lines.slice(second.end)].join('\n');
  const moved = dir === 'up' ? first.start : first.start + b.length + gapA.length;
  const synced = applyTextEdits(next, computeUnitOpSyncEdits(next));
  // 목차가 바뀌면 줄 번호가 밀릴 수 있다: 옮긴 제목을 다시 찾는다
  const heading = lines[line].replace(/\r$/, '');
  const after = unitOpBlocks(synced).map((x) => x.start);
  const near = after.filter((s) => synced.split('\n')[s].replace(/\r$/, '') === heading);
  const at = near.length > 0 ? near.reduce((p, c) => (Math.abs(c - moved) < Math.abs(p - moved) ? c : p)) : moved;
  return { ok: true, text: synced, line: at };
}

/** 그 Workflow 노트의 UO(제목 줄 `line`)를 한 칸 옮긴다. 옮긴 뒤의 제목 줄, 안 했으면 undefined. */
export async function moveUnitOp(ctx: CommandContext, path: string, line: number, dir: 'up' | 'down'): Promise<number | undefined> {
  const { host } = ctx;
  const stamp = readmeStamp(ctx.settings);
  let result: UoSwap | undefined;
  try {
    await processNote(host.fs, path, (text) => {
      result = swapUnitOp(text, line, dir);
      if (!result.ok) return text;
      const stamped = stamp(result.text, path);
      // 날짜 찍기는 머리말만 바꾼다: 줄 수가 바뀌면 그만큼 민다
      result = { ...result, line: result.line + stamped.split('\n').length - result.text.split('\n').length };
      return stamped;
    });
  } catch (e) {
    if (!(e instanceof NoteBusyError)) throw e;
    host.notify('warn', t('uoOrder.busy'));
    return undefined;
  }
  if (!result) return undefined;
  if (!result.ok) {
    if (result.reason === 'duplicate') host.notify('warn', t('uoOrder.duplicate', result.heading ?? ''));
    return undefined;
  }
  return result.line;
}
