/** 샘플 저장소를 React 에 잇는 훅(계획 Task 7). */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { LabnoteFs } from '@labnoteo/core';
import { useVaultChanges } from '../labnote/panel/useVaultChanges';
import type { AppSettings } from '../labnote/settings';
import type { ListenFn } from '../vault/useVaultEvents';
import { editorConfigFrom, type SampleEditorConfig } from './editorConfig';
import { SAMPLE_FOCUS_REREAD_MS, samples } from './sampleStore';

const subscribe = (fn: () => void) => samples.subscribe(fn);
const snapshot = () => samples.version;

/** 저장소 판 번호. 오르면 다시 그린다. */
export function useSamplesVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * 편집기에 줄 샘플 설정. 설정을 아직 읽지 않았거나 sampleTracking 이 꺼져 있으면 null.
 * 정체성은 판 번호, sampleTracking, customSampleTypes 배열의 정체성에만 달려 있다(설정 객체가 새로 와도 같으면 그대로).
 */
export function useSampleEditorConfig(settings: AppSettings | undefined): SampleEditorConfig | null {
  const version = useSamplesVersion();
  const loaded = settings !== undefined;
  const tracking = settings?.sampleTracking === true;
  const custom = settings?.customSampleTypes;
  return useMemo(
    () => (loaded ? editorConfigFrom(samples, { sampleTracking: tracking, customSampleTypes: custom }) : null),
    // version 은 저장소의 답이 바뀌었다는 표시라 deps 에 둔다(editorConfigFrom 이 store.version 을 읽는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, version, tracking, custom],
  );
}

/**
 * configure (unbind on fs change/unmount) + useVaultChanges({labsamples:true}) + window focus → vaultChanged('all')
 * (at most once per SAMPLE_FOCUS_REREAD_MS; a focus inside the window re-reads once when it ends).
 * 명령과 동기화의 `sampleEvents` → registryChanged 는 저장소가 configure 때 스스로 구독한다(훅 없이도 같게).
 */
export function useSampleStoreWiring(fs: LabnoteFs, settings: AppSettings | undefined, listen?: ListenFn): void {
  const loaded = settings !== undefined;
  const tracking = settings?.sampleTracking === true;
  const custom = settings?.customSampleTypes;
  const folder = settings?.globalSampleFolder;
  useEffect(() => {
    if (!loaded) return;
    samples.configure(fs, { sampleTracking: tracking, customSampleTypes: custom ?? [], globalSampleFolder: folder ?? '' });
  }, [fs, loaded, tracking, custom, folder]);
  // 보관함이 바뀌거나 화면이 내려가면 옛 보관함의 색인과 설정으로 답하지 않게 푼다(새 configure 가 다시 묶는다).
  useEffect(() => () => samples.unbind(fs), [fs]);

  useVaultChanges((paths) => samples.vaultChanged(paths), listen, { labsamples: true });

  const lastFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const reread = () => {
      lastFocus.current = Date.now();
      samples.vaultChanged('all');
    };
    const onFocus = () => {
      const since = lastFocus.current === undefined ? Infinity : Date.now() - lastFocus.current;
      if (since >= SAMPLE_FOCUS_REREAD_MS) {
        reread();
        return;
      }
      // 창 안의 초점은 버리지 않고 창이 끝날 때 한 번 다시 읽는다(labsamples 가 아닌 Global 폴더는 감시가 알리지 않는다).
      trailing ??= setTimeout(() => {
        trailing = undefined;
        reread();
      }, SAMPLE_FOCUS_REREAD_MS - since);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (trailing !== undefined) clearTimeout(trailing);
    };
  }, []);
}
