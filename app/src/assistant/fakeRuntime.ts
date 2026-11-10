/**
 * 테스트용 가짜 런타임(plan Task 7). 정해 둔 조각을 흘리고 정해 둔 결과를 돌려준다. 받은 차례는 `turns` 에 남는다.
 * 앱 코드는 이것을 가져오지 않는다.
 */
import type { AssistantResult, AssistantRuntime, AssistantTurn } from './runtime';
import type { Source } from './sources';

export interface FakeRuntimeScript {
  id?: string;
  deltas?: string[];
  status?: string[];
  sources?: Source[];
  content?: string;
  result?: Partial<AssistantResult>;
  available?: { ok: true } | { ok: false; reason: string };
  /** 실행 도중(talk 전에) 기다릴 약속. 멈춤 시험에 쓴다. */
  hold?: Promise<void>;
}

export interface FakeRuntime extends AssistantRuntime {
  readonly turns: AssistantTurn[];
}

export function fakeRuntime(script: FakeRuntimeScript = {}): FakeRuntime {
  const turns: AssistantTurn[] = [];
  return {
    id: script.id ?? 'fake',
    turns,
    label: () => 'Fake',
    available: async () => script.available ?? { ok: true },
    async run(turn, sink, signal) {
      turns.push(turn);
      sink.state('think');
      for (const line of script.status ?? []) sink.status(line);
      const sources: Source[] = [];
      for (const s of script.sources ?? []) {
        sources.push(s);
        sink.source(sources.length, s);
      }
      if (script.hold) await script.hold;
      if (signal.aborted) {
        sink.state('idle');
        return { content: '', sources, executed: [], tainted: false, cancelled: true };
      }
      for (const d of script.deltas ?? []) {
        sink.state('talk');
        sink.delta(d);
      }
      sink.state('done');
      return {
        content: script.content ?? (script.deltas ?? []).join(''),
        sources,
        executed: [],
        tainted: false,
        ...script.result,
      };
    },
  };
}
