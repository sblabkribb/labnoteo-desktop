/**
 * 실험 탭의 모델(순수): 실험 → 워크플로 → 유닛 오퍼레이션(UO) 세 단계, 상태 묶음, 세 단계를 다 보는 찾기.
 * - 실험 항목(experimentEntries.ts 의 PanelEntry)과 워크플로 노트의 본문(UO 제목)에서 만든다. UO 는 notePosition 이
 *   코어의 listUnitOpBlocks 로 읽고, Meta End_date 가 채워졌으면 완료다.
 * - 저장 값은 바꾸지 않는다: 상태(`in-progress`)는 그리기에서만 지역화한다(statusLabels.ts).
 * - 묶기는 상태별이면 진행 중 · 계획 · 완료 · 그 밖의 차례이고, 다른 기준(실험자, 프로젝트, 최근 수정, 논의)은 코어의
 *   buildExperimentTree 가 정한 묶음과 이름을 그대로 쓴다(꼬리의 ` [n]` 만 떼고 개수는 따로 그린다).
 */
import type { ExperimentEntry, ExperimentGrouping, ExperimentTreeLabels } from '@labnoteo/core';
import { buildExperimentTree as coreExperimentTree, EXPERIMENT_STATUSES } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { experimentTitleFromFolderName } from '@labnoteo/core/lib/labnoteStructure';
import { parseWorkflowFileName, parseWorkflowHeading } from '@labnoteo/core/lib/workflowStructure';
import { notePosition } from '../notePosition';
import { statusKind, statusLabel } from '../statusLabels';
import type { PanelEntry } from './experimentEntries';

export type UoNode = {
  kind: 'uo';
  id: string;
  /** 카탈로그 코드(`UHW250`). */
  code: string;
  /** 줄에 보일 이름: 별칭, 없으면 카탈로그 이름. */
  alias: string;
  /** 카탈로그 이름(영어 그대로). */
  name: string;
  /** 제목 줄(0부터). */
  line: number;
  done: boolean;
};

export type WfNode = {
  kind: 'workflow';
  id: string;
  path: string;
  code: string;
  /** 줄에 보일 이름: 별칭, 없으면 카탈로그 이름(본문을 아직 읽지 않았으면 파일 이름에서). */
  alias: string;
  /** 카탈로그 이름(찾기용). */
  name: string;
  /** README 체크리스트에서 체크했다. */
  ticked: boolean;
  uos: UoNode[];
};

export type ExpNode = {
  kind: 'experiment';
  id: string;
  dir: string;
  readme: string;
  /** 폴더 이름의 세 자리 번호. */
  num: string;
  title: string;
  /** README 의 status 그대로('' 은 없음). */
  status: string;
  project?: string;
  experimenter?: string;
  workflows: WfNode[];
  images?: number;
  resources?: number;
  /** 코어 묶기와 맥락 메뉴가 쓰는 원래 항목. */
  entry: ExperimentEntry;
};

/** 실험 줄의 이름: `003 · 대장균 숙주 비교`. */
export function experimentLabel(n: Pick<ExpNode, 'num' | 'title'>): string {
  return n.num && n.num !== n.title ? `${n.num} · ${n.title}` : n.title;
}

/** 워크플로의 UO 완료 수. */
export const uoDone = (wf: WfNode): number => wf.uos.filter((u) => u.done).length;

/** 워크플로 줄의 상태: 체크 = README 에서 체크, 반쪽 = UO 일부 완료, 점선 = 시작 전. */
export function workflowState(wf: WfNode): 'ticked' | 'partial' | 'none' {
  if (wf.ticked) return 'ticked';
  return uoDone(wf) > 0 ? 'partial' : 'none';
}

function workflowNode(path: string, fileName: string, ticked: boolean, text: string | undefined): WfNode {
  const parsed = parseWorkflowFileName(fileName);
  const fallback = parsed ? parsed.safeName.replace(/_/g, ' ') : fileName.replace(/\.labnote\.md$/i, '');
  const heading = text === undefined ? undefined : parseWorkflowHeading(text);
  const pos = text === undefined ? undefined : notePosition(path, text);
  const uos: UoNode[] =
    pos?.kind === 'workflow'
      ? pos.uos.map((u) => ({ kind: 'uo', id: `uo:${path}#${u.line}`, code: u.id, alias: u.alias || u.name, name: u.name, line: u.line, done: u.done }))
      : [];
  return {
    kind: 'workflow',
    id: `wf:${path}`,
    path,
    code: heading?.id ?? parsed?.id ?? '',
    alias: heading ? heading.alias || heading.name : fallback,
    name: heading?.name ?? '',
    ticked,
    uos,
  };
}

