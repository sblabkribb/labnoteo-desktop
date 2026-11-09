import { useSyncExternalStore } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

/**
 * 앱 전체의 화면 배치(왼쪽·오른쪽 사이드바 너비와 열림, 탭, 행 밀도, 시스템 파일 표시).
 * 기준은 Rust 의 `ui.json`(app config 의 settings.json 옆, src-tauri/src/ui_prefs.rs)이고,
 * `localStorage['labnoteo.ui.layout']` 은 첫 프레임용 거울일 뿐이다(public/theme-boot.js 가 건다).
 * 창은 숨긴 채 뜨고, useTheme 은 `ready()` 가 끝난 뒤에 창을 보인다: 첫 프레임에 너비가 튀지 않는다.
 * DOM 에는 CSSOM(`style.setProperty`)과 data- 속성으로만 건다(CSP style-src 'self').
 * 규칙(범위, 기본값)은 ui_prefs.rs 와 theme-boot.js 가 같다.
 */

export type LeftTab = 'files' | 'experiments' | 'samples';
export type RightTab = 'outline' | 'links';
export type Density = 'comfortable' | 'compact';

export interface UiPrefs {
  leftWidth: number;
  leftHidden: boolean;
  leftTab: LeftTab;
  rightWidth: number;
  rightOpen: boolean;
  rightTab: RightTab;
  density: Density;
  showSystemFiles: boolean;
}

export const LAYOUT_KEY = 'labnoteo.ui.layout';
export const WRITE_DEBOUNCE_MS = 300;
export const LEFT_RANGE = { min: 200, max: 480, default: 272 } as const;
export const RIGHT_RANGE = { min: 220, max: 480, default: 280 } as const;

export const DEFAULT_PREFS: Readonly<UiPrefs> = Object.freeze({
  leftWidth: LEFT_RANGE.default,
  leftHidden: false,
  leftTab: 'files',
  rightWidth: RIGHT_RANGE.default,
  rightOpen: false,
  rightTab: 'outline',
  density: 'comfortable',
  showSystemFiles: false,
});

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function width(v: unknown, range: { min: number; max: number; default: number }): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(v)));
}

const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  allowed.includes(v as T) ? (v as T) : d;

/** 아무 값이나 받아 유효한 UiPrefs 로: 범위 밖 너비는 자르고, 모르는 값은 기본값, 모르는 필드는 버린다. */
export function normalizePrefs(raw: unknown): UiPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    leftWidth: width(o.leftWidth, LEFT_RANGE),
    leftHidden: flag(o.leftHidden, d.leftHidden),
    leftTab: oneOf(o.leftTab, ['files', 'experiments', 'samples'] as const, d.leftTab),
    rightWidth: width(o.rightWidth, RIGHT_RANGE),
    rightOpen: flag(o.rightOpen, d.rightOpen),
    rightTab: oneOf(o.rightTab, ['outline', 'links'] as const, d.rightTab),
    density: oneOf(o.density, ['comfortable', 'compact'] as const, d.density),
    showSystemFiles: flag(o.showSystemFiles, d.showSystemFiles),
  };
}

/** 너비는 CSSOM 변수로, 열림과 밀도는 data- 속성으로 건다. style 속성 문자열은 쓰지 않는다. */
export function applyToDom(prefs: UiPrefs, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--side-w', `${prefs.leftWidth}px`);
  root.style.setProperty('--right-w', `${prefs.rightWidth}px`);
  root.setAttribute('data-left-hidden', String(prefs.leftHidden));
  root.setAttribute('data-right-open', String(prefs.rightOpen));
  root.setAttribute('data-density', prefs.density);
}

export function readUiPrefs(invoke: Invoke = tauriInvoke): Promise<UiPrefs> {
  return invoke('ui_prefs_read').then(normalizePrefs);
}

export function writeUiPrefs(prefs: UiPrefs, invoke: Invoke = tauriInvoke): Promise<UiPrefs> {
  return invoke('ui_prefs_write', { prefs: { ...prefs } }).then((v) => (v == null ? prefs : normalizePrefs(v)));
}

