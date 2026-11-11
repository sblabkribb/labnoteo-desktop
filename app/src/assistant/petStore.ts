import { BUBBLE_MIN, layoutStore as defaultLayout, PET_DEFAULT, type LayoutStore, type PetPrefs } from '../ui/layoutStore';
import { BUILTIN_SKIN, builtinSheetUrl } from './skins/builtin';
import type { SkinManifest, SkinState } from './skins/types';

/**
 * 떠 있는 도우미("pet")의 상태(assistant 명세 §4.2–4.3).
 * - 그림 상태 idle | think | talk | done: done 은 1.6초 뒤 idle 로 돌아간다.
 * - 말풍선 열림과, 명령으로 열었을 때 돌려줄 초점(닫으면 거기로).
 * - 자리: 창의 오른쪽·아래 끝에서 잰 px. 기준은 layoutStore 의 pet(Rust ui.json, PC 마다)이고, 끄는 동안의 자리는 여기만 갖고
 *   있다가 놓을 때(commit) 저장한다. 키보드 이동과 되돌리기는 바로 저장한다. 창 크기에 맞춰 자른 자리는 저장하지 않는다
 *   (창을 다시 키우면 저장된 자리로 돌아온다).
 * - 말풍선 크기: null 은 기본 크기. 정한 크기도 자리와 같은 규칙이다(끄는 동안은 여기만, 놓을 때 저장, 창에 맞춘 자르기는
 *   저장하지 않는다).
 */
export type PetState = SkinState;

export const DONE_MS = 1600;
/** Alt+화살표 한 번, Alt+Shift+화살표 한 번의 이동(px). */
export const MOVE_STEP = 8;
export const MOVE_STEP_BIG = 32;
/** 이만큼(px)보다 멀리 움직여야 끌기다. 그보다 적게 움직이고 놓으면 누르기다. */
export const DRAG_THRESHOLD = 4;
/** 말풍선 크기 조절 손잡이에서 화살표 한 번, Shift+화살표 한 번(px). */
export const RESIZE_STEP = 16;
export const RESIZE_STEP_BIG = 64;

export interface PetPos {
  x: number;
  y: number;
}

export interface BubbleSize {
  w: number;
  h: number;
}

export interface PetSnapshot {
  state: PetState;
  open: boolean;
  pos: PetPos;
  /** 말풍선 크기(px). null 은 기본 크기(너비 22rem, 높이는 내용에 맞춘다). 지금 창에 맞춰 자른 값이다. */
  bubble: BubbleSize | null;
  hidden: boolean;
  scale: 2 | 3;
  skin: string;
}

/**
 * 창 크기와, 도우미가 덮지 않을 창 틀(px): 위는 보기 머리(도구 단추), 왼쪽은 리본, 아래는 상태 표시줄.
 * 틀이 없으면(테스트) 0 이다.
 */
