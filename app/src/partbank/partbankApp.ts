/**
 * PartBank 을 앱에 잇는다(plan Task 26). 보관함 화면이 맥락(`ctx`, 보관함마다 하나)을 얻으면 `startPartbank(ctx)` 를 부르고,
 * 보관함을 바꾸거나 화면이 내려가면 돌려준 함수가 놓은 것을 모두 거둔다:
 *
 * 1. PartbankFeature 를 만들어 `setPartbankFeature` 로 놓고 키 상태를 읽는다(`refresh`);
 * 2. 앱 데이터의 카탈로그 저장소(`tauriCatalogStore`)를 놓는다(D15);
 * 3. `@` 완성의 "Search partbank" 출처를 등록한다;
 * 4. 연동 설정의 두 연결 시험을 등록한다;
 * 5. 노트 사용처 동기화를 보관함 사건(감시자, processNote 쓰기, 이름 바꾸기, 삭제)에 잇는다. 시작 패스는 STARTUP_DELAY_MS 뒤다.
 *    `enabled()` 는 이 보관함의 `partbankSendUsages` 다(기본 꺼짐, D12);
 * 6. 연동 설정이 저장된 뒤: 보내기를 켜면 전부 보내고, 끄면 보낸 것을 지우고, 주소가 바뀌면 키 상태를 다시 읽는다;
 * 7. 키를 저장하거나 지우면 바로 기능의 키 상태를 바꾼다(명령과 `@` 줄이 곧바로 보이거나 숨는다);
 * 8. 샘플 대장이 바뀌면(노트 동기화가 쓴 것은 빼고) 모든 노트를 다시 견주도록 예약한다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { onIntegrationChange, onSecretsChange, type IntegrationSettingsValue } from '../integrations/probes';
import { vaultGuard, type InvokeFn } from '../integrations/netIpc';
import type { CommandContext } from '../labnote/commands/context';
import { deleteEvents } from '../labnote/commands/fileOps';
import { noteWrites } from '../labnote/openNotes';
import { PartbankFeature, registerPartbankProbes } from '../labnote/port/partbankFeature';
import { PartbankUsageSync, usageStateStore, type Timers, type UsageEvents } from '../labnote/port/partbankUsageSync';
import { renameEvents } from '../links/renameWithLinks';
import { createSampleEnv, sampleEvents, type SampleEnv } from '../samples/env';
import { registerSampleSource } from '../samples/sources';
import { subscribeVaultChanges, type ListenFn, type VaultChange } from '../vault/useVaultEvents';
import { currentCatalogStore, setPartbankCatalogStore, tauriCatalogStore } from './catalogOverlay';
import { partbank, setPartbankFeature } from './current';
import { partbankSource } from './partbankSource';

/** 노트 동기화가 대장을 쓰는 동안(그 `changed` 알림을 내보내는 동안) 0 보다 크다. */
let noteSyncDepth = 0;

/**
 * 저장 때의 샘플 동기화가 쓸 env: 그 동기화가 쓴 대장의 알림은 "노트 동기화에서 왔다"고 표시된다. 노트 자체는 제 변경
 * 사건으로 사용처 동기화에 가므로, 이 알림으로 모든 노트를 다시 견주지 않는다(플러그인 refreshSampleViews({fromNoteSync})).
 */
export function noteSyncEnv<E extends Pick<SampleEnv, 'changed'>>(env: E): E {
  return {
    ...env,
    changed(paths?: readonly string[]) {
      noteSyncDepth++;
      try {
        env.changed(paths);
      } finally {
        noteSyncDepth--;
      }
    },
  };
}

