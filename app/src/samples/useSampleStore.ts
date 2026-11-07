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
 * configure + useVaultChanges({labsamples:true}) + window focus → vaultChanged('all') (at most once per SAMPLE_FOCUS_REREAD_MS).
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

  useVaultChanges((paths) => samples.vaultChanged(paths), listen, { labsamples: true });

  const lastFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (lastFocus.current !== undefined && now - lastFocus.current < SAMPLE_FOCUS_REREAD_MS) return;
      lastFocus.current = now;
      samples.vaultChanged('all');
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}