export interface Viewport {
  w: number;
  h: number;
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/** 화면 좌표의 사각형(getBoundingClientRect 와 같은 꼴). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 말풍선과 그림, 말풍선과 창 끝 사이(px). */
export const BUBBLE_GAP = 8;

/** 말풍선이 들어갈 곳: 창에서 창 틀과 BUBBLE_GAP 을 뺀 사각형. */
function bubbleArea(vp: Viewport): Box {
  return {
    left: (vp.left ?? 0) + BUBBLE_GAP,
    top: (vp.top ?? 0) + BUBBLE_GAP,
    right: vp.w - (vp.right ?? 0) - BUBBLE_GAP,
    bottom: vp.h - (vp.bottom ?? 0) - BUBBLE_GAP,
  };
}

/**
 * 말풍선 자리(assistant 명세 §4.2): 그림 위가 기본이고, 위에 자리가 모자라고 아래가 더 넓으면 아래로 뒤집는다.
 * 가로는 그림의 오른쪽 끝에 맞추되 창 틀 안으로 민다. `maxH` 는 고른 쪽에 남은 높이다(대화 칸이 그 안에서 스크롤한다).
 * 위로 열면 `bottom`(창 아래 끝에서 잰 px)을, 아래로 열면 `top` 을 건다: 글이 늘어도 그림 쪽 끝은 그대로다.
 * `growX` 는 너비가 늘 때 움직이는 쪽이다: 보통은 왼쪽(오른쪽 끝이 그림에 붙어 있다), 창 틀 왼쪽에 밀려 붙었으면 오른쪽.
 * 크기 조절 손잡이는 그 쪽과, 위로 열면 위·아래로 열면 아래 모서리에 있다. `side` 를 주면(크기를 바꾸는 동안) 그쪽에 둔다.
 */
export function bubblePlace(
  pet: Box,
  bubble: { w: number; h: number },
  vp: Viewport,
  side?: 'above' | 'below',
): { side: 'above' | 'below'; growX: 'left' | 'right'; left: number; top: number; bottom: number; maxH: number } {
  const area = bubbleArea(vp);
  const above = Math.max(0, pet.top - BUBBLE_GAP - area.top);
  const below = Math.max(0, area.bottom - (pet.bottom + BUBBLE_GAP));
  const chosen = side ?? (bubble.h <= above || above >= below ? 'above' : 'below');
  const maxH = Math.floor(chosen === 'above' ? above : below);
  const anchored = Math.min(pet.right - bubble.w, area.right - bubble.w);
  const left = Math.round(Math.max(area.left, anchored));
  const growX = anchored < area.left ? 'right' : 'left';
  const top = Math.round(pet.bottom + BUBBLE_GAP);
  const bottom = Math.round(vp.h - (pet.top - BUBBLE_GAP));
  return { side: chosen, growX, left, top, bottom, maxH };
}

/** 말풍선 크기의 범위: 가장 작게 BUBBLE_MIN, 가장 크게 창 틀 안. 창이 그보다 작으면 창이 이긴다(창 밖으로 나가지 않는다). */
export function bubbleBounds(vp: Viewport): { minW: number; minH: number; maxW: number; maxH: number } {
  const a = bubbleArea(vp);
  const maxW = Math.max(0, Math.floor(a.right - a.left));
  const maxH = Math.max(0, Math.floor(a.bottom - a.top));
  return { minW: Math.min(BUBBLE_MIN.w, maxW), minH: Math.min(BUBBLE_MIN.h, maxH), maxW, maxH };
}

/** 말풍선 크기를 bubbleBounds 안으로. */
export function clampBubble(size: BubbleSize, vp: Viewport): BubbleSize {
  const b = bubbleBounds(vp);
  const fit = (n: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, n)));
  return { w: fit(size.w, b.minW, b.maxW), h: fit(size.h, b.minH, b.maxH) };
}

/**
 * 화면 배율에 맞춘 그림 배율: 그림 한 칸이 기기 픽셀 정수 개가 되게 한다(150% 에서 3배는 한 칸 4.5 기기 픽셀이라 선 굵기가
 * 4와 5로 번갈아 보인다 → 5 기기 픽셀). 100%·200% 에서는 그대로다.
 */
export function snapScale(scale: number, dpr: number): number {
  if (!(dpr > 0) || !Number.isFinite(dpr)) return scale;
  return Math.max(1, Math.round(scale * dpr)) / dpr;
}

const screenDpr = (): number => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

