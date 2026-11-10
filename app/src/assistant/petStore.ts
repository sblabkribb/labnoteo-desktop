import { layoutStore as defaultLayout, PET_DEFAULT, type LayoutStore, type PetPrefs } from '../ui/layoutStore';
import { BUILTIN_SKIN, builtinSheetUrl } from './skins/builtin';
import type { SkinManifest, SkinState } from './skins/types';

/**
 * 떠 있는 도우미("pet")의 상태(assistant 명세 §4.2–4.3).
 * - 그림 상태 idle | think | talk | done: done 은 1.6초 뒤 idle 로 돌아간다.
 * - 말풍선 열림과, 명령으로 열었을 때 돌려줄 초점(닫으면 거기로).
 * - 자리: 창의 오른쪽·아래 끝에서 잰 px. 기준은 layoutStore 의 pet(Rust ui.json, PC 마다)이고, 끄는 동안의 자리는 여기만 갖고
 *   있다가 놓을 때(commit) 저장한다. 키보드 이동과 되돌리기는 바로 저장한다. 창 크기에 맞춰 자른 자리는 저장하지 않는다
 *   (창을 다시 키우면 저장된 자리로 돌아온다).
 */
export type PetState = SkinState;

export const DONE_MS = 1600;
/** Alt+화살표 한 번, Alt+Shift+화살표 한 번의 이동(px). */
export const MOVE_STEP = 8;
export const MOVE_STEP_BIG = 32;
/** 이만큼(px)보다 멀리 움직여야 끌기다. 그보다 적게 움직이고 놓으면 누르기다. */
export const DRAG_THRESHOLD = 4;

export interface PetPos {
  x: number;
  y: number;
}

export interface PetSnapshot {
  state: PetState;
  open: boolean;
  pos: PetPos;
  hidden: boolean;
  scale: 2 | 3;
  skin: string;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface PetStore {
  get(): PetSnapshot;
  subscribe(fn: () => void): () => void;
  setState(state: PetState): void;
  toggle(): void;
  /** 말풍선을 열거나 닫는다. 열 때 `restore` 를 주면 닫을 때 그것으로 초점을 돌려준다(명령으로 연 경우). */
  setOpen(open: boolean, restore?: () => void): void;
  /** 닫을 때 쓸 초점 돌려주기를 꺼낸다(한 번만). */
  takeRestore(): (() => void) | undefined;
  /** 화면 기준으로 옮긴다(dx > 0 은 오른쪽, dy > 0 은 아래). 뷰포트 안으로 자르고 저장한다. */
  moveBy(dx: number, dy: number): void;
  /** 끄는 중: 오프셋을 그 자리로(자르되 저장하지 않는다). */
  dragTo(x: number, y: number): void;
  /** 끌기를 마쳤다: 지금 자리를 저장한다. */
  commit(): void;
  /** 기본 구석(오른쪽 아래)으로 되돌리고 저장한다. */
  reset(): void;
  /** 창 크기가 바뀌었다: 그 안으로 자른다(저장하지 않는다). */
  clampTo(w: number, h: number): void;
  setHidden(hidden: boolean): void;
  toggleVisible(): void;
  /** 지금 뷰포트(자리 안내에 쓴다). */
  viewport(): Viewport;
  resetForTest(): void;
}

/** 스프라이트 한 변(px): 지금은 기본 스킨의 틀 크기 × 배율. */
export function petSize(scale: number, skin: SkinManifest = BUILTIN_SKIN): { w: number; h: number } {
  return { w: skin.frame.width * scale, h: skin.frame.height * scale };
}

/** 자리가 창의 어디쯤인지(aria-live 안내용): 오프셋은 오른쪽·아래에서 잰다. */
export function petArea(pos: PetPos, vp: Viewport): { h: 'left' | 'middle' | 'right'; v: 'top' | 'middle' | 'bottom' } {
  const third = (n: number, total: number) => (n < total / 3 ? 0 : n > (total * 2) / 3 ? 2 : 1);
  const h = (['right', 'middle', 'left'] as const)[third(pos.x, vp.w)];
  const v = (['bottom', 'middle', 'top'] as const)[third(pos.y, vp.h)];
  return { h, v };
}

/**
 * 스킨과 상태의 스프라이트 값을 CSSOM 변수로 건다(CSP style-src 'self': style 속성 글자는 쓰지 않는다).
 * CSS(.pet-sprite)는 steps(var(--pet-frames)) 로 시트를 한 칸씩 넘긴다.
 */
export function applySkinVars(
  el: HTMLElement,
  skin: SkinManifest,
  state: PetState,
  sheetUrl: (state: PetState) => string = builtinSheetUrl,
): void {
  const spec = skin.states[state];
  el.style.setProperty('--pet-sheet', `url("${sheetUrl(state)}")`);
  el.style.setProperty('--pet-w', `${skin.frame.width}px`);
  el.style.setProperty('--pet-h', `${skin.frame.height}px`);
  el.style.setProperty('--pet-frames', String(spec.frames));
  el.style.setProperty('--pet-dur', `${Math.round((spec.frames / spec.fps) * 1000)}ms`);
}

export interface PetStoreOptions {
  layout?: LayoutStore;
  viewport?: () => Viewport;
}

const windowViewport = (): Viewport =>
  typeof window === 'undefined' ? { w: Infinity, h: Infinity } : { w: window.innerWidth, h: window.innerHeight };

export function createPetStore(opts: PetStoreOptions = {}): PetStore {
  const layout = opts.layout ?? defaultLayout;
  const viewport = opts.viewport ?? windowViewport;
  const subs = new Set<() => void>();
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  let restore: (() => void) | undefined;
  let dragging = false;

  const fromLayout = (p: PetPrefs) => ({ pos: { x: p.x, y: p.y }, hidden: p.hidden, scale: p.scale, skin: p.skin });
  let snap: PetSnapshot = { state: 'idle', open: false, ...fromLayout(layout.get().pet) };

  const emit = (patch: Partial<PetSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const fn of [...subs]) fn();
  };

