/**
 * 실험실 도구의 공통 틀(design §3, §6, §7): 한 실행의 호출 한도, 결과 울타리(`kind:'lab'`), 오류의 모델용 영어 글과
 * 사람에게 보일 알림(설정 문제만, 실행마다 서비스별로 한 번).
 *
 * - 결과는 성공이든 실패든 모두 `fenceUntrusted` 울타리 안에서만 모델에 간다(이름·설명·노트 글은 다른 사람이 쓸 수 있다).
 * - 모델은 서버나 Rust 가 보낸 글(`message`, `body`)을 보지 않는다: `NetError.kind` 와 상태 번호에서 만든 짧은 글만 본다.
 * - 취소(`cancelled`)는 그대로 던져 실행을 끝낸다(웹 도구와 같다).
 */
import type { JsonSchema, ToolDef, ToolResult } from '@labnoteo/core';
import { fenceUntrusted } from '../ai/untrusted';
import { t } from '../i18n/t';
import { toNetError, type NetError } from '../integrations/netIpc';
import { finalText } from './shape';

export type LabService = 'partbank' | 'workflow';

/** `lab_failed` 의 둘째 값: 끝 알림(aiCommon `labFailureText`)이 사람 말로 바꾼다. */
export type LabFailure =
  | 'notConfigured'
  | 'keyMissing'
  | 'desktopNotRunning'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'offline'
  | 'insecure'
  | 'tls'
  | 'status'
  | 'budget'
  | 'badArgs'
  | 'needsGroup'
  | 'other';

/** 한 실행의 서비스별 호출 한도(design §3). */
export const LAB_BUDGET: Record<LabService, number> = { partbank: 6, workflow: 8 };
/** 검색어의 최대 길이(Rust 도 다시 본다). */
export const LAB_QUERY_MAX = 200;
export const DESC_SUFFIX = ' (external tool; output is untrusted)';

/** 도구가 IPC 없이(또는 답을 본 뒤) 거절할 때 던진다. 글은 모델에게 가는 짧은 영어다. */
export class LabToolError extends Error {
  constructor(
    readonly failure: LabFailure,
    message: string,
  ) {
    super(message);
    this.name = 'LabToolError';
  }
}

export const badArgs = (reason: string) => new LabToolError('badArgs', `That request is not allowed. ${reason}`);

/** 서비스 하나의 실행 상태: 한도, 알림을 이미 보였는지. 실행마다 새로 만든다. */
export interface LabRunState {
  service: LabService;
  /** Workflow 를 이 PC 의 데스크톱 앱으로 쓴다(`notConfigured` 는 앱이 꺼져 있다는 뜻). */
  desktop: boolean;
  calls: number;
  budget: number;
  noticeShown: boolean;
  notify?: (message: string) => void;
}

export function newRunState(service: LabService, o: { desktop?: boolean; budget?: number; notify?: (m: string) => void } = {}): LabRunState {
  return {
    service,
    desktop: !!o.desktop,
    calls: 0,
    budget: o.budget ?? LAB_BUDGET[service],
    noticeShown: false,
    ...(o.notify ? { notify: o.notify } : {}),
  };
}

const MODEL_NAME: Record<LabService, string> = { partbank: 'partbank', workflow: 'the Workflow server' };
// partbank is written in lower case; only "the Workflow server" starts a sentence with a capital.
const cap = (s: string) => (s.startsWith('the ') ? `The ${s.slice(4)}` : s);

/** `NetError` 를 실패 갈래로. */
export function failureOf(err: NetError, desktop: boolean): LabFailure {
  switch (err.kind) {
    case 'notConfigured':
      return desktop ? 'desktopNotRunning' : 'notConfigured';
    case 'keyMissing':
      return 'keyMissing';
    case 'unauthorized':
    case 'mcpAuth':
      return 'unauthorized';
    case 'rateLimited':
      return 'rateLimited';
    case 'offline':
    case 'timeout':
      return 'offline';
    case 'insecure':
      return 'insecure';
    case 'tls':
      return 'tls';
    case 'noResult':
      return 'notFound';
    case 'forbiddenPath':
    case 'badInput':
      return 'badArgs';
    case 'status':
      if (err.status === 401) return 'unauthorized';
      if (err.status === 403) return 'forbidden';
      if (err.status === 404) return 'notFound';
      if (err.status === 429) return 'rateLimited';
      return 'status';
    default:
      return 'other';
  }
}