export interface PetStore {
  get(): PetSnapshot;
  subscribe(fn: () => void): () => void;
  setState(state: PetState): void;
  toggle(): void;
  /** 말풍선을 열거나 닫는다. 열 때 `restore` 를 주면 닫을 때 그것으로 초점을 돌려준다(명령으로 연 경우). */
  setOpen(open: boolean, restore?: () => void): void;
  /** 닫을 때 쓸 초점 돌려주기를 꺼낸다(한 번만). */
  takeRestore(): (() => void) | undefined;
  /** 화면 기준으로 옮긴다(dx > 0 은 오른쪽, dy > 0 은 아래). 뷰포트 안(상태 표시줄·리본·보기 머리 밖)으로 자르고 저장한다. */
  moveBy(dx: number, dy: number): void;
  /** 끄는 중: 오프셋을 그 자리로(자르되 저장하지 않는다). */
  dragTo(x: number, y: number): void;
  /** 끌기를 마쳤다: 지금 자리를 저장한다. */
  commit(): void;
  /** 기본 구석(오른쪽 아래)으로 되돌리고 저장한다. */
  reset(): void;
  /** 창 크기가 바뀌었다: 자리와 말풍선 크기를 그 안(창 틀 밖)으로 자른다(저장하지 않는다). */
  clampTo(w: number, h: number): void;
  /** 말풍선 크기를 끄는 중: 범위 안으로 자르되 저장하지 않는다. */
  resizeBubbleTo(w: number, h: number): void;
  /** 말풍선 크기 끌기를 마쳤다: 지금 크기를 저장한다. */
  commitBubble(): void;
  /** 말풍선 크기를 정하고(범위 안으로) 저장한다(키보드). */
  setBubbleSize(w: number, h: number): void;
  /** 말풍선을 기본 크기로 되돌리고 저장한다. */
  resetBubbleSize(): void;
  /** 지금 그리는 스킨(설치한 스킨은 틀이 96px 까지 크다): 자리 자르기에 그 크기를 쓰고, 바로 다시 자른다(저장하지 않는다). */
  setSkinManifest(skin: SkinManifest): void;
  setHidden(hidden: boolean): void;
  toggleVisible(): void;
  /** 지금 뷰포트(자리 안내에 쓴다). */
  viewport(): Viewport;
  resetForTest(): void;
}

/** 스프라이트 크기(px): 스킨의 틀 크기 × 배율. */
export function petSize(scale: number, skin: SkinManifest = BUILTIN_SKIN, dpr: number = screenDpr()): { w: number; h: number } {
  const s = snapScale(scale, dpr);
  return { w: Math.ceil(skin.frame.width * s), h: Math.ceil(skin.frame.height * s) };
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

/** 창 틀의 크기 토큰(tokens.css). 읽지 못하면 0. */
function token(style: CSSStyleDeclaration, name: string): number {
  const n = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 왼쪽 독(파일·실험 패널과 아래의 보관함 바꾸기)의 오른쪽 끝. 닫혀 있거나, 좁은 창에서 본문 위에 떠서 열리는 서랍이면 0:
 * 도우미가 독 위에 앉아 보관함 바꾸기 같은 단추를 가리지 않게 한다(Alt+Shift+화살표로 옮길 때, visual QA).
 */
function dockRight(): number {
  if (document.documentElement.dataset.leftHidden === 'true') return 0;
  const dock = document.querySelector<HTMLElement>('.sidebar.dock');
  if (!dock || getComputedStyle(dock).position === 'fixed') return 0;
  const r = dock.getBoundingClientRect();
  return r.width > 0 ? r.right : 0;
}

/** 창 틀: 위 머리줄, 왼쪽 리본과 (열려 있으면) 독, 아래 상태 줄을 뺀 곳. */
export const windowViewport = (): Viewport => {
  if (typeof window === 'undefined') return { w: Infinity, h: Infinity };
  const style = getComputedStyle(document.documentElement);
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    top: token(style, '--viewheader-h'),
    left: Math.max(token(style, '--ribbon-w'), dockRight()),
    bottom: token(style, '--statusbar-h'),
    right: 0,
  };
};

/** 오른쪽·아래에서 잰 자리를 창 틀 안으로 자른다. 창이 너무 작으면 오른쪽·아래 틀에 붙인다. */
function clampIn(pos: PetPos, vp: Viewport, size: { w: number; h: number }): PetPos {
  const fit = (n: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(Math.max(lo, hi), n)));
  return {
    x: fit(pos.x, vp.right ?? 0, vp.w - (vp.left ?? 0) - size.w),
    y: fit(pos.y, vp.bottom ?? 0, vp.h - (vp.top ?? 0) - size.h),
  };
}

