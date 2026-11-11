import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { notify } from '../labnote/host/toastStore';
import { useSkin, type SkinDeps } from './skins/useSkin';
import { Bubble } from './Bubble';
import type { BubbleActions } from './MessageView';

export type { BubbleActions } from './MessageView';
import { useAssistantSession, type AssistantSession } from './useAssistantSession';
import {
  applySkinVars,
  bubblePlace,
  DRAG_THRESHOLD,
  MOVE_STEP,
  MOVE_STEP_BIG,
  petArea,
  petStore as defaultStore,
  RESIZE_STEP,
  RESIZE_STEP_BIG,
  snapScale,
  type BubbleSize,
  type PetPos,
  type PetStore,
} from './petStore';

type Side = 'above' | 'below';
type GrowX = 'left' | 'right';

/** 자리 안내 글("오른쪽 아래"). 번역 키는 글자 그대로 둔다(카탈로그 검사가 키를 찾는다). */
function areaLabel(pos: PetPos, store: PetStore): string {
  const a = petArea(pos, store.viewport());
  if (a.h === 'middle' && a.v === 'middle') return t('pet.pos.center');
  const h = a.h === 'left' ? t('pet.pos.left') : a.h === 'right' ? t('pet.pos.right') : t('pet.pos.middle');
  const v = a.v === 'top' ? t('pet.pos.top') : a.v === 'bottom' ? t('pet.pos.bottom') : t('pet.pos.middle');
  return t('pet.pos', h, v);
}

const ARROW: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * 편집기 위에 떠 있는 도우미(assistant 명세 §4.1–4.3). App 이 `.shell` 밖의 `#pet-layer` 안에 그린다(대화상자가 열리면
 * DialogLayer 가 그 층에 inert 를 건다). 자리·크기·스프라이트 값은 CSSOM 변수로만 건다(CSP style-src 'self').
 * - 누르기(4px 이하로 움직이고 놓기)는 말풍선을 열고 닫는다. 그보다 멀리 끌면 옮기고, 놓을 때 저장한다(PC 마다, Rust ui.json).
 * - Alt+화살표 8px, Alt+Shift+화살표 32px, Alt+Home 처음 자리. 기본 동작을 막는다(WebView2 에서 Alt+←/→ 는 뒤로·앞으로 가기).
 * - 말풍선 크기: 그림에서 먼 모서리(위로 열면 위, 아래로 열면 아래; 보통 왼쪽, 창 왼쪽에 밀려 붙었으면 오른쪽)의 손잡이를
 *   끌면 바뀌고 놓을 때 저장한다(PC 마다). 손잡이에서 화살표 16px, Shift+화살표 64px, Home·두 번 누르기는 기본 크기.
 *   크기를 바꾸는 동안은 말풍선이 위·아래로 뒤집히지 않는다. 높이는 고른 쪽에 남은 높이까지다.
 * - 숨기면 아무것도 그리지 않는다. 리본 단추와 assistant.toggleVisible 이 다시 보인다.
 * - 대화 갈래(useAssistantSession)는 숨겨도, 말풍선을 닫아도 열린 노트의 실험 폴더를 따른다(폴더가 바뀌면 멈추고 바꾼다).
 */
