/**
 * 샘플 저장소(계획 Task 7, D11): 보관함 하나의 `SampleIdIndex`(알려진 ID)와 `SampleTracking`(README 의 sample_tracking)을
 * 들고, 화면에 보이는 것이 바뀔 때만 판 번호(`version`)를 올린다. 편집기 설정(editorConfig.ts)과 패널이 이 번호를 본다.
 *
 * 판 번호가 오르는 때:
 * - 묶은 fs 나 샘플 설정(추적 스위치, Global 폴더)이 바뀌었다;
 * - README 캐시가 버려졌다(`SampleTracking` 의 onChange), 또는 처음 읽은 README 가 설정만의 답과 다르다;
 * - 색인이 다시 읽은 뒤, 지금까지 물어본 노트 하나라도 `KnownSampleIds` 가 ids, aliases, discarded 에서 달라졌다(`sameKnown`).
 *   아무것도 보이게 바뀌지 않은 동기화는 열린 편집기를 다시 구성하지 않는다.
 */
import type { LabnoteFs } from '@labnoteo/core';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { SampleIdIndex, type KnownSampleIds } from '../labnote/port/sampleIdIndex';
import type { AppSettings } from '../labnote/settings';
import { isRegistryPath, normalizeSampleFolder, sampleEvents } from './env';
import { SampleTracking } from './tracking';
import { sampleTypesFor } from './types';

export type SampleStoreSettings = Pick<AppSettings, 'sampleTracking' | 'customSampleTypes' | 'globalSampleFolder'>;

/** 창이 초점을 다시 얻으면 모든 대장을 다시 읽는다: 이만큼에 한 번까지. */
export const SAMPLE_FOCUS_REREAD_MS = 5000;

const NO_TYPES: string[] = [];

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) return false;
  return true;
}

/** ids, aliases, discarded 가 같은가(version 은 보지 않는다). 둘 다 undefined 면 같다. */
export function sameKnown(a: KnownSampleIds | undefined, b: KnownSampleIds | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.ids.size !== b.ids.size) return false;
  for (const id of a.ids) if (!b.ids.has(id)) return false;
  return sameMap(a.aliases, b.aliases) && sameMap(a.discarded, b.discarded);
}

/** 확장자가 없는 이름: 폴더일 수 있다(폴더째 지워지거나 옮겨졌다). */
const maybeFolder = (p: string) => !/\.[^/.]+$/.test(p);

let fs: LabnoteFs | undefined;
let settings: SampleStoreSettings | undefined;
let index: SampleIdIndex | undefined;
let tracking: SampleTracking | undefined;
let version = 0;
/** 물어본 노트 경로 → 마지막으로 견준 답. 색인이 다시 읽으면 이것과 견준다. */
let asked = new Map<string, KnownSampleIds | undefined>();
/** 처음 README 읽기를 기다려 설정만의 답과 견주기 시작한 실험 폴더. README 캐시가 버려지면 비운다. */
let checkedDirs = new Set<string>();
const listeners = new Set<() => void>();
let offEvents: (() => void) | undefined;

function bump(): void {
  version++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error('[samples] listener failed', e);
    }
  }
}

const globalFolder = () => normalizeSampleFolder(settings?.globalSampleFolder);
const types = (): string[] => (settings ? sampleTypesFor(settings) : NO_TYPES);

function onIndexChange(own: SampleIdIndex): void {
  if (own !== index) return; // 다시 묶기 전의 색인이 늦게 끝났다
  let changed = false;
  for (const [path, prev] of asked) {
    const next = own.knownFor(path);
    if (!sameKnown(prev, next)) changed = true;
    asked.set(path, next);
  }
  if (changed) bump();
}

function build(nextFs: LabnoteFs): void {
  const own: SampleIdIndex = new SampleIdIndex(nextFs, {
    globalFolder,
    types,
    onChange: () => onIndexChange(own),
  });
  const ownTracking: SampleTracking = new SampleTracking(nextFs, () => {
    if (ownTracking !== tracking) return;
    checkedDirs = new Set();
    bump();
  });
  index = own;
  tracking = ownTracking;
  asked = new Map();
  checkedDirs = new Set();
}