export function createPetStore(opts: PetStoreOptions = {}): PetStore {
  const layout = opts.layout ?? defaultLayout;
  const viewport = opts.viewport ?? windowViewport;
  const subs = new Set<() => void>();
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  let restore: (() => void) | undefined;
  let dragging = false;
  let resizing = false;
  let manifest: SkinManifest = BUILTIN_SKIN;

  // 저장된 말풍선 크기(창에 맞춰 자르기 전). 창을 다시 키우면 이 크기로 돌아온다.
  const savedBubble = (p: PetPrefs): BubbleSize | null => (p.bubbleW > 0 && p.bubbleH > 0 ? { w: p.bubbleW, h: p.bubbleH } : null);
  const fitBubble = (size: BubbleSize | null, vp: Viewport = viewport()): BubbleSize | null => (size ? clampBubble(size, vp) : null);
  const sameBubble = (a: BubbleSize | null, b: BubbleSize | null) => a === b || (!!a && !!b && a.w === b.w && a.h === b.h);
  const fromLayout = (p: PetPrefs) => ({
    pos: { x: p.x, y: p.y },
    hidden: p.hidden,
    scale: p.scale,
    skin: p.skin,
    bubble: fitBubble(savedBubble(p)),
  });
  let snap: PetSnapshot = { state: 'idle', open: false, ...fromLayout(layout.get().pet) };

  const emit = (patch: Partial<PetSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const fn of [...subs]) fn();
  };

  const clamp = (pos: PetPos, scale = snap.scale): PetPos => clampIn(pos, viewport(), petSize(scale, manifest));

  // 설정 창, Rust 읽기, 다른 창에서 바뀐 값을 따른다(끄는 동안의 자리는 덮지 않는다)
  layout.subscribe((prefs) => {
    const next = fromLayout(prefs.pet);
    const pos = dragging ? snap.pos : clamp(next.pos, next.scale);
    const bubble = resizing || sameBubble(next.bubble, snap.bubble) ? snap.bubble : next.bubble;
    const same =
      pos.x === snap.pos.x &&
      pos.y === snap.pos.y &&
      next.hidden === snap.hidden &&
      next.scale === snap.scale &&
      next.skin === snap.skin &&
      bubble === snap.bubble;
    if (same) return;
    emit({ ...next, pos, bubble, open: next.hidden ? false : snap.open });
  });

  const save = (pos: PetPos) => {
    emit({ pos });
    layout.setPet({ x: pos.x, y: pos.y });
  };
  const saveBubble = (bubble: BubbleSize | null) => {
    resizing = false;
    if (!sameBubble(bubble, snap.bubble)) emit({ bubble });
    layout.setPet({ bubbleW: bubble?.w ?? 0, bubbleH: bubble?.h ?? 0 });
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
      const vp = { ...viewport(), w, h };
      const pos = clampIn(snap.pos, vp, petSize(snap.scale, manifest));
      // 끄는 중이면 끄는 크기를, 아니면 저장된 크기를 새 창에 맞춘다(창을 다시 키우면 저장된 크기로 돌아온다)
      const fitted = fitBubble(resizing ? snap.bubble : savedBubble(layout.get().pet), vp);
      const moved = pos.x !== snap.pos.x || pos.y !== snap.pos.y;
      const resized = !sameBubble(fitted, snap.bubble);
      if (moved || resized) emit({ ...(moved ? { pos } : {}), ...(resized ? { bubble: fitted } : {}) });
    },
    resizeBubbleTo(w, h) {
      resizing = true;
      const bubble = clampBubble({ w, h }, viewport());
      if (!sameBubble(bubble, snap.bubble)) emit({ bubble });
    },
    commitBubble() {
      if (!resizing) return;
      saveBubble(snap.bubble);
    },
    setBubbleSize(w, h) {
      saveBubble(clampBubble({ w, h }, viewport()));
    },
    resetBubbleSize() {
      saveBubble(null);
    },
    setSkinManifest(skin) {
      if (skin.frame.width === manifest.frame.width && skin.frame.height === manifest.frame.height) {
        manifest = skin;
        return;
      }
      manifest = skin;
      if (dragging) return;
      const pos = clamp(snap.pos);
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
      resizing = false;
      manifest = BUILTIN_SKIN;
      snap = { state: 'idle', open: false, ...fromLayout(layout.get().pet) };
      for (const fn of [...subs]) fn();
    },
  };
  return store;
}

/** 앱의 하나뿐인 도우미 상태. */
export const petStore: PetStore = createPetStore();