  const clamp = (pos: PetPos, scale = snap.scale): PetPos => {
    const vp = viewport();
    const size = petSize(scale);
    const fit = (n: number, max: number) => Math.round(Math.min(Math.max(0, max), Math.max(0, n)));
    return { x: fit(pos.x, vp.w - size.w), y: fit(pos.y, vp.h - size.h) };
  };

  // 설정 창, Rust 읽기, 다른 창에서 바뀐 값을 따른다(끄는 동안의 자리는 덮지 않는다)
  layout.subscribe((prefs) => {
    const next = fromLayout(prefs.pet);
    const pos = dragging ? snap.pos : clamp(next.pos, next.scale);
    const same =
      pos.x === snap.pos.x && pos.y === snap.pos.y && next.hidden === snap.hidden && next.scale === snap.scale && next.skin === snap.skin;
    if (same) return;
    emit({ ...next, pos, open: next.hidden ? false : snap.open });
  });

  const save = (pos: PetPos) => {
    emit({ pos });
    layout.setPet({ x: pos.x, y: pos.y });
  };

  const store: PetStore = {
    get: () => snap,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    setState(state) {
      if (doneTimer !== undefined) clearTimeout(doneTimer);
      doneTimer = undefined;
      if (state === 'done')
        doneTimer = setTimeout(() => {
          doneTimer = undefined;
          emit({ state: 'idle' });
        }, DONE_MS);
      if (state !== snap.state) emit({ state });
    },
    toggle() {
      store.setOpen(!snap.open);
    },
    setOpen(open, back) {
      restore = open ? back : restore;
      if (open !== snap.open) emit({ open });
    },
    takeRestore() {
      const r = restore;
      restore = undefined;
      return r;
    },
    moveBy(dx, dy) {
      save(clamp({ x: snap.pos.x - dx, y: snap.pos.y - dy }));
    },
    dragTo(x, y) {
      dragging = true;
      const pos = clamp({ x, y });
      if (pos.x !== snap.pos.x || pos.y !== snap.pos.y) emit({ pos });
    },
    commit() {
      dragging = false;
      save(snap.pos);
    },
    reset() {
      dragging = false;
      save(clamp({ x: PET_DEFAULT.x, y: PET_DEFAULT.y }));
    },
    clampTo(w, h) {
      const size = petSize(snap.scale);
      const fit = (n: number, max: number) => Math.round(Math.min(Math.max(0, max), Math.max(0, n)));
      const pos = { x: fit(snap.pos.x, w - size.w), y: fit(snap.pos.y, h - size.h) };
      if (pos.x !== snap.pos.x || pos.y !== snap.pos.y) emit({ pos });
    },
    setHidden(hidden) {
      if (hidden) store.setOpen(false);
      layout.setPet({ hidden });
    },
    toggleVisible() {
      store.setHidden(!snap.hidden);
    },
    viewport,
    resetForTest() {
      if (doneTimer !== undefined) clearTimeout(doneTimer);
      doneTimer = undefined;
      restore = undefined;
      dragging = false;
      snap = { state: 'idle', open: false, ...fromLayout(layout.get().pet) };
      for (const fn of [...subs]) fn();
    },
  };
  return store;
}

/** 앱의 하나뿐인 도우미 상태. */
export const petStore: PetStore = createPetStore();
