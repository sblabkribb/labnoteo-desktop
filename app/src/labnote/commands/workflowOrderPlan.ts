/**
 * Workflow 순서 바꾸기(위로·아래로, 여기 뒤에 추가, 지우고 번호 당기기)의 순수 계획.
 * - Workflow 노트 이름은 `NNN_ID_나머지.labnote.md` 또는 예전 `NNN_ID_나머지.md` 다. 확장자는 적힌 그대로 남는다.
 * - README "Related Workflows" 체크리스트는 checklistTick.ts 의 줄 모델로 읽는다: 앞의 "- " 없는 줄, `.md` 링크, 위키링크, CRLF.
 * - 폴더와 체크리스트가 서로 맞을 때만(모든 노트가 한 번씩, 체크리스트 차례 = 번호 차례) 계획한다. 아니면 까닭을 돌려준다:
 *   무엇이 맞는 차례인지 짐작하지 않는다.
 * - 번호는 자리의 번호를 그대로 쓴다: 옮긴 범위 밖의 번호와 빈 번호는 바뀌지 않는다.
 * - README 쓰기는 줄 단위다: 줄을 지우거나 겹치지 않고, 상자·앞붙이·꼬리·`\r` 를 그대로 둔다. 링크 대상은 링크 고침(rewrite.ts)이 바꾼다.
 */
import * as posix from '@labnoteo/core/posix';
import { escapeChecklistLabel, workflowChecklistSectionRange } from '@labnoteo/core/lib/workflowStructure';
import { checklistLineLink } from '../checklistTick';
import { isReadmeName } from '../paths';

/** 번호가 붙은 Workflow 노트 이름의 조각. */
export interface WfName {
  name: string;
  seq: number;
  id: string;
  rest: string;
  ext: string;
}

/** 이름이 바뀌는 노트 하나(같은 폴더 안의 파일 이름). */
export interface NameMove {
  from: string;
  to: string;
}

const HEAD = /^(\d{3})_([A-Z]{2}\d{3})_(.+)$/;
const STAGING = /_staging\d+$/;

/** `NNN_ID_나머지(.labnote).md` 를 읽는다. README 와 다른 이름이면 undefined. */
export function parseWfName(name: string): WfName | undefined {
  if (isReadmeName(name)) return undefined;
  const ext = /\.labnote\.md$/i.test(name) ? name.slice(-'.labnote.md'.length) : /\.md$/i.test(name) ? name.slice(-3) : undefined;
  if (ext === undefined) return undefined;
  const m = HEAD.exec(name.slice(0, name.length - ext.length));
  if (!m) return undefined;
  return { name, seq: Number(m[1]), id: m[2], rest: m[3], ext };
}

export const pad3 = (n: number): string => String(n).padStart(3, '0');

/** 그 노트의 번호만 바꾼 이름. */
export function withSeq(w: WfName, seq: number): string {
  return `${pad3(seq)}_${w.id}_${w.rest}${w.ext}`;
}

/** 체크리스트 줄 하나: 줄 번호, 그 줄에 딸린 더 깊이 들여 쓴 줄까지의 끝(들지 않는다), 링크의 파일 이름. */
export interface ChecklistLine {
  line: number;
  end: number;
  link: string;
  name: string;
}

const BOX = /\[( |x|X)\]/;
const indentOf = (line: string): number => {
  const m = /^[ \t]*/.exec(line)![0];
  return [...m].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
};

/** README 체크리스트의 줄들(구역이 없으면 undefined). `text.split('\n')` 의 자리다. */
export function checklistLines(text: string): ChecklistLine[] | undefined {
  const range = workflowChecklistSectionRange(text);
  if (!range) return undefined;
  const lines = text.split('\n');
  const isEntry = (i: number) => checklistLineLink(lines[i]) !== undefined && BOX.test(lines[i]);
  const out: ChecklistLine[] = [];
  for (let i = range.header + 1; i < range.end; i++) {
    if (!isEntry(i)) continue;
    const link = checklistLineLink(lines[i])!;
    const depth = indentOf(lines[i]);
    let end = i + 1;
    while (end < range.end && lines[end].replace(/\r$/, '').trim() !== '' && indentOf(lines[end]) > depth && !isEntry(end)) end++;
    out.push({ line: i, end, link, name: posix.basename(link) });
  }
  return out;
}

export type RefusalReason = 'noReadme' | 'noSection' | 'unlisted' | 'missing' | 'duplicate' | 'sameNumber' | 'staging' | 'order' | 'outside';

