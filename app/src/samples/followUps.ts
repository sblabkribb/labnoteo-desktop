/**
 * 앱에서 한 이름 바꾸기와 삭제 뒤의 샘플 후속 처리(SP5 D14, Task 26). 플러그인 main.ts 의 vault rename/delete 듣기를
 * entryEvents 로 옮겼다. 각 알림을 파일마다 펴서(`files`, 작업 전에 뜬 목록) 본다.
 * - 이름 바꾸기: `settled`(링크 고침까지 끝남)를 기다린 뒤에만 묻는다.
 *   - 대장 `{Type}.json` 이 이름을 잃었고 그 폴더는 남아 있으면 이름을 되돌릴지 묻는다(#430, sampleLedgerLosing).
 *   - 실험 안에서 제자리 이름이 바뀐 노트는 Local 대장의 sources 에서도 새 이름이 된다(#149).
 *   - 실험의 `resources/labsamples`(또는 `resources`)가 이름을 잃었으면 되돌릴지 묻는다(#338, experimentLosingLabsamples).
 * - 삭제: 대장 파일이면 알린다(그 폴더째 지웠으면 알리지 않는다). 워크플로 노트면 sources 에서만 빠진다(기록은 남는다,
 *   플러그인 syncReadmeAndSamplesOnDelete 의 샘플 부분. README 체크리스트 정리는 fileOps 가 따로 묻는다).
 * - 다른 실험으로 옮겨 간 노트는(이름 바꾸기 하나가 폴더째 옮긴 것도 노트마다) (옛, 새) 실험 짝마다 SAMPLE_MOVE_BATCH_MS
 *   모은 뒤 한 번, 쓰던 Local 샘플을 가져올지 묻는다(#97, Task 27, offerLocalSamplesMoved). 새 실험의 추적을 본다.
 * 모든 쓰기 경로처럼 먼저 samples.ready(path) 를 기다린다(D11): 샘플 추적이 꺼진 실험과 설정에는 아무것도 하지 않는다.
 */
import * as posix from '@labnoteo/core/posix';
import { experimentLosingLabsamples, sampleLedgerLosing } from '@labnoteo/core/lib/labnoteStructure';
import { removeSourcesForDocument } from '@labnoteo/core/lib/sampleStorage';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { entryEvents, type EntryEvent } from '../labnote/commands/entryEvents';
import {
  noticeSampleLedgerDeleted,
  offerLabsamplesFolderBack,
  offerSampleLedgerBack,
  renameLocalSampleSources,
} from '../labnote/port/sampleLedger';
import { cancelPendingSampleMoves, offerLocalSamplesMoved } from '../labnote/port/sampleRelocation';
import { sampleListHeaders } from '../labnote/port/sampleListTable';
import { t } from '../i18n/t';
import { isRegistryPath, RegistryUnreadableError, type SampleEnv } from './env';
import { samples } from './sampleStore';

type Renamed = Extract<EntryEvent, { kind: 'renamed' }>;
type Deleted = Extract<EntryEvent, { kind: 'deleted' }>;

const report = (err: unknown) => console.error('[samples] follow-up failed', err);

/** 묶어 둔 가져오기 제안을 돌린다(플러그인의 this.run): 읽을 수 없는 대장은 runCommand 처럼 경고로 알린다(D13). */
const runOffer = (env: SampleEnv) => (job: () => Promise<void>) => {
  void job().catch((err: unknown) => {
    if (err instanceof RegistryUnreadableError) env.host.notify('warn', t('samples.registryUnreadable', err.path));
    else report(err);
  });
};

/** 이름 바꾸기 하나의 후속 처리. 대화상자는 함께 띄운다(플러그인의 this.run 처럼 서로 기다리지 않는다). */
async function afterRename(env: SampleEnv, e: Renamed): Promise<void> {
  const jobs: Array<Promise<void>> = [];
  if (e.isDir) {
    const samplesOf = experimentLosingLabsamples(e.from, e.to);
    // 플러그인: 옛 이름이 labsamples 이거나 그 아래에 labsamples 폴더가 있었다. 빈 labsamples 폴더는 파일 목록에 없어
    // 새 자리에서 그 폴더가 있는지 본다.
    const holdsSamples =
      posix.basename(e.from) === 'labsamples' ||
      e.files.some((f) => f.from.startsWith(`${e.from}/labsamples/`)) ||
      (samplesOf !== undefined && (await env.fs.exists(`${e.to}/labsamples`)));
    if (samplesOf && holdsSamples && (await samples.ready(e.from)) && (await env.fs.exists(samplesOf))) {
      jobs.push(offerLabsamplesFolderBack(env, e.to, samplesOf, e.from));
    }
  }
  for (const f of e.files) {
    // 다른 실험으로 옮겨 갔으면: 새 실험이 샘플을 추적할 때만 묻는다(main.ts offerLocalSamplesMoved, D11 의 기다림)
    if (await samples.ready(f.to)) {
      jobs.push(offerLocalSamplesMoved(env, f.from, f.to, sampleListHeaders(env), runOffer(env)));
    }
    // sampleLedgerLosing 의 추적 검사(main.ts:1345-1349)와 D11 의 쓰기 전 기다림
    if (!(await samples.ready(f.from))) continue;
    const ledger = sampleLedgerLosing(f.from, f.to, env.types(), env.globalFolder());
    // Not when its folder was renamed: the registry went along (#430).
    if (ledger && (await env.fs.exists(ledger.folder))) jobs.push(offerSampleLedgerBack(env, f.to, ledger.type, f.from));
    renameLocalSampleSources(env, f.from, f.to);
  }
  await Promise.all(jobs.map((j) => j.catch(report)));
}

/** 삭제 하나의 후속 처리. */
async function afterDelete(env: SampleEnv, e: Deleted): Promise<void> {
  const jobs: Array<Promise<void>> = [];
  let pruned = false;
  for (const file of e.files) {
    if (!(await samples.ready(file))) continue;
    if (isRegistryPath(file, env.globalFolder())) {
      const ledger = sampleLedgerLosing(file, undefined, env.types(), env.globalFolder());
      if (ledger) jobs.push(noticeSampleLedgerDeleted(env, file, ledger.folder, ledger.type));
      continue;
    }
    if (!isValidWorkflowPath(file)) continue;
    // A deleted document defines nothing: every record that listed it drops it from `sources`, the sample stays.
    try {
      await removeSourcesForDocument(env.fs, file, '', env.globalFolder(), env.types());
      pruned = true;
    } catch (err) {
      console.warn('[samples] sample cleanup after a delete failed:', err);
    }
  }
  if (pruned) env.changed();
  await Promise.all(jobs.map((j) => j.catch(report)));
}

/** entryEvents 를 듣고 후속 처리를 한다. 돌려준 함수로 그만 듣는다(그 뒤 끝나는 settled 에는 아무것도 하지 않는다). */
export function wireSampleFollowUps(env: () => SampleEnv | undefined): () => void {
  let live = true;
  const off = entryEvents.subscribe((e) => {
    const run = async () => {
      if (e.kind === 'renamed') {
        await e.settled.catch(() => undefined);
        const current = live ? env() : undefined;
        if (current) await afterRename(current, e);
        return;
      }
      const current = env();
      if (current) await afterDelete(current, e);
    };
    void run().catch(report);
  });
  return () => {
    live = false;
    off();
    cancelPendingSampleMoves();
  };
}