export interface LayoutStore {
  get(): UiPrefs;
  subscribe(fn: (prefs: UiPrefs) => void): () => void;
  update(patch: Partial<UiPrefs>): void;
  /** 왼쪽 독을 숨기거나 보인다(리본 단추, Ctrl+\, 팔레트). */
  toggleLeft(): void;
  /** 오른쪽 사이드바를 열거나 닫는다. */
  toggleRight(): void;
  load(invoke?: Invoke): Promise<UiPrefs>;
  /** 진행 중인 load 가 끝나면(성공이든 실패든) 풀린다. load 가 없었으면 바로 풀린다. */
  ready(): Promise<void>;
  /** 테스트용: 기다리던 쓰기를 버리고 기본값으로 돌리고, <html> 에 건 변수와 속성을 걷는다(Rust 에도 거울에도 쓰지 않는다). */
  resetForTest(): void;
}

export interface LayoutStoreOptions {
  /** 저장소에 닿기만 해도 던지는 WebView 가 있다: 함수로 받아 매번 try 안에서 부른다. */
  storage?: () => Storage;
  invoke?: Invoke;
}

export function createLayoutStore(opts: LayoutStoreOptions = {}): LayoutStore {
  const storage = opts.storage ?? (() => localStorage);
  let invoke: Invoke = opts.invoke ?? tauriInvoke;
  const readMirror = (): UiPrefs => {
    try {
      const raw = storage().getItem(LAYOUT_KEY);
      return normalizePrefs(raw ? JSON.parse(raw) : null);
    } catch {
      return { ...DEFAULT_PREFS };
    }
  };
  const writeMirror = (p: UiPrefs) => {
    try {
      storage().setItem(LAYOUT_KEY, JSON.stringify(p));
    } catch {
      // 거울을 못 써도 Rust 가 기준이다
    }
  };

  let state = readMirror();
  const subs = new Set<(p: UiPrefs) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  // load 가 시작된 뒤 사람이 바꾼 것이 있으면 load 결과로 덮지 않는다
  let changedSinceLoad = false;

  const set = (next: UiPrefs) => {
    state = next;
    applyToDom(state);
    writeMirror(state);
    for (const fn of [...subs]) fn(state);
  };

  const store: LayoutStore = {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    update(patch) {
      changedSinceLoad = true;
      set(normalizePrefs({ ...state, ...patch }));
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        writeUiPrefs(state, invoke).catch(() => undefined);
      }, WRITE_DEBOUNCE_MS);
    },
    toggleLeft() {
      store.update({ leftHidden: !state.leftHidden });
    },
    toggleRight() {
      store.update({ rightOpen: !state.rightOpen });
    },
    load(withInvoke) {
      if (withInvoke) invoke = withInvoke;
      changedSinceLoad = false;
      const p = readUiPrefs(invoke)
        .then((rust) => {
          if (!changedSinceLoad) set(rust);
        })
        .catch(() => {
          if (!changedSinceLoad) set(state); // Rust 를 못 읽었다: 거울(또는 기본값)을 건다
        })
        .then(() => state);
      pending = p;
      return p;
    },
    ready: () => pending.then(() => undefined),
    resetForTest() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      changedSinceLoad = false;
      state = { ...DEFAULT_PREFS };
      // DOM 에 건 것도 걷어 낸다: 처음 뜬 문서처럼(style 속성도 data- 속성도 없다)
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.style.removeProperty('--side-w');
        root.style.removeProperty('--right-w');
        if (root.getAttribute('style') === '') root.removeAttribute('style');
        for (const a of ['data-left-hidden', 'data-right-open', 'data-density', 'data-resizing']) root.removeAttribute(a);
      }
      for (const fn of [...subs]) fn(state);
    },
  };
  return store;
}

/** 앱의 하나뿐인 배치 저장소. main.tsx 가 그리기 전에 load() 를 시작한다. */
export const layoutStore: LayoutStore = createLayoutStore();

/** React 에서 배치를 읽는다: 바뀌면 다시 그린다. */
export function useLayout(store: LayoutStore = layoutStore): UiPrefs {
  return useSyncExternalStore(store.subscribe, store.get);
}