/**
 * 읽은 본문(`texts`: 워크플로 경로 -> 본문)으로 만든 실험 노드들. 본문이 없는 워크플로는 파일 이름만으로 그리고 UO 가 없다
 * (첫 그리기는 README 만 읽고, 본문은 뒤에서 채운다).
 */
export function experimentNodes(entries: readonly PanelEntry[], texts: ReadonlyMap<string, string> = new Map()): ExpNode[] {
  return entries.map((e) => {
    const name = posix.basename(e.folder);
    const authors = e.authors ?? [];
    return {
      kind: 'experiment',
      id: `exp:${e.folder}`,
      dir: e.folder,
      readme: e.readme,
      num: /^(\d{3})_/.exec(name)?.[1] ?? '',
      title: e.title?.trim() || experimentTitleFromFolderName(name),
      status: e.status?.trim() ?? '',
      ...(e.project?.trim() ? { project: e.project.trim() } : {}),
      ...(authors.length > 0 ? { experimenter: authors.join(', ') } : {}),
      workflows: e.workflowFiles.map((w) => workflowNode(w.path, w.fileName, w.ticked, texts.get(w.path))),
      ...(e.images !== undefined ? { images: e.images } : {}),
      ...(e.resources !== undefined ? { resources: e.resources } : {}),
      entry: e,
    };
  });
}

/** 실험 노드들: 워크플로 노트를 모두 `readText` 로 읽어 UO 를 채운다. 읽지 못한 노트는 UO 없이 둔다. */
export async function buildExperimentTree(entries: readonly PanelEntry[], readText: (p: string) => Promise<string>): Promise<ExpNode[]> {
  const texts = new Map<string, string>();
  await Promise.all(
    entries.flatMap((e) =>
      e.workflowFiles.map(async (w) => {
        try {
          texts.set(w.path, await readText(w.path));
        } catch {
          // 읽지 못한 노트: 파일 이름만으로 그린다
        }
      }),
    ),
  );
  return experimentNodes(entries, texts);
}

export type GroupBy = 'status' | 'experimenter' | 'project' | 'updated' | 'discuss';

export interface ExperimentGroup {
  key: string;
  label: string;
  items: ExpNode[];
}

/** 설정(workflowViewGroupBy, 플러그인 값)과 묶는 기준 사이. 플러그인의 'author' 가 실험자다. */
export const groupByFromSetting = (g: ExperimentGrouping | string | undefined): GroupBy =>
  g === 'author' ? 'experimenter' : g === 'project' || g === 'updated' || g === 'discuss' ? g : 'status';
export const settingFromGroupBy = (g: GroupBy): ExperimentGrouping => (g === 'experimenter' ? 'author' : g);

const byFolder = (a: ExpNode, b: ExpNode) => a.dir.localeCompare(b.dir, undefined, { numeric: true });

/** 상태 묶음의 차례: 진행 중 · 계획 · 완료, 그다음 플러그인의 다른 상태, 모르는 값(이름 차례), 상태 없음. */
function statusRank(status: string): number {
  const kind = status ? statusKind(status) : undefined;
  if (kind === 'inProgress') return 0;
  if (kind === 'planned') return 1;
  if (kind === 'done') return 2;
  const i = (EXPERIMENT_STATUSES as readonly string[]).indexOf(status);
  if (i >= 0) return 3 + i;
  return status ? 100 : 200;
}

/**
 * 실험 노드를 묶는다. 빈 묶음은 없다. 상태별은 위 차례(같은 뜻의 값 `done` / `completed` 는 한 묶음), 이름은 지역화한 상태
 * 이름(없으면 `noStatus`). 나머지는 코어 buildExperimentTree 의 묶음과 이름(`labels`).
 */