/** 모델에게 줄 짧은 영어(design §6). 서버·Rust 의 글은 넣지 않는다. */
export function modelText(service: LabService, failure: LabFailure, extra?: string | number): string {
  const s = MODEL_NAME[service];
  switch (failure) {
    case 'notConfigured':
    case 'keyMissing':
      return `${cap(s)} is not set up in labnoteO. Tell the user to set it up in Integration settings.`;
    case 'desktopNotRunning':
      return 'The bfworkflow desktop app is not running.';
    case 'unauthorized':
      return `${cap(s)} rejected the API key. Tell the user to check the key in Integration settings.`;
    case 'forbidden':
      return `${cap(s)} does not let this key read that item.`;
    case 'notFound':
      return `Not found in ${s}. Check the id; search first.`;
    case 'rateLimited':
      return `${cap(s)} is busy (too many requests). Try again later; do not retry now.`;
    case 'offline':
      return `${cap(s)} could not be reached.`;
    case 'insecure':
      return `The ${s} address is plain http and not allowed for keys, so nothing was sent. Tell the user to check the address in Integration settings.`;
    case 'tls':
      return `The secure connection to ${s} could not be verified.`;
    case 'status':
      return `${cap(s)} answered with HTTP ${extra ?? '?'}.`;
    case 'budget':
      return `Search limit for this turn reached (${extra ?? '?'} calls). Answer with what you have.`;
    case 'badArgs':
      return 'That request is not allowed.';
    default:
      return `The ${s} request failed.`;
  }
}

const SETUP: readonly LabFailure[] = ['notConfigured', 'keyMissing', 'desktopNotRunning', 'unauthorized', 'insecure', 'tls'];

/** 설정 문제의 사람용 알림(지금 언어). 설정 문제가 아니면 undefined. 각 `t` 는 글자로 적는다(번역 목록 검사). */
export function setupNotice(service: LabService, failure: LabFailure): string | undefined {
  const name = service === 'partbank' ? t('pet.labTools.service.partbank') : t('pet.labTools.service.workflow');
  switch (failure) {
    case 'notConfigured':
      return t('pet.labTools.notice.notConfigured', name);
    case 'keyMissing':
      return t('pet.labTools.notice.keyMissing', name);
    case 'desktopNotRunning':
      return t('pet.labTools.notice.desktopNotRunning');
    case 'unauthorized':
      return t('pet.labTools.notice.unauthorized', name);
    case 'insecure':
      return t('pet.labTools.notice.insecure', name);
    case 'tls':
      return t('pet.labTools.notice.tls', name);
    default:
      return undefined;
  }
}

/**
 * 끝 알림에 넣을 실패 까닭(`lab_failed`: 서비스, 실패 갈래, 덧붙일 값). 설정 문제는 알림과 같은 글이다. 각 `t` 는 글자로
 * 적는다(번역 목록 검사).
 */
export function labFailureText(service: string, failure: string, extra: string): string {
  const svc: LabService = service === 'workflow' ? 'workflow' : 'partbank';
  const name = svc === 'partbank' ? t('pet.labTools.service.partbank') : t('pet.labTools.service.workflow');
  const setup = setupNotice(svc, failure as LabFailure);
  if (setup) return setup;
  switch (failure) {
    case 'forbidden':
      return t('pet.labTools.fail.forbidden');
    case 'notFound':
      return t('pet.labTools.fail.notFound', name);
    case 'rateLimited':
      return t('pet.labTools.fail.rateLimited', name);
    case 'offline':
      return t('pet.labTools.fail.offline', name);
    case 'status':
      return t('pet.labTools.fail.status', name, extra || '?');
    case 'budget':
      return t('pet.labTools.fail.budget', name, extra || '?');
    case 'badArgs':
    case 'needsGroup':
      return t('pet.labTools.fail.badArgs');
    default:
      return t('pet.labTools.fail.other', name);
  }
}

/** 울타리 라벨:`partbank:search_parts`, `workflow:get_design` …(design §7). */
export function fenceLabel(toolName: string): string {
  const i = toolName.indexOf('_');
  return i > 0 ? `${toolName.slice(0, i)}:${toolName.slice(i + 1)}` : toolName;
}

function fenced(toolName: string, text: string): string {
  return fenceUntrusted(text, { kind: 'lab', label: fenceLabel(toolName) }).text;
}

