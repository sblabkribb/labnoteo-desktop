/**
 * 샘플 정의 창을 열고 고른 동작을 옮겨 온 흐름(plan SP5 Task 20-22)으로 돌린다(Task 24, D16). 창은 동작만 돌려주는
 * 순수한 보기이고, 흐름과 그 뒤의 알림(`env.changed`)은 여기서 한다.
 * - 플러그인 창은 흐름이 끝나야(true) 닫히고, 취소하거나 거절되면(false) 그대로 남는다. 앱의 창은 고르는 순간 닫히므로
 *   흐름이 false 면 대장에서 정의를 다시 읽어 창을 다시 연다(거절된 흐름도 기록을 바꿨을 수 있다). 기록이 없어졌으면 멈춘다.
 * - "Open JSON file" 과 사용처는 앱 안에서 그 파일을 연다.
 */
import { loadSamplesByType } from '@labnoteo/core/lib/sampleStorage';
import { openSampleDefinitionDialog } from '../labnote/host/dialogStore';
import { definitionModel, groupUsages, type SampleDefinitionAction } from '../labnote/port/sampleDefinitionModel';
import { deleteSampleInteractive } from '../labnote/port/sampleDelete';
import { editSampleInteractive, setSampleDiscardedInteractive } from '../labnote/port/sampleEdit';
import { changeSampleTypeInteractive, moveSampleInteractive } from '../labnote/port/sampleMove';
import { sampleUsageSpots, type ResolvedSampleDefinition } from '../labnote/port/sampleQuery';
import { loadCatalogSamples } from '../labnote/port/sampleScope';
import type { SampleEnv } from './env';

type Definition = ResolvedSampleDefinition & { type: string; id: string };

/** 고른 동작의 흐름을 돌린다. 끝났으면 true, 취소·거절이면 false. */
async function runAction(env: SampleEnv, def: Definition, action: SampleDefinitionAction, move: { toFolder: string } | undefined): Promise<boolean> {
  const { scope, folder, type, id, record } = def;
  switch (action) {
    case 'edit':
      return editSampleInteractive(env, { folder, type, id, record });
    case 'delete':
      return deleteSampleInteractive(env, { folder, type, id });
    case 'discard':
    case 'undiscard':
      return setSampleDiscardedInteractive(env, { folder, type, id, discarded: !record.discarded });
    case 'moveGlobal':
    case 'moveLocal':
      if (!move) return false;
      return moveSampleInteractive(env, {
        fromScope: scope === 'local' ? 'local' : 'global',
        fromFolder: folder,
        toFolder: move.toFolder,
        type,
        id,
      });
    case 'changeType':
      return changeSampleTypeInteractive(env, { folder, type, id });
    case 'openJson':
      await env.openFile(def.file ?? `${folder}/${type}.json`);
      return true;
  }
}

/**
 * 정의 창을 열고 고른 것을 한다: 사용처를 고르면 그 줄로 가고, 동작을 고르면 그 흐름을 돌린 뒤 `env.changed([def.folder])`.
 * 사용처는 창이 열린 뒤에 채워진다(범위의 노트를 모두 읽으므로).
 */
export async function runSampleDefinition(env: SampleEnv, def: Definition, where: { docPath?: string; localFolder?: string }): Promise<void> {
  for (;;) {
    const model = definitionModel(env, def, where);
    const usages = sampleUsageSpots(env, def.folder, def.type, def.id).then((spots) => groupUsages(spots, env.t));
    // 창이 사용처를 기다리지 않고 닫혀도 거절이 처리되지 않은 채 남지 않게(창은 실패를 스스로 알린다)
    usages.catch(() => undefined);
    const result = await openSampleDefinitionDialog(model, usages);
    if (!result) return;
    if ('open' in result) {
      const { path, line, ch } = result.open;
      await env.openFile(path, { line, ...(ch === undefined ? {} : { ch }) });
      return;
    }
    if (result.action === 'openJson') {
      await runAction(env, def, result.action, model.move);
      return;
    }
    if (await runAction(env, def, result.action, model.move)) {
      env.changed([def.folder]);
      return;
    }
    // A refused flow can still have written the record (Delete refused -> Mark as discarded):
    // reopen on what the registry holds now, and stop when the record is gone.
    const fresh = await reloadDefinition(env, def);
    if (!fresh) return;
    def = fresh;
  }
}

/** The definition as its registry (or catalog) holds it now; undefined when the record is gone. */
async function reloadDefinition(env: SampleEnv, def: Definition): Promise<Definition | undefined> {
  const { scope, folder, type, id } = def;
  if (scope === 'catalog') {
    const fileOf: Record<string, string> = {};
    const record = (await loadCatalogSamples(env, folder, type, fileOf))[id];
    return record ? { ...def, record, file: fileOf[id] ?? def.file } : undefined;
  }
  const record = (await loadSamplesByType(env.fs, folder, type))[id];
  return record ? { ...def, record } : undefined;
}