/** 보관함 뿌리의 마지막 이름(플러그인 app.vault.getName()). */
function vaultNameOf(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

const URL_KEYS = ['partbankWebUrl', 'partbankDesktopUrl'] as const;

export interface PartbankAppDeps {
  invoke?: InvokeFn;
  timers?: Timers;
  /** 감시자 사건을 듣는 함수(테스트가 바꾼다). */
  listen?: ListenFn;
}

export function startPartbank(ctx: CommandContext, deps: PartbankAppDeps = {}): () => void {
  const invoke = deps.invoke ?? tauriInvoke;
  const listen = deps.listen ?? (tauriListen as ListenFn);
  let stopped = false;

  // 1. 기능
  const feature = new PartbankFeature({ settings: () => ctx.settings, host: ctx.host, invoke });
  setPartbankFeature(feature);
  void feature.refresh();

  // 2. 카탈로그 저장소
  const store = tauriCatalogStore(invoke);
  setPartbankCatalogStore(store);

  // 3, 4. `@` 출처와 연결 시험
  const offSource = registerSampleSource(partbankSource(() => (stopped ? undefined : partbank())));
  const offProbes = registerPartbankProbes(feature);

  // 5. 노트 사용처 동기화. 앱의 ctx.settings 는 다시 그려진 뒤에야 바뀐다: 연동 설정이 방금 저장한 값을 그때까지 쓴다.
  let savedSend: boolean | undefined;
  const enabled = (): boolean => {
    const current = ctx.settings.partbankSendUsages === true;
    if (savedSend !== undefined && current === savedSend) savedSend = undefined;
    return savedSend ?? current;
  };
  const usage = new PartbankUsageSync({
    env: () => (stopped ? undefined : createSampleEnv(ctx)),
    feature,
    enabled,
    vaultName: () => vaultNameOf(ctx.vaultRoot),
    state: usageStateStore(invoke),
    timers: deps.timers,
    guard: () => vaultGuard(invoke),
  });
  const watch = (fn: (change: VaultChange) => void) => subscribeVaultChanges(listen, fn);
  const events: UsageEvents = {
    onModify(fn) {
      const offWrites = noteWrites.subscribe(fn);
      const offWatch = watch((c) => {
        // 빈 경로: 무엇이 바뀌었는지 놓쳤다. 모든 노트를 다시 견준다.
        if (c.path === '') usage.scheduleReconcile();
        else if (c.kind !== 'removed') fn(c.path);
      });
      return () => {
        offWrites();
        offWatch();
      };
    },
    onRename: (fn) => renameEvents.subscribe((moves) => moves.forEach((m) => fn(m.to, m.from))),
    onDelete(fn) {
      const offDeletes = deleteEvents.subscribe(fn);
      const offWatch = watch((c) => {
        if (c.path !== '' && c.kind === 'removed') fn(c.path);
      });
      return () => {
        offDeletes();
        offWatch();
      };
    },
  };
  const offUsage = usage.register(events);

  // 6. 연동 설정이 저장된 뒤
  const offIntegration = onIntegrationChange((before: IntegrationSettingsValue, after: IntegrationSettingsValue) => {
    if (stopped) return;
    const urlChanged = URL_KEYS.some((k) => before[k] !== after[k]);
    const refreshed = urlChanged ? feature.refresh() : Promise.resolve();
    if (before.partbankSendUsages !== after.partbankSendUsages) savedSend = after.partbankSendUsages;
    // 기다리지 않는다: 대화상자의 저장이 네트워크를 기다리지 않게. 작업은 동기화 안에서 차례로 돈다.
    if (!before.partbankSendUsages && after.partbankSendUsages) void refreshed.then(() => usage.syncAll());
    else if (before.partbankSendUsages && !after.partbankSendUsages) void refreshed.then(() => usage.disable());
  });

  // 7. 키가 바뀌었다
  const offSecrets = onSecretsChange((status) => {
    if (!stopped) feature.setStatus(status);
  });

  // 8. 대장이 바뀌었다(노트 동기화가 쓴 것은 빼고)
  const offRegistry = sampleEvents.subscribe(() => {
    if (!stopped && noteSyncDepth === 0) usage.scheduleReconcile();
  });

  return () => {
    if (stopped) return;
    stopped = true;
    offRegistry();
    offSecrets();
    offIntegration();
    offUsage();
    usage.stop();
    offProbes();
    offSource();
    if (currentCatalogStore() === store) setPartbankCatalogStore(undefined);
    if (partbank() === feature) setPartbankFeature(undefined);
  };
}
