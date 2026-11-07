/**
 * 앱의 샘플 데이터가 편집기에 닿는 길(계획 D8). 편집기는 `samplesSlot` Compartment 안의 `sampleEditorConfig` 퍼싯으로
 * 이 설정을 받고, 노트 경로는 `sampleNotePath` 로 받는다. 설정의 정체성은 저장소 판 번호(D11)나 샘플 설정이 바뀔 때만 바뀐다.
 */
import { Facet } from '@codemirror/state';
import type { KnownSampleIds } from '../labnote/port/sampleIdIndex';
import type { AppSettings } from '../labnote/settings';
import type { samples as SampleStore } from './sampleStore';
import { sampleTypesFor } from './types';

export interface SampleEditorConfig {
  /** sampleTracking && README flag (D11). */
  enabled(path: string): boolean;
  types: readonly string[];
  known(path: string): KnownSampleIds | undefined;
  version: number;
}

export const sampleEditorConfig = Facet.define<SampleEditorConfig | null, SampleEditorConfig | null>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : null),
});

/** Editor 가 imageLoader 옆에서 준다. 없으면 ''. */
export const sampleNotePath = Facet.define<string, string>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : ''),
});

/**
 * 지금 저장소로 편집기 설정을 만든다. sampleTracking 이 꺼져 있으면 null.
 * `customSampleTypes` 를 주면 종류는 그것으로 정한다(저장소가 새 설정으로 다시 묶이기 전에도 맞도록).
 */
export function editorConfigFrom(
  store: typeof SampleStore,
  settings: Pick<AppSettings, 'sampleTracking'> & Partial<Pick<AppSettings, 'customSampleTypes'>>,
): SampleEditorConfig | null {
  if (!settings.sampleTracking) return null;
  const types = settings.customSampleTypes !== undefined ? sampleTypesFor({ customSampleTypes: settings.customSampleTypes }) : store.types();
  return {
    enabled: (path) => store.trackingFor(path),
    types,
    known: (path) => store.known(path),
    version: store.version,
  };
}
