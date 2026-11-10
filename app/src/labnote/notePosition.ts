/**
 * 열린 노트가 실험 → 워크플로 → UO 구조의 어디에 있는가(순수 함수: 경로와 본문만 읽는다). 보기 머리의 경로 표시,
 * 상태 칩, 상태 줄의 "WT020 · UO 1/2 완료" 가 이것을 그린다.
 */
import type { ExperimentStatus } from '@labnoteo/core';
import { listUnitOpBlocks, parseFrontMatterYaml } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { classifyMetaEndDate, findMetaDateFieldInLine, getSeoulDateTimeString } from '@labnoteo/core/lib/dateUtils';
import { experimentTitleFromFolderName } from '@labnoteo/core/lib/labnoteStructure';
import {
  isValidWorkflowPath,
  parseWorkflowChecklistFromReadme,
  parseWorkflowFileName,
  parseWorkflowHeading,
} from '@labnoteo/core/lib/workflowStructure';
import { isExperimentReadme } from './commands/workflow';
import { frontMatterText } from './frontMatterText';
import { README } from './paths';

export interface ExperimentRef {
  folder: string;
  /** 그 실험의 README 경로. */
  readme: string;
  /** 폴더 이름의 세 자리 번호(`003`). */
  code: string;
  title: string;
}

export interface UoItem {
  id: string;
  name: string;
  alias: string;
  /** 제목 줄(0부터). */
  line: number;
  /** Meta 의 End_date 가 채워졌다(앞날이 아니고 날짜로 읽힌다). */
  done: boolean;
}

/** 워크플로의 상태(저장 값이 아니다: UO 의 날짜에서 읽는다). */
export type WorkflowStatus = 'planned' | 'in-progress' | 'done';

export type NotePosition =
  | {
      kind: 'workflow';
      experiment: ExperimentRef;
      workflow: { path: string; id: string; title: string };
      uos: UoItem[];
      /** 커서가 든 UO(uos 의 자리). 커서가 UO 밖이면 undefined. */
      uoIndex?: number;
      uoDone: number;
      uoTotal: number;
      status: WorkflowStatus;
    }
  | { kind: 'readme'; experiment: ExperimentRef; wfDone: number; wfTotal: number; status?: ExperimentStatus | string }
  | { kind: 'note'; folder: string; title: string };

const NOTE_EXT = /(\.labnote)?\.md$/i;

function experimentRef(folder: string, title?: string): ExperimentRef {
  const name = posix.basename(folder);
  return {
    folder,
    readme: posix.join(folder, README),
    code: /^(\d{3})_/.exec(name)?.[1] ?? '',
    title: title?.trim() || experimentTitleFromFolderName(name),
  };
}

function frontMatter(text: string): Record<string, unknown> {
  return parseFrontMatterYaml(frontMatterText(text)).frontMatter ?? {};
}

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * `line` 은 커서 줄(1부터), `now` 는 End_date 가 앞날인지 가를 지금 시각(기본: 서울 시각).
 */
export function notePosition(path: string, text: string, opts: { line?: number; now?: string } = {}): NotePosition {
  const folder = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  if (isValidWorkflowPath(path)) {
    const now = opts.now ?? getSeoulDateTimeString();
    const lines = text.split(/\r?\n/);
    const uos: UoItem[] = [];
    let started = false;
    for (const b of listUnitOpBlocks(text)) {
      let done = false;
      for (let i = b.headingLine + 1; i < b.endLine; i++) {
        const date = findMetaDateFieldInLine(lines[i]);
        if (!date || date.value.trim() === '') continue;
        if (date.field === 'Start_date') started = true;
        if (date.field === 'End_date') done = classifyMetaEndDate(date.value.trim(), now) === 'ended';
      }
      uos.push({ id: b.opId, name: b.opName, alias: b.alias, line: b.headingLine, done });
    }
    const line0 = opts.line === undefined ? undefined : opts.line - 1;
    const blocks = listUnitOpBlocks(text);
    const at = line0 === undefined ? -1 : blocks.findIndex((b) => line0 >= b.headingLine && line0 < b.endLine);
    const uoDone = uos.filter((u) => u.done).length;
    const ended = filled(frontMatter(text).end_date);
    const status: WorkflowStatus =
      ended || (uos.length > 0 && uoDone === uos.length) ? 'done' : started || uoDone > 0 ? 'in-progress' : 'planned';
    const heading = parseWorkflowHeading(text);
    const parsed = parseWorkflowFileName(posix.basename(path));
    return {
      kind: 'workflow',
      experiment: experimentRef(folder),
      workflow: {
        path,
        id: heading?.id ?? parsed?.id ?? '',
        title: heading ? heading.alias || heading.name : (parsed?.safeName.replace(/_/g, ' ') ?? posix.basename(path).replace(NOTE_EXT, '')),
      },
      uos,
      ...(at >= 0 ? { uoIndex: at } : {}),
      uoDone,
      uoTotal: uos.length,
      status,
    };
  }
  if (isExperimentReadme(path)) {
    const fm = frontMatter(text);
    const items = parseWorkflowChecklistFromReadme(frontMatterText(text));
    return {
      kind: 'readme',
      experiment: experimentRef(folder, typeof fm.title === 'string' ? fm.title : undefined),
      wfDone: items.filter((i) => i.done).length,
      wfTotal: items.length,
      ...(typeof fm.status === 'string' && fm.status.trim() ? { status: fm.status.trim() } : {}),
    };
  }
  return { kind: 'note', folder, title: posix.basename(path).replace(NOTE_EXT, '') };
}
