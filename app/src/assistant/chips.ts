/**
 * 말풍선 칩(assistant spec §4.4, plan Task 11B): 사용법 / 섹션 만들기 / 단위 공정 만들기 / 워크플로 만들기 / 대화.
 *
 * 칩은 일부러 좁은 도구 묶음이다. 칩은 이름이 말하는 일만 한다: 묶음 밖의 도구는 모델에게 주지 않고, 그래도 모델이
 * 부르면 에이전트 루프가 "Unknown tool" 로 답할 뿐 아무것도 돌리지 않는다. 쓰기는 늘 `runAgent` → 미리보기 확인을
 * 거친다(내장 런타임의 `approvalConfirm`). 사용법은 모델을 부르지 않는다(HowToCard).
 * 칩 실행은 폴더 기록에 짧은 줄("[섹션 만들기] 결과 섹션")과 답으로 남는다(`chipUserLine`).
 */
import { createLabnoteTools, type ToolDef } from '@labnoteo/core';
import { t } from '../i18n/t';
import { appTools } from '../labnote/context/appTools';
import { contextTools } from '../labnote/context/contextTools';
import type { Scope } from '../labnote/context/scope';
import type { ChipId, ChipParams } from './runtime';
import { assistantTools } from './tools';

export type { ChipId, ChipParams } from './runtime';

export const CHIP_IDS: readonly ChipId[] = ['howTo', 'section', 'unitOp', 'workflow', 'chat'];

/** 실험 맥락을 읽는 도구(읽기만). 세 만들기 칩이 모두 쓴다. */
export const CONTEXT_TOOL_NAMES = [
  'list_experiment',
  'search_experiment',
  'read_note',
  'get_experiment_context',
  'get_unit_operation_context',
] as const;

/** 만들기 칩마다 모델에게 주는 도구(이 밖의 것은 주지 않는다). */
export const CHIP_TOOL_NAMES: Readonly<Record<'section' | 'unitOp' | 'workflow', readonly string[]>> = {
  section: [...CONTEXT_TOOL_NAMES, 'read_section', 'update_section', 'add_section'],
  unitOp: [...CONTEXT_TOOL_NAMES, 'search_catalog', 'get_unit_operation', 'insert_unit_operation'],
  workflow: [...CONTEXT_TOOL_NAMES, 'search_catalog', 'create_workflow'],
};

/** 칩 이름(지금 언어). 번역 키는 글자 그대로 둔다(카탈로그 검사가 키를 찾는다). */
export function chipLabel(chip: ChipId): string {
  switch (chip) {
    case 'howTo':
      return t('chip.howTo');
    case 'section':
      return t('chip.section');
    case 'unitOp':
      return t('chip.unitOp');
    case 'workflow':
      return t('chip.workflow');
    case 'chat':
      return t('chip.chat');
  }
}

/** 칩이 실험 범위(열린 실험 노트)를 꼭 써야 하는지. 대화는 실험 밖에서도 된다(저장되지 않는다, R3). */
export function chipNeedsScope(chip: ChipId): chip is 'section' | 'unitOp' | 'workflow' {
  return chip === 'section' || chip === 'unitOp' || chip === 'workflow';
}

export type ChipGate = 'ok' | 'noProvider' | 'noScope';

/** 칩을 지금 쓸 수 있는지: 사용법은 늘, 나머지는 AI 제공자가 먼저, 만들기 칩은 실험 노트도. */
export function chipGate(chip: ChipId, s: { provider: boolean; folder: string | null }): ChipGate {
  if (chip === 'howTo') return 'ok';
  if (!s.provider) return 'noProvider';
  if (chipNeedsScope(chip) && s.folder === null) return 'noScope';
  return 'ok';
}

/**
 * 칩 하나의 도구. 범위가 있으면 `appTools({scope, allowedFolders})` 의 감싼 도구(범위 검사)에서 고르고, 도우미만 쓰는
 * `add_section`·`search_catalog` 를 더한다. 대화는 앱 도구 전부 + 그 둘(외부 도구는 런타임이 따로 더한다).
 */