export const samples = {
  /** (Re)binds to a vault/settings. A new fs builds a new SampleIdIndex and SampleTracking. */
  configure(nextFs: LabnoteFs, next: SampleStoreSettings): void {
    offEvents ??= sampleEvents.subscribe((paths) => samples.registryChanged(paths));
    const prev = settings;
    settings = next;
    if (nextFs !== fs || !index || !prev) {
      fs = nextFs;
      build(nextFs);
      bump();
      return;
    }
    if (normalizeSampleFolder(prev.globalSampleFolder) !== globalFolder()) {
      // 노트가 보는 폴더 묶음이 달라졌다: 색인을 새로 만든다(옛 폴더의 읽은 결과는 쓸모없다).
      build(nextFs);
      bump();
      return;
    }
    // 종류가 바뀌면 다시 읽는다. 보이는 것이 달라질 때만 onIndexChange 가 판을 올린다.
    if (sampleTypesFor(prev).join('\n') !== sampleTypesFor(next).join('\n')) index.invalidate();
    if (prev.sampleTracking !== next.sampleTracking) bump();
  },

  get version(): number {
    return version;
  },

  /** configure 를 한 번이라도 불렀다(resetForTest 전까지). */
  get configured(): boolean {
    return index !== undefined;
  },

  /** sampleTracking && README flag. 처음 README 를 읽기 전에는 설정만으로 답하고, 읽은 답이 다르면 판 번호를 올린다. */
  trackingFor(path: string | undefined): boolean {
    if (!settings || !tracking) return false;
    const own = tracking;
    const answer = own.on(settings.sampleTracking, path);
    const dir = path ? getExperimentDir(path) : undefined;
    if (settings.sampleTracking && dir && !checkedDirs.has(dir)) {
      checkedDirs.add(dir);
      void own.ready(true, path).then((read) => {
        if (own === tracking && settings?.sampleTracking && read !== answer) bump();
      });
    }
    return answer;
  },

  /** For writes: awaits the README read, then answers. */
  ready(path: string | undefined): Promise<boolean> {
    if (!settings || !tracking) return Promise.resolve(false);
    return tracking.ready(settings.sampleTracking, path);
  },

  known(path: string): KnownSampleIds | undefined {
    if (!index) return undefined;
    const k = index.knownFor(path);
    if (!asked.has(path)) asked.set(path, k);
    return k;
  },

  types(): readonly string[] {
    return types();
  },

  /** Watcher paths or 'all': registry JSON → index.fileChanged; README.labnote.md → tracking.invalidate; 'all' → both reset. */
  vaultChanged(paths: readonly string[] | 'all'): void {
    if (!index || !tracking) return;
    if (paths === 'all') {
      index.invalidate();
      tracking.invalidate('all');
      return;
    }
    const g = globalFolder();
    let folder = false;
    for (const p of paths) {
      if (isRegistryPath(p, g)) index.fileChanged(p);
      else if (maybeFolder(p)) folder = true;
    }
    if (folder) index.invalidate();
    // 노트 경로는 README 캐시에 걸리지 않는다. README 경로나 그 위 폴더 경로는 그 README 를 버린다.
    tracking.invalidate(paths);
  },

  /** Paths written by sync or a command (files → fileChanged; folders → index.invalidate()). */
  registryChanged(paths?: readonly string[]): void {
    if (!index) return;
    if (!paths) {
      index.invalidate();
      return;
    }
    let folder = false;
    for (const p of paths) {
      if (p.toLowerCase().endsWith('.json')) index.fileChanged(p);
      else folder = true;
    }
    if (folder) index.invalidate();
  },

  /** Fires after version bumps. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },

  resetForTest(): void {
    offEvents?.();
    offEvents = undefined;
    fs = undefined;
    settings = undefined;
    index = undefined;
    tracking = undefined;
    version = 0;
    asked = new Map();
    checkedDirs = new Set();
    listeners.clear();
  },
};