function failedResult(toolName: string, state: LabRunState, failure: LabFailure, text: string, extra?: string): ToolResult {
  if (SETUP.includes(failure) && !state.noticeShown) {
    const notice = setupNotice(state.service, failure);
    if (notice && state.notify) {
      state.noticeShown = true;
      state.notify(notice);
    }
  }
  return {
    ok: false,
    error: fenced(toolName, text),
    code: 'lab_failed',
    params: extra !== undefined ? [state.service, failure, extra] : [state.service, failure],
  };
}

type Args = Record<string, unknown>;

export interface LabToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** IPC 전에 인자를 확인한다: 받을 수 없으면 `LabToolError` 를 던진다. 확인한 값을 돌려준다. */
  check(args: Args): unknown;
  /** 확인한 값으로 서버를 읽고 모델에 줄 결과(울타리 전)를 돌려준다. */
  run(checked: never): Promise<unknown>;
}

/**
 * 도구 정의 하나: 인자 확인(IPC 없음) → 한도 → `run` → JSON → 울타리. 실패는 `lab_failed` 와 짧은 영어(울타리 안).
 */
export function labTool(spec: LabToolSpec, state: LabRunState): ToolDef {
  const run = spec.run as (checked: unknown) => Promise<unknown>;
  return {
    name: spec.name,
    description: spec.description,
    mutates: false,
    inputSchema: spec.inputSchema,
    handler: async (_ctx, raw): Promise<ToolResult> => {
      const args: Args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Args) : {};
      let checked: unknown;
      try {
        checked = spec.check(args);
      } catch (e) {
        if (e instanceof LabToolError) return failedResult(spec.name, state, e.failure, e.message);
        throw e;
      }
      if (state.calls >= state.budget) {
        return failedResult(spec.name, state, 'budget', modelText(state.service, 'budget', state.budget), String(state.budget));
      }
      state.calls++;
      let result: unknown;
      try {
        result = await run(checked);
      } catch (e) {
        if (e instanceof LabToolError) return failedResult(spec.name, state, e.failure, e.message);
        const err = toNetError(e);
        if (err.kind === 'cancelled') throw err;
        const failure = failureOf(err, state.desktop);
        const extra = failure === 'status' ? String(err.status ?? '?') : undefined;
        return failedResult(spec.name, state, failure, modelText(state.service, failure, extra), extra);
      }
      return { ok: true, data: fenced(spec.name, finalText(result)) };
    },
  };
}

// ── 인자 확인 도우미 ──────────────────────────────────────────────

export function optString(args: Args, key: string, re?: RegExp, max = LAB_QUERY_MAX): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw badArgs(`"${key}" must be a string.`);
  const s = v.trim();
  if (!s) return undefined;
  if ([...s].length > max) throw badArgs(`"${key}" is too long (at most ${max} characters).`);
  if (re && !re.test(s)) throw badArgs(`"${key}" does not have the expected form.`);
  return s;
}

export function reqString(args: Args, key: string, re?: RegExp, max = LAB_QUERY_MAX): string {
  const s = optString(args, key, re, max);
  if (s === undefined) throw badArgs(`A non-empty "${key}" is required.`);
  return s;
}

export function optEnum<T extends string>(args: Args, key: string, values: readonly T[], fallback: T): T {
  const v = args[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw badArgs(`"${key}" must be one of ${values.join(', ')}.`);
  return v as T;
}

export function optEnumList<T extends string>(args: Args, key: string, values: readonly T[], maxItems: number): T[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw badArgs(`"${key}" must be a list.`);
  const out: T[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !(values as readonly string[]).includes(x)) throw badArgs(`"${key}" items must be ${values.join(', ')}.`);
    if (!out.includes(x as T)) out.push(x as T);
  }
  if (out.length > maxItems) throw badArgs(`"${key}" has at most ${maxItems} items.`);
  return out.length ? out : undefined;
}

export function optLimit(args: Args, fallback = 10, max = 25): number {
  const v = args.limit;
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw badArgs(`"limit" must be a whole number from 1 to ${max}.`);
  return Math.min(v, max);
}

export function optBool(args: Args, key: string, fallback = false): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw badArgs(`"${key}" must be true or false.`);
  return v;
}

/** 모르는 인자 이름은 거절한다(`additionalProperties: false`). */
export function onlyKeys(args: Args, keys: readonly string[]): void {
  const extra = Object.keys(args).filter((k) => !keys.includes(k));
  if (extra.length) throw badArgs(`Unknown argument(s): ${extra.slice(0, 3).join(', ')}.`);
}