export function groupExperiments(nodes: readonly ExpNode[], by: GroupBy, labels: ExperimentTreeLabels & { noStatus?: string } = {}): ExperimentGroup[] {
  if (by === 'status') {
    const groups = new Map<string, ExpNode[]>();
    const keyOf = (s: string) => (statusKind(s) ? statusKind(s)! : s);
    for (const n of nodes) groups.set(keyOf(n.status), [...(groups.get(keyOf(n.status)) ?? []), n]);
    return [...groups.entries()]
      .map(([key, items]) => ({ key, items: [...items].sort(byFolder), status: items[0].status }))
      .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.key.localeCompare(b.key))
      .map(({ key, items, status }) => ({ key: `status:${key}`, label: status ? statusLabel(status) : (labels.noStatus ?? '(none)'), items }));
  }
  const byDir = new Map(nodes.map((n) => [n.entry.folder, n]));
  const root = coreExperimentTree(
    nodes.map((n) => n.entry),
    labels,
    settingFromGroupBy(by),
  );
  return (root.children ?? []).map((g) => ({
    key: g.id,
    label: g.label.replace(/\s*\[\d+\]$/, ''),
    items: (g.children ?? []).map((c) => byDir.get((c.payload as { folder: string }).folder)).filter((n): n is ExpNode => n !== undefined),
  }));
}

export type Range = [number, number];

/** `text` 안의 `q`(소문자로 접은 말) 자리들, 겹치지 않게. */
function rangesOf(text: string, q: string): Range[] {
  const out: Range[] = [];
  const hay = text.toLowerCase();
  for (let i = hay.indexOf(q); i >= 0 && q; i = hay.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}

export interface FilterResult {
  nodes: ExpNode[];
  /** 맞은 것의 조상: 펼친다. */
  expanded: Set<string>;
  /** 노드 id -> 줄 이름 안의 맞은 자리, `${id}:code` -> 코드 안의 자리. */
  marks: Map<string, Range[]>;
  /** 자기는 맞지 않고 아래가 맞아서 남은 실험·워크플로: 그 아래의 README, 폴더, 추가 줄은 감춘다. */
  partial: Set<string>;
}

/**
 * 세 단계를 다 보는 찾기. 실험은 이름(번호 · 제목), 프로젝트, 실험자, 상태(지역화한 이름과 저장 값), 워크플로는 별칭,
 * 카탈로그 이름, 코드, UO 는 별칭, 이름, 코드를 본다.
 * - 실험 자체가 맞으면 그 아래를 다 남긴다(아래에서도 맞은 것이 있으면 그 조상을 펼친다).
 * - 아니면 맞은 워크플로만 남긴다. 워크플로 자체가 맞으면 그 UO 를 다 남기고, UO 만 맞았으면 맞은 UO 만 남기고 펼친다.
 * - 맞은 것의 조상은 펼치고(expanded), 맞은 글자는 marks 에 둔다. 빈 말이면 모두 그대로, 아무것도 펼치지 않는다.
 */
export function filterTree(nodes: readonly ExpNode[], query: string, label: (status: string) => string = statusLabel): FilterResult {
  const q = query.trim().toLowerCase();
  const marks = new Map<string, Range[]>();
  const expanded = new Set<string>();
  const partial = new Set<string>();
  if (!q) return { nodes: [...nodes], expanded, marks, partial };
  const mark = (key: string, text: string): boolean => {
    const r = rangesOf(text, q);
    if (r.length > 0) marks.set(key, r);
    return r.length > 0;
  };
  const has = (text: string | undefined) => !!text && text.toLowerCase().includes(q);

  const out: ExpNode[] = [];
  for (const exp of nodes) {
    const shown = mark(exp.id, experimentLabel(exp));
    const self = shown || has(exp.project) || has(exp.experimenter) || (exp.status !== '' && (has(label(exp.status)) || has(exp.status)));
    const workflows: WfNode[] = [];
    for (const wf of exp.workflows) {
      const wfSelf = [mark(wf.id, wf.alias), mark(`${wf.id}:code`, wf.code), has(wf.name)].some(Boolean);
      const uos = wf.uos.filter((uo) => [mark(uo.id, uo.alias), mark(`${uo.id}:code`, uo.code), has(uo.name)].some(Boolean));
      if (uos.length > 0) expanded.add(wf.id);
      if (wfSelf || uos.length > 0) {
        expanded.add(exp.id);
        if (!wfSelf) partial.add(wf.id);
        workflows.push(wfSelf ? wf : { ...wf, uos });
      } else if (self) {
        workflows.push(wf);
      }
    }
    if (self) out.push({ ...exp, workflows: exp.workflows.map((wf) => workflows.find((w) => w.id === wf.id) ?? wf) });
    else if (workflows.length > 0) {
      partial.add(exp.id);
      out.push({ ...exp, workflows });
    }
  }
  return { nodes: out, expanded, marks, partial };
}