export function PetLayer(props: {
  store?: PetStore;
  session?: AssistantSession;
  activePath?: string;
  actions?: BubbleActions;
  /** 스킨 읽기(테스트용 가짜 invoke·blob 주소). */
  skinDeps?: SkinDeps;
}) {
  useLang();
  const store = props.store ?? defaultStore;
  const snap = useSyncExternalStore(store.subscribe, store.get);
  const chat = useAssistantSession({ activePath: props.activePath, session: props.session });
  // 이 PC 에서 고른 스킨(ui.json pet.skin). 모르는 id 나 읽기 실패는 기본 스킨이다. 설치한 스킨은 blob: 주소로 그린다.
  const skin = useSkin(snap.skin, props.skinDeps);
  const wrap = useRef<HTMLDivElement>(null);
  const sprite = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bubbleId = useId();
  const [hint, setHint] = useState('');
  // 창 크기와 화면 배율(다른 모니터로 옮기면 바뀐다): 바뀌면 그림 배율과 말풍선 자리를 다시 잡는다
  const [frame, setFrame] = useState(0);
  const drag = useRef<{ id: number; x0: number; y0: number; pos: PetPos; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const grip = useRef<HTMLButtonElement>(null);
  const gripHint = useId();
  // 마지막으로 잡은 말풍선 자리(손잡이 방향과 그쪽에 남은 높이)와, 크기를 바꾸는 동안 붙들어 둘 쪽
  const placed = useRef<{ side: Side; growX: GrowX; maxH: number }>({ side: 'above', growX: 'left', maxH: Infinity });
  const lockSide = useRef<Side | undefined>(undefined);
  const resize = useRef<{ id: number; x0: number; y0: number; from: BubbleSize; growX: GrowX; side: Side } | null>(null);

  // 창 크기에 맞춰 자른다: 처음 그릴 때와 창 크기가 바뀔 때
  useEffect(() => {
    const fit = () => {
      store.clampTo(window.innerWidth, window.innerHeight);
      setFrame((n) => n + 1);
    };
    fit();
    window.addEventListener('resize', fit);
    // 왼쪽 독이 열리거나 닫히거나 넓어지면 창 틀의 왼쪽 끝이 바뀐다: 독 위에 앉아 있던 도우미를 바로 독 밖으로 민다
    // (다음 옮기기나 창 크기 바꾸기를 기다리지 않는다). 독은 늘 붙어 있고, 닫으면 display: none 이라 크기가 0 이 된다.
    const dock = document.querySelector('.sidebar.dock');
    const watch = dock && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : undefined;
    if (dock) watch?.observe(dock);
    return () => {
      window.removeEventListener('resize', fit);
      watch?.disconnect();
    };
  }, [store]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    el.style.setProperty('--pet-x', `${snap.pos.x}px`);
    el.style.setProperty('--pet-y', `${snap.pos.y}px`);
    el.style.setProperty('--pet-scale', String(snapScale(snap.scale, window.devicePixelRatio || 1)));
  }, [snap.pos.x, snap.pos.y, snap.scale, snap.hidden, frame]);

  // 말풍선을 창 안에: 그림 위(자리가 모자라면 아래)로, 가로는 창 틀 안으로 민다. 높이는 고른 쪽에 남은 만큼(CSSOM 변수).
  // 정한 크기는 --bubble-w·--bubble-h 와 data-sized 로 건다. 손잡이 모서리는 data-side·data-grow-x 를 따른다.
  useLayoutEffect(() => {
    const bubble = wrap.current?.querySelector<HTMLElement>('.pet-bubble');
    const pet = button.current;
    if (!snap.open || !bubble || !pet) return;
    if (snap.bubble) {
      bubble.dataset.sized = 'true';
      bubble.style.setProperty('--bubble-w', `${snap.bubble.w}px`);
      bubble.style.setProperty('--bubble-h', `${snap.bubble.h}px`);
    } else {
      delete bubble.dataset.sized;
      bubble.style.removeProperty('--bubble-w');
      bubble.style.removeProperty('--bubble-h');
    }
    bubble.style.removeProperty('--bubble-max-h');
    const r = pet.getBoundingClientRect();
    const size = snap.bubble ?? { w: bubble.offsetWidth, h: bubble.offsetHeight };
    const place = bubblePlace(r, size, { ...store.viewport(), w: window.innerWidth, h: window.innerHeight }, lockSide.current);
    placed.current = { side: place.side, growX: place.growX, maxH: place.maxH };
    bubble.dataset.side = place.side;
    bubble.dataset.growX = place.growX;
    bubble.style.setProperty('--bubble-left', `${place.left}px`);
    bubble.style.setProperty('--bubble-top', `${place.top}px`);
    bubble.style.setProperty('--bubble-bottom', `${place.bottom}px`);
    bubble.style.setProperty('--bubble-max-h', `${place.maxH}px`);
  }, [snap.open, snap.pos.x, snap.pos.y, snap.scale, snap.bubble, skin, frame, store]);

  // 설치한 스킨은 기본 스킨보다 클 수 있다: 그 틀 크기로 자리를 다시 자른다(창 틀 밖으로 나가지 않게)
  useLayoutEffect(() => {
    store.setSkinManifest(skin.manifest);
  }, [skin, store]);

  useLayoutEffect(() => {
    if (sprite.current) applySkinVars(sprite.current, skin.manifest, snap.state, skin.sheetUrl);
  }, [snap.state, snap.hidden, skin]);

  if (snap.hidden) return null;

  // 말풍선의 "숨기기": 다시 켜는 곳을 알림으로 알린다(명령 assistant.toggleVisible 과 같은 글)
  const hide = () => {
    const restore = store.takeRestore();
    store.setHidden(true);
    restore?.();
    notify('info', t('pet.hidden'));
  };
  const close = () => {
    const restore = store.takeRestore();
    store.setOpen(false);
    restore?.();
    // 돌아갈 곳이 없으면(본문에서 단축키로 열었거나 그 요소가 사라졌다) 초점이 곧 사라질 말풍선에 남거나 본문으로
    // 빠지지 않게 도우미로 온다.
    const now = document.activeElement;
    if (!restore || !now || now === document.body || (wrap.current?.contains(now) && now !== button.current)) button.current?.focus();
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, pos: snap.pos, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
    d.moved = true;
    // 오프셋은 오른쪽·아래 끝에서 잰다: 오른쪽으로 끌면 x 가 준다
    store.dragTo(d.pos.x - dx, d.pos.y - dy);
  };
  const endDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (d.moved) {
      suppressClick.current = true;
      store.commit();
    }
  };
  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    store.toggle();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Home') {
      e.preventDefault();
      store.reset();
      setHint(t('pet.resetDone', areaLabel(store.get().pos, store)));
      return;
    }
    const dir = Object.hasOwn(ARROW, e.key) ? ARROW[e.key] : undefined;
    if (!dir) return;
    e.preventDefault();
    const step = e.shiftKey ? MOVE_STEP_BIG : MOVE_STEP;
    store.moveBy(dir[0] * step, dir[1] * step);
    setHint(t('pet.moved', areaLabel(store.get().pos, store)));
  };

  // 말풍선 크기: 지금 그린 크기(기본 크기면 잰 값)에서 시작한다
  const bubbleNow = (): BubbleSize => {
    const cur = store.get().bubble;
    if (cur) return cur;
    const el = wrap.current?.querySelector<HTMLElement>('.pet-bubble');
    return { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
  };
  // 손잡이를 dx·dy 만큼 옮긴 크기. 높이를 바꾸면 고른 쪽에 남은 높이까지다(그 너머는 그려지지 않는다: 보이는 높이에서
  // 시작해 끌 때 헛도는 구간이 없다). 너비만 바꾸면 높이는 그대로 둔다(저장된 높이를 깎지 않는다).
  const grown = (from: BubbleSize, dx: number, dy: number, growX: GrowX, side: Side): BubbleSize => {
    const cap = Math.max(placed.current.maxH, 0);
    return {
      w: from.w + (growX === 'left' ? -dx : dx),
      h: dy === 0 ? from.h : Math.min(Math.min(from.h, cap) + (side === 'above' ? -dy : dy), cap),
    };
  };
  const announceSize = () => {
    const b = store.get().bubble;
    setHint(b ? t('pet.resized', String(b.w), String(b.h)) : t('pet.sizeReset'));
  };
  const resetSize = () => {
    store.resetBubbleSize();
    announceSize();
  };
  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { side, growX } = placed.current;
    resize.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: bubbleNow(), growX, side };
    lockSide.current = side;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGripMove = (e: PointerEvent<HTMLButtonElement>) => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    const next = grown(r.from, e.clientX - r.x0, e.clientY - r.y0, r.growX, r.side);
    store.resizeBubbleTo(next.w, next.h);
  };
  const onGripUp = (e: PointerEvent<HTMLButtonElement>) => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    resize.current = null;
    lockSide.current = undefined;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    store.commitBubble();
    // 놓은 뒤에는 다시 자리를 잡는다(이제 뒤집을 수 있다)
    setFrame((n) => n + 1);
  };
  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Home') {
      e.preventDefault();
      resetSize();
      return;
    }
    const dir = Object.hasOwn(ARROW, e.key) ? ARROW[e.key] : undefined;
    if (!dir) return;
    e.preventDefault();
    const step = e.shiftKey ? RESIZE_STEP_BIG : RESIZE_STEP;
    const { side, growX } = placed.current;
    const next = grown(bubbleNow(), dir[0] * step, dir[1] * step, growX, side);
    store.setBubbleSize(next.w, next.h);
    announceSize();
  };
  const gripNode = (
    <>
      <button
        ref={grip}
        type="button"
        className="pet-bubble-grip"
        aria-label={t('pet.resize')}
        aria-describedby={gripHint}
        title={t('pet.resizeHint')}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={resetSize}
        onKeyDown={onGripKey}
      />
      <span id={gripHint} className="pet-sr">
        {t('pet.resizeHint')}
      </span>
    </>
  );

  // 누르면 할 일을 이름으로: 말풍선이 열려 있으면 "어시스턴트 닫기"
  const label = snap.open ? t('pet.closeAssistant') : t('pet.open');
  return (
    <div ref={wrap} className="pet-wrap" data-open={snap.open}>
      {snap.open && (
        <Bubble
          id={bubbleId}
          onClose={close}
          onHide={hide}
          chat={chat}
          activePath={props.activePath}
          actions={props.actions}
          grip={gripNode}
          sized={snap.bubble !== null}
          onResetSize={() => {
            resetSize();
            grip.current?.focus();
          }}
        />
      )}
      <button
        ref={button}
        type="button"
        className="pet"
        aria-label={label}
        title={`${t('ribbon.withKey', label, 'Ctrl+Shift+Y')} · ${t('pet.moveHint')}`}
        aria-haspopup="dialog"
        aria-expanded={snap.open}
        aria-controls={snap.open ? bubbleId : undefined}
        aria-keyshortcuts="Control+Shift+Y"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span ref={sprite} className="pet-sprite" data-state={snap.state} aria-hidden="true" />
      </button>
      <span className="pet-live" role="status">
        {hint}
      </span>
    </div>
  );
}
