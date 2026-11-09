/**
 * `@` 샘플 완성의 후보 출처(plan SP5 D9, Task 12). 완성 소스는 등록된 출처마다 `rows` 를 묻고 `orderRows` 로 줄을 세운다.
 * SP5 는 대장(`registrySource`: 쓰고 있는 샘플)과 로컬 동작(`localActionsSource`: 카탈로그 검색, 새 ID 생성, 직접 입력)을
 * 등록한다. SP6 은 `registerSampleSource(partbankSource)` 를 `order >= 100` 으로 부르기만 하면 된다(완성 소스와 Editor 는 그대로).
 */
import { parseSampleTrigger, type SampleCompletionEntry, type SampleTrigger } from '@labnoteo/core';
import { hasReferenceCatalog, noteLabsamplesFolder, loadSamplesByType, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { actionKinds, existingRows } from '../labnote/port/sampleSuggestRows';
import { sampleEvents, type SampleEnv } from './env';

export interface SampleQuery {
  notePath: string;
  /** core parseSampleTrigger result; core lower-cases searchTerm. */
  trigger: SampleTrigger;
  /** Raw text after `@type;`/`@type:` (the plugin's #142 prefill, case kept), undefined when there is no separator. */
  typed: string | undefined;
}

export interface SampleActionRow {
  kind: 'action';
  /** 'catalog' | 'generate' | 'manual' | SP6 'partbank' */
  source: string;
  /** null = every type (@sample) */
  type: string | null;
  label: string;
  detail: string;
  /** catalog 10, generate 20, manual 30, remote sources >= 100 */
  order: number;
  /** Opens the source's own dialog (a remote search debounces there, never per keystroke); resolves to reference text or undefined. */
  run(q: SampleQuery): Promise<string | undefined>;
}

export interface SampleExistingRow {
  kind: 'existing';
  entry: SampleCompletionEntry;
}

export type SampleRow = SampleExistingRow | SampleActionRow;

export interface SampleCandidateSource {
  readonly id: string;
  /** Called on every keystroke; must be cached/local. A remote source returns only action rows. */
  rows(q: SampleQuery, env: SampleEnv): Promise<SampleRow[]>;
}

export type ActionRunner = (env: SampleEnv, q: SampleQuery, type: string) => Promise<string | undefined>;

/** Filled by Task 16 (create and catalog flows). An unset runner resolves undefined. */
export const sampleActionRunners = {} as { catalog?: ActionRunner; generate?: ActionRunner; manual?: ActionRunner };

/** 완성이 키를 누를 때마다 `{Type}.json` 을 다시 읽지 않도록 기록을 잠시 기억한다(플러그인 CACHE_TTL_MS). */
export const SAMPLE_CACHE_MS = 1500;

const sources: SampleCandidateSource[] = [];

/** 출처를 더한다. 돌려준 함수가 뺀다. 같은 객체를 두 번 더하지 않는다. */
export function registerSampleSource(s: SampleCandidateSource): () => void {
  if (!sources.includes(s)) sources.push(s);
  return () => {
    const i = sources.indexOf(s);
    if (i >= 0) sources.splice(i, 1);
  };
}

/** 등록 순서대로의 출처. */
export function sampleSources(): readonly SampleCandidateSource[] {
  return [...sources];
}

/** 쓰고 있는 샘플(폐기되지 않은 것) → 동작(order 순, 같으면 들어온 순) → 폐기된 샘플. 각 묶음 안의 순서는 지킨다. */
export function orderRows(rows: readonly SampleRow[]): SampleRow[] {
  const live: SampleRow[] = [];
  const actions: SampleActionRow[] = [];
  const discarded: SampleRow[] = [];
  for (const r of rows) {
    if (r.kind === 'action') actions.push(r);
    else (r.entry.discarded ? discarded : live).push(r);
  }
  // Array.prototype.sort 는 안정 정렬이다
  actions.sort((a, b) => a.order - b.order);
  return [...live, ...actions, ...discarded];
}

/**
 * 커서 앞 줄 글에서 샘플 질의를 만든다. 트리거가 없거나 정의(`@dna;ID;alias;`)를 치는 중이면 undefined(#171).
 * `typed` 는 플러그인이 대화상자를 채우는 `@type;` 뒤의 글 그대로(#142). 구분자가 없으면 undefined.
 */
export function sampleQueryAt(lineBefore: string, notePath: string, types: readonly string[]): SampleQuery | undefined {
  const trigger = parseSampleTrigger(lineBefore, types);
  if (!trigger) return undefined;
  const typed = /^@[\p{L}\p{N}_]+[;:](.*)$/u.exec(lineBefore.slice(trigger.startCol))?.[1];
  return { notePath, trigger, typed };
}

const recordCache = new Map<string, { records: Record<string, SampleRecord>; expiry: number }>();
const catalogCache = new Map<string, { exists: boolean; expiry: number }>();

/** 기억한 기록과 카탈로그 여부를 버린다. 다음 완성이 다시 읽는다. `sampleEvents` 가 부른다. */
export function clearSampleSourceCaches(): void {
  recordCache.clear();
  catalogCache.clear();
}

sampleEvents.subscribe(() => clearSampleSourceCaches());

/** `{type}.json` from `folder`, memoised for SAMPLE_CACHE_MS. */
async function loadCached(env: SampleEnv, folder: string, type: string): Promise<Record<string, SampleRecord>> {
  const key = `${folder}\u0000${type}`;
  const now = Date.now();
  const hit = recordCache.get(key);
  if (hit && hit.expiry > now) return hit.records;
  const records = await loadSamplesByType(env.fs, folder, type);
  recordCache.set(key, { records, expiry: now + SAMPLE_CACHE_MS });
  return records;
}

/**
 * Whether a `{type}_*.json` catalog exists for the note, in the Local and Global folders "Search catalog" reads,
 * memoised like the records. Without one the action is left out (#99).
 */
async function catalogExists(env: SampleEnv, notePath: string, type: string): Promise<boolean> {
  const globalFolder = env.globalFolder();
  const localFolder = noteLabsamplesFolder(notePath, globalFolder);
  const key = `${localFolder}\u0000${globalFolder}\u0000${type}`;
  const now = Date.now();
  const hit = catalogCache.get(key);
  if (hit && hit.expiry > now) return hit.exists;
  const knownTypes = env.types();
  const exists =
    (await hasReferenceCatalog(env.fs, localFolder, type, knownTypes)) ||
    (Boolean(globalFolder) && (await hasReferenceCatalog(env.fs, globalFolder, type, knownTypes)));
  catalogCache.set(key, { exists, expiry: now + SAMPLE_CACHE_MS });
  return exists;
}

/** 대장에 있는 샘플(Local 이 같은 ID 의 Global 을 이긴다). */
export const registrySource: SampleCandidateSource = {
  id: 'registry',
  rows: (q, env) => existingRows(env, q, (folder, type) => loadCached(env, folder, type)),
};

const ACTION_ORDER = { catalog: 10, generate: 20, manual: 30 } as const;

/** 플러그인 renderSuggestion 의 제목과 설명(플러그인 영어 키, coreT). */
function actionText(env: SampleEnv, kind: 'catalog' | 'generate' | 'manual', type: string): { label: string; detail: string } {
  if (kind === 'catalog') {
    return { label: env.t('Search {0} catalog', type), detail: env.t('Insert a reference from the product catalog') };
  }
  if (kind === 'generate') {
    return { label: env.t('Generate new {0} ID', type), detail: env.t('Automatically generate a new sample ID') };
  }
  return { label: env.t('Enter info'), detail: env.t('Manually enter sample ID, alias, and description') };
}

/** 한 종류 트리거의 카탈로그 검색, 새 ID 생성, 직접 입력. 실행은 `sampleActionRunners` 에 맡긴다. */
export const localActionsSource: SampleCandidateSource = {
  id: 'local-actions',
  async rows(q, env) {
    const kinds = await actionKinds(q.trigger, (type) => catalogExists(env, q.notePath, type));
    return kinds.map(({ kind, type }): SampleActionRow => ({
      kind: 'action',
      source: kind,
      type,
      ...actionText(env, kind, type),
      order: ACTION_ORDER[kind],
      run: async (query) => {
        const runner = sampleActionRunners[kind];
        return runner ? runner(env, query, type) : undefined;
      },
    }));
  },
};

/** 앱이 한 번 부른다(여러 번 불러도 한 번만 등록한다). */
export function registerSampleSources(): void {
  registerSampleSource(registrySource);
  registerSampleSource(localActionsSource);
}
