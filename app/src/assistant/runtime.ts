/**
 * 도우미 런타임의 이음매(assistant spec §5.2, plan Task 7).
 *
 * 말풍선은 `AssistantRuntime` 하나만 안다. 앱에 들어 있는 런타임은 내장 에이전트 루프(`builtinRuntime`) 하나뿐이고,
 * 다른 AI 도구(Claude Code, DeepSeek Harness `dsh` …)는 앱에 넣지 않는다: labnoteO MCP 서버와 스킬로 같은 보관함에
 * 붙는다(README "Using another AI tool"). 테스트는 가짜 런타임(`fakeRuntime.ts`)을 등록한다.
 *
 * spec §5.2 는 등록부를 `runtimes.ts` 로 적었지만, 인터페이스와 한 곳에 두려고 이 파일(`registerRuntime`,
 * `getRuntime`, `runtimeIds`)에 둔다.
 */
import type { Translator } from '@labnoteo/core';
import type { AgentRun } from '../labnote/port/llmAgent';
import type { PetState } from './petStore';
import type { Source } from './sources';

export type { PetState } from './petStore';
export type { Source } from './sources';

/** 말풍선 칩(spec §4.4, 흐름은 chips.ts). */
export type ChipId = 'howTo' | 'section' | 'unitOp' | 'workflow' | 'chat';
export type ChipParams = Readonly<Record<string, string>>;

/** 실험 폴더 대화 기록의 메시지 하나(spec §6.1). 도구 결과와 가져온 페이지 글은 담지 않는다. */
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** 그 답을 만든 실행에 바깥 내용이 닿았는지(R11). 다음 실행을 오염된 채로 시작하게 한다. */
  tainted?: boolean;
  sources?: Source[];
  chip?: ChipId;
}

export interface AssistantTurn {
  /** 실험 폴더(보관함 상대 경로). null 이면 범위 없음(대화는 저장되지 않는다, R3). */
  folder: string | null;
  /** 앞선 대화의 요약(압축, spec §6.3). */
  summary?: string;
  /** 요약이 바깥 내용을 담은 메시지에서 나왔는지. 참이면 실행은 오염된 채로 시작하고 요약은 울타리에 싸여 간다. */
  summaryTainted?: boolean;
  /** 최근 메시지. 이 폴더의 것만. */
  history: StoredMessage[];
  userText: string;
  mode: { kind: 'chat' } | { kind: 'chip'; chip: ChipId; params: ChipParams };
}

export interface AssistantSink {
  state(s: PetState): void;
  /** 흘러 들어오는 답 글. */
  delta(text: string): void;
  /** 도구 진행 한 줄(이미 번역된 글). */
  status(line: string): void;
  /** 런타임의 출처 장부에 새 출처가 번호 `n` 으로 들어갔다. */
  source(n: number, s: Source): void;
}

export interface AssistantResult {
  content: string;
  /** 출처 장부, 번호 차례(1번이 첫째). */
  sources: Source[];
  executed: AgentRun['executed'];
  tainted: boolean;
  /** 실행이 취소됐다(사용자의 멈춤, 보관함 바뀜). 오류 글은 없다. */
  cancelled?: boolean;
  /** 사람에게 보일 오류 글(번역됨). */
  error?: string;
  /** 오류 아래에 펼쳐 볼 글(생각 고리의 되풀이된 대목, ai/loopDetail). 글 그대로 그린다. */
  errorDetail?: { label: string; text: string };
  /** 도구 사용 요약 같은 끝 알림. 부를 때의 언어로 만든다(언어를 바꾸면 지난 답의 알림도 따라 바뀐다). */
  notice?: () => string;
}

export interface AssistantRuntime {
  /** 'builtin' */
  readonly id: string;
  label(t: Translator): string;
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 오류는 던지지 않고 `error` 로 돌려준다. `signal` 이 끊기면 `cancelled`. */
  run(turn: AssistantTurn, sink: AssistantSink, signal: AbortSignal): Promise<AssistantResult>;
}

const registry = new Map<string, AssistantRuntime>();

/** 런타임을 등록하고, 등록을 푸는 함수를 준다. 같은 id 는 두 번 등록할 수 없다. */
export function registerRuntime(rt: AssistantRuntime): () => void {
  if (registry.has(rt.id)) throw new Error(`assistant runtime "${rt.id}" is already registered`);
  registry.set(rt.id, rt);
  return () => {
    if (registry.get(rt.id) === rt) registry.delete(rt.id);
  };
}

export function getRuntime(id = 'builtin'): AssistantRuntime | undefined {
  return registry.get(id);
}

export function runtimeIds(): string[] {
  return [...registry.keys()];
}