export interface Refusal {
  reason: RefusalReason;
  names: string[];
}

/** 맞는 폴더의 Workflow 노트, 번호 차례(= 체크리스트 차례). */
export interface OrderItem extends WfName {
  /** 체크리스트 줄. */
  entry: ChecklistLine;
}

export type OrderState = { ok: true; items: OrderItem[] } | { ok: false; refusal: Refusal };

const stemKey = (name: string) => name.toLowerCase().replace(/(\.labnote)?\.md$/, '');

/**
 * 폴더(`names` = fs.list)와 README 글이 서로 맞는지 보고, 맞으면 Workflow 노트를 번호 차례로 돌려준다.
 * 체크리스트 줄은 파일 이름(대소문자 무시), 없으면 확장자를 뗀 이름으로 노트를 찾는다(checklistLineOf 와 같다).
 */
export function readOrder(names: readonly string[], readme: string | undefined): OrderState {
  const refuse = (reason: RefusalReason, list: string[] = []): OrderState => ({ ok: false, refusal: { reason, names: list } });
  if (readme === undefined) return refuse('noReadme');
  const entries = checklistLines(readme);
  if (!entries) return refuse('noSection');
  const files = names.map(parseWfName).filter((w): w is WfName => w !== undefined);
  const staging = files.filter((w) => STAGING.test(w.rest)).map((w) => w.name);
  if (staging.length > 0) return refuse('staging', staging);
  const bySeq = new Map<number, string[]>();
  for (const w of files) bySeq.set(w.seq, [...(bySeq.get(w.seq) ?? []), w.name]);
  const clashes = [...bySeq.values()].filter((l) => l.length > 1).flat();
  if (clashes.length > 0) return refuse('sameNumber', clashes);

  const outside = entries.filter((e) => !['', '.'].includes(posix.dirname(e.link.replace(/^\.\//, ''))));
  if (outside.length > 0) return refuse('outside', outside.map((e) => e.link));

  const byName = new Map(files.map((w) => [w.name.toLowerCase(), w]));
  const byStem = new Map(files.map((w) => [stemKey(w.name), w]));
  const used = new Map<string, OrderItem>();
  const missing: string[] = [];
  const duplicate: string[] = [];
  const listed: OrderItem[] = [];
  for (const e of entries) {
    const w = byName.get(e.name.toLowerCase()) ?? byStem.get(stemKey(e.name));
    if (!w) {
      missing.push(e.name);
      continue;
    }
    if (used.has(w.name)) {
      duplicate.push(w.name);
      continue;
    }
    const item = { ...w, entry: e };
    used.set(w.name, item);
    listed.push(item);
  }
  if (missing.length > 0) return refuse('missing', missing);
  if (duplicate.length > 0) return refuse('duplicate', duplicate);
  const unlisted = files.filter((w) => !used.has(w.name)).map((w) => w.name);
  if (unlisted.length > 0) return refuse('unlisted', unlisted);
  for (let i = 1; i < listed.length; i++) if (listed[i].seq <= listed[i - 1].seq) return refuse('order');
  return { ok: true, items: listed };
}

/** `items[from]` 을 `to` 자리로 옮길 때의 이름 바꾸기: 그 범위의 노트가 그 자리의 번호를 받는다. */
export function planMove(items: readonly WfName[], from: number, to: number): NameMove[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [];
  const order = [...items];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const out: NameMove[] = [];
  for (let k = Math.min(from, to); k <= Math.max(from, to); k++) {
    const target = withSeq(order[k], items[k].seq);
    if (target !== order[k].name) out.push({ from: order[k].name, to: target });
  }
  return out;
}

/**
 * `items[after]` 바로 뒤에 넣을 새 Workflow 의 번호와, 그 번호를 비우려고 뒤 노트를 하나씩 미는 이름 바꾸기.
 * 첫 빈 번호에서 멈춘다(003, 005 가 있고 002 뒤에 넣으면 003 만 004 로). `after` 가 -1 이면 맨 앞이다.
 */
export function planInsert(items: readonly WfName[], after: number): { seq: number; moves: NameMove[] } {
  const seq = after < 0 ? 1 : items[after].seq + 1;
  const moves: NameMove[] = [];
  let want = seq;
  for (let k = after + 1; k < items.length && items[k].seq === want; k++) {
    moves.push({ from: items[k].name, to: withSeq(items[k], want + 1) });
    want++;
  }
  return { seq, moves };
}

/** 지운 노트(`deleted`) 뒤의 노트 번호를 하나씩 당기는 이름 바꾸기(남은 `items` 는 번호 차례). */
export function planCloseGap(items: readonly WfName[], deletedSeq: number): NameMove[] {
  return items.filter((w) => w.seq > deletedSeq).map((w) => ({ from: w.name, to: withSeq(w, w.seq - 1) }));
}

/** 이름 바꾸기의 대상 이름을 옮기지 않는 다른 파일이 쓰고 있다. */
export class TargetTakenError extends Error {
  constructor(readonly names: string[]) {
    super(`target names are taken: ${names.join(', ')}`);
    this.name = 'TargetTakenError';
  }
}

/**
 * 이름 바꾸기를 디스크에서 부딪히지 않는 차례의 걸음으로. 대상이 비었으면(대소문자 무시, 노트가 아닌 파일도 본다) 곧바로,
 * 아니면 `NNN_ID_나머지_stagingK.확장자` 에 잠시 두었다가 나중에 옮긴다(맞바꾸기 = 셋).
 */
export function physicalSteps(moves: readonly NameMove[], existing: readonly string[]): NameMove[] {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const pending = moves.filter((m) => m.from !== m.to).map((m) => ({ ...m }));
  const steps: NameMove[] = [];
  const go = (from: string, to: string) => {
    steps.push({ from, to });
    taken.delete(from.toLowerCase());
    taken.add(to.toLowerCase());
  };
  let staged = 0;
  while (pending.length > 0) {
    const free = pending.findIndex((m) => !taken.has(m.to.toLowerCase()) || m.to.toLowerCase() === m.from.toLowerCase());
    if (free >= 0) {
      const [m] = pending.splice(free, 1);
      go(m.from, m.to);
      continue;
    }
    // 대상이 옮겨 가지 않는 다른 파일이면 비지 않는다: 아무것도 하지 않고 알린다
    const sources = new Set(pending.map((p) => p.from.toLowerCase()));
    const blocked = pending.filter((p) => !sources.has(p.to.toLowerCase()));
    if (blocked.length > 0) throw new TargetTakenError(blocked.map((p) => p.to));
    // 고리: 첫 노트를 임시 이름에 둔다
    const m = pending[0];
    const w = parseWfName(m.from)!;
    let temp: string;
    do {
      staged++;
      temp = `${pad3(w.seq)}_${w.id}_${w.rest}_staging${staged}${w.ext}`;
    } while (taken.has(temp.toLowerCase()));
    go(m.from, temp);
    m.from = temp;
  }
  return steps;
}

/** 새 차례(`order`, 옛 이름들)로 체크리스트 줄 묶음을 그 자리들에 다시 놓는다. 사이의 다른 줄은 제자리에 남는다. */
export function reorderChecklist(text: string, order: readonly string[]): string {
  const entries = checklistLines(text);
  if (!entries || entries.length === 0) return text;
  const lines = text.split('\n');
  const key = (n: string) => stemKey(n);
  const blocks = new Map(entries.map((e) => [key(e.name), lines.slice(e.line, e.end)]));
  const wanted = order.map(key).filter((k) => blocks.has(k));
  const inOrder = entries.filter((e) => wanted.includes(key(e.name)));
  if (inOrder.length !== wanted.length) throw new Error('checklist entries do not match the new order');
  const out: string[] = [];
  let at = 0;
  let slot = 0;
  for (const e of entries) {
    out.push(...lines.slice(at, e.line));
    if (wanted.includes(key(e.name))) out.push(...blocks.get(wanted[slot++])!);
    else out.push(...lines.slice(e.line, e.end));
    at = e.end;
  }
  out.push(...lines.slice(at));
  return out.join('\n');
}

/** 이름표가 옛 번호로 시작하는 줄(`[001 WD090 …]`)의 번호를 새 번호로. 번호 없는 이름표는 그대로다. */
export function relabelChecklist(text: string, moves: readonly NameMove[]): string {
  const entries = checklistLines(text);
  if (!entries) return text;
  const byOld = new Map(moves.map((m) => [stemKey(m.from), m]));
  const lines = text.split('\n');
  for (const e of entries) {
    const m = byOld.get(stemKey(e.name));
    if (!m) continue;
    const from = parseWfName(m.from);
    const to = parseWfName(m.to);
    if (!from || !to) continue;
    lines[e.line] = lines[e.line].replace(/^(\s*(?:[-*+]\s+)?\[[ xX]\]\s*\[)(\d{3})(?=[ _])/, (all, head: string, num: string) =>
      Number(num) === from.seq ? head + pad3(to.seq) : all,
    );
  }
  return lines.join('\n');
}

/** 그 노트(`name`)의 체크리스트 줄 하나만 뺀다(딸린 줄은 남긴다, 플러그인과 같다). 없으면 글 그대로. */
export function removeChecklistLine(text: string, name: string): string {
  const entries = checklistLines(text);
  const e = entries?.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? entries?.find((x) => stemKey(x.name) === stemKey(name));
  if (!e) return text;
  const lines = text.split('\n');
  lines.splice(e.line, 1);
  return lines.join('\n');
}

/**
 * `afterName` 의 체크리스트 묶음 바로 뒤에 새 줄을 넣는다. 앞붙이(들여쓰기, "- ")와 `\r` 는 그 줄을 따르고,
 * 그 줄의 이름표가 번호로 시작하면 새 이름표에도 번호를 붙인다. `afterName` 이 없으면(맨 앞) 첫 줄 앞, 줄이 없으면 구역 머리 뒤.
 */
export function insertChecklistLine(text: string, afterName: string | undefined, entry: { fileName: string; title: string; seq: number }): string {
  const range = workflowChecklistSectionRange(text);
  const entries = checklistLines(text);
  if (!range || !entries) return text;
  const lines = text.split('\n');
  const anchor = afterName === undefined ? entries[0] : entries.find((e) => stemKey(e.name) === stemKey(afterName));
  const model = anchor ? lines[anchor.line] : undefined;
  const prefix = model ? /^(\s*(?:[-*+]\s+)?)/.exec(model)![1] : '- ';
  const eol = model?.endsWith('\r') ? '\r' : lines[range.header].endsWith('\r') ? '\r' : '';
  const numbered = model ? /^\s*(?:[-*+]\s+)?\[[ xX]\]\s*\[\d{3}[ _]/.test(model) : false;
  const label = escapeChecklistLabel(numbered ? `${pad3(entry.seq)} ${entry.title}` : entry.title);
  const line = `${prefix}[ ] [${label}](./${entry.fileName.replace(/ /g, '%20')})${eol}`;
  const at = anchor === undefined ? range.header + 1 : afterName === undefined ? anchor.line : anchor.end;
  lines.splice(at, 0, line);
  return lines.join('\n');
}

/** 앱의 다음 Workflow 번호: 예전 이름(`NNN_ID_*.md`)도 센다(코어 getNextWorkflowNumber 는 `.labnote.md` 만 센다). */
export function nextWorkflowSeq(names: readonly string[]): number {
  const seqs = names.map(parseWfName).filter((w): w is WfName => w !== undefined).map((w) => w.seq);
  const loose = names.filter((n) => /^\d{3}_.*\.labnote\.md$/i.test(n) && !isReadmeName(n)).map((n) => Number(n.slice(0, 3)));
  return Math.max(0, ...seqs, ...loose) + 1;
}

/**
 * 새 Workflow 줄을 예전 체크리스트에 넣는다(보통의 "+ Workflow 추가"). 코어 insertWorkflowChecklistEntries 는 `.labnote.md` 줄만
 * 줄로 보아, 예전 줄(`NNN_ID_*.md`, 앞의 "- " 없는 줄)뿐인 README 에서는 새 줄을 구역 맨 위에 넣는다. 코어가 보는 줄이 하나라도
 * 있으면 undefined(코어가 넣는다). 아니면 번호가 새 번호 이하인 마지막 줄 뒤에(없으면 첫 줄 앞에, 번호 있는 줄이 없으면 끝에),
 * 그 줄의 앞붙이·`\r`·번호 이름표를 따라 넣는다. 구역이나 줄이 없으면 undefined.
 */
export function insertLegacyChecklistLine(text: string, entry: { fileName: string; title: string }): string | undefined {
  const entries = checklistLines(text);
  if (!entries || entries.length === 0) return undefined;
  if (entries.some((e) => /\.labnote(\.md)*$/i.test(e.link))) return undefined;
  const seq = parseWfName(entry.fileName)?.seq;
  if (seq === undefined) return undefined;
  const numbered = entries.map((e) => ({ e, w: parseWfName(e.name) })).filter((x) => x.w !== undefined);
  const below = numbered.filter((x) => x.w!.seq <= seq);
  const anchor = numbered.length === 0 ? entries[entries.length - 1].name : below.length > 0 ? below[below.length - 1].e.name : undefined;
  return insertChecklistLine(text, anchor, { ...entry, seq });
}
