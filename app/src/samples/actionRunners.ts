/**
 * `@` 완성의 동작 줄(카탈로그 검색, 새 ID 생성, 직접 입력)이 여는 흐름(plan SP5 Task 16). 플러그인 sampleSuggest.ts 의
 * selectSuggestion 처럼: 카탈로그는 `pickCatalogReference`, 생성과 직접 입력은 지금 노트의 Local 폴더(`env.localFolder()`,
 * 플러그인의 localSampleFolder)에 `createSampleInteractive(...).referenceText`. `@type;` 뒤에 친 글(#142)이 첫 칸을 채운다.
 */
import { createSampleInteractive, pickCatalogReference } from '../labnote/port/sampleCreate';
import { sampleActionRunners, type ActionRunner } from './sources';

const createRunner =
  (mode: 'generate' | 'manual'): ActionRunner =>
  async (env, q, type) =>
    (await createSampleInteractive(env, { type, folder: env.localFolder(), mode, scope: 'local', initial: q.typed }))?.referenceText;

const catalogRunner: ActionRunner = (env, q, type) =>
  pickCatalogReference(env, { type, docPath: q.notePath, initialQuery: q.typed?.trim() });

/** 앱이 `registerSampleSources()` 옆에서 부른다. 여러 번 불러도 같다. */
export function installSampleActionRunners(): void {
  sampleActionRunners.catalog = catalogRunner;
  sampleActionRunners.generate = createRunner('generate');
  sampleActionRunners.manual = createRunner('manual');
}