export function chipTools(chip: ChipId, scope: Scope | undefined, opts: { allowedFolders?: ReadonlySet<string> } = {}): ToolDef[] {
  if (chip === 'howTo') return [];
  const base: ToolDef[] = scope
    ? appTools({ scope, ...(opts.allowedFolders ? { allowedFolders: opts.allowedFolders } : {}) })
    : [...createLabnoteTools(), ...contextTools().filter((x) => x.name === 'list_experiment')];
  const all = [...base, ...assistantTools(scope)];
  if (chip === 'chat') return all;
  const allowed = CHIP_TOOL_NAMES[chip];
  return allowed.map((name) => all.find((x) => x.name === name)).filter((x): x is ToolDef => !!x);
}

/** 폴더 기록과 대화 칸에 남는 칩 실행의 짧은 줄: "[섹션 만들기] 결과 섹션". */
export function chipUserLine(chip: ChipId, summary: string): string {
  const s = summary.replace(/\s+/g, ' ').trim();
  return s ? `[${chipLabel(chip)}] ${s}` : `[${chipLabel(chip)}]`;
}

const WORKFLOW_NOTE_RE = /^\d{3}_.*\.md$/i;
const README_RE = /^readme(?:\.labnote)?\.md$/i;

/** 워크플로 노트(`###_….md`, README 는 아니다). 실험 폴더 바로 아래의 파일 이름으로 본다. */
export function isWorkflowNotePath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return WORKFLOW_NOTE_RE.test(name) && !README_RE.test(name);
}

const quoted = (s: string): string => JSON.stringify(s);

/**
 * 모델에게 가는 칩 요청(사용자 메시지). 사람이 고른 대상(노트, 섹션)과 사람이 쓴 글을 담는다. 할 일과 규칙은
 * 시스템 프롬프트(`chipSystemPrompt`)에 있다.
 */
export function chipRequest(chip: ChipId, params: ChipParams, text: string): string {
  const said = text.trim();
  const tail = said ? `\nThe researcher says: ${said}` : '';
  switch (chip) {
    case 'section': {
      const where = params.parentHeading ? ` under ${quoted(params.parentHeading)}` : '';
      const how =
        params.existing === 'yes'
          ? `The section exists: read it with read_section, then write it with update_section${params.parentHeading ? ` (parentHeading ${quoted(params.parentHeading)})` : ''}.`
          : `The section is new: add it with add_section${params.after ? ` (after ${quoted(params.after)})` : ''}.`;
      return `Draft the section ${quoted(params.heading ?? '')}${where} of the note ${quoted(params.documentPath ?? '')}. ${how}${tail}`;
    }
    case 'unitOp':
      return `Add one unit operation to the workflow note ${quoted(params.documentPath ?? '')}.${tail}`;
    case 'workflow':
      return `Create one workflow in the current experiment; pass documentPath ${quoted(params.documentPath ?? '')}.${tail}`;
    default:
      return said;
  }
}

/** 칩 모드의 시스템 프롬프트 덧붙임: 이 칩이 하는 일과 하지 않는 일. */
export function chipSystemPrompt(chip: ChipId): string {
  const only = 'Only the tools listed are available in this chip; any other tool is not available, so do not call it.';
  switch (chip) {
    case 'section':
      return [
        'You are running the "Create section" chip: draft exactly one section of the given note, then stop.',
        'Gather the experiment context first (get_experiment_context, get_unit_operation_context, read_note, read_section).',
        'Write an existing section with update_section and a new one with add_section; the researcher confirms every write after a preview.',
        "Keep any text the researcher already wrote: extend it, don't replace it.",
        'Never write Results & Discussions, QC Metrics, Discussion or Meta: the researcher writes those. Do not invent measured values.',
        only,
      ].join(' ');
    case 'unitOp':
      return [
        'You are running the "Create unit operation" chip: add exactly one unit operation from the catalog to the given workflow note.',
        'Find its id with search_catalog (kind "unitOp"), check it with get_unit_operation, then call insert_unit_operation once; the researcher confirms it after a preview.',
        'Do not fill the sections of the new block here: update_section is not available in this chip. Tell the researcher to use the Create section chip for that.',
        'If nothing in the catalog fits, say so and write nothing.',
        only,
      ].join(' ');
    case 'workflow':
      return [
        'You are running the "Create workflow" chip: create exactly one workflow from the catalog in the current experiment.',
        'Find its id with search_catalog (kind "workflow"), then call create_workflow once with the given documentPath; the researcher confirms it after a preview.',
        'If nothing in the catalog fits, say so and write nothing.',
        only,
      ].join(' ');
    default:
      return '';
  }
}
