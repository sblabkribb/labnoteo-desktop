import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Bubble } from '../assistant/Bubble';
import { applySkinVars, BUBBLE_GAP, DRAG_THRESHOLD, snapScale } from '../assistant/petStore';
import { BUILTIN_SKIN_ID } from '../assistant/skins/builtin';
import { useSkin, type SkinDeps } from '../assistant/skins/useSkin';
import { applyHtmlLang, setLang } from '../i18n/lang';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { growWindow, type Rect } from './geometry';
import { MENU_ITEMS, runMenuAction, type MenuAction, type MenuDeps } from './menuActions';
import type { PetIpc } from './petIpc';
import { clampText, EVT, parseState, type StateEvent } from './protocol';
import { createRemote } from './remote';

/** Logical size of the toast bubble in px; Rust's `size()` in pet/window.rs uses the same numbers. The panel's size comes from Rust. */
const TOAST = { w: 240, h: 72 } as const;
/** What the panel opens at before the window has said (it answers with the saved, clamped size). Same as PANEL_DEFAULT in window.rs. */
const PANEL_FALLBACK: Panel = { w: 360, h: 440, minW: 300, minH: 340, maxW: 640, maxH: 900 };
const RESIZE_STEP = 16;
const RESIZE_STEP_BIG = 64;
const ARROW: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const TOAST_MS = 6000;
const TOAST_TEXT_MAX = 300;

interface Panel {
  w: number;
  h: number;
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}

interface Geo {
  sprite: Rect;
  areas: Rect[];
  scale: number;
  panel: Panel;
}

type Mode = 'toast' | 'panel';
interface View {
  mode: Mode;
  side: 'above' | 'below';
  align: 'left' | 'right';
}

export interface PetAppProps {
  ipc: PetIpc;
  /** Skin loading hooks (blob URLs); `invoke` is always the page's own. */
  skinDeps?: Pick<SkinDeps, 'urls'>;
  /** Whether a sprite sheet can be drawn at all; false for the built-in skin closes the window. */
  canDraw?: (url: string) => Promise<boolean>;
  newId?: () => string;
  /** How long a call to the main window waits (tests shorten it). */
  callTimeoutMs?: number;
}

/** The skin loader's own invoke shape (kept here so the pet page imports nothing from the integrations code). */
type InvokeFn = NonNullable<SkinDeps['invoke']>;

const defaultNewId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const defaultCanDraw = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A panel size and its bounds from the window, or null when the answer is not shaped right. */
const asPanel = (v: unknown): Panel | null => {
  const p = v as Partial<Panel> | null;
  return p && num(p.w) && num(p.h) && num(p.minW) && num(p.minH) && num(p.maxW) && num(p.maxH) ? (p as Panel) : null;
};

const asGeo = (v: unknown): Geo | null => {
  const g = v as { sprite?: Rect; areas?: Rect[]; scale?: number; panel?: unknown } | null;
  if (!g || typeof g.scale !== 'number' || !g.sprite || !Array.isArray(g.areas)) return null;
  return { sprite: g.sprite, areas: g.areas, scale: g.scale, panel: asPanel(g.panel) ?? PANEL_FALLBACK };
};

/**
 * The desktop assistant: the sprite, a drag handle, a three-item menu, a short answer toast and the assistant panel itself
 * (the same Bubble the app has always drawn). The conversation and every action run in the main window (remote.ts).
 */
export function PetApp({ ipc, skinDeps, canDraw = defaultCanDraw, newId = defaultNewId, callTimeoutMs }: PetAppProps) {
  useLang();
  const [st, setSt] = useState<StateEvent | null>(null);
  const [quiet, setQuietState] = useState(false);
  const [openLocal, setOpenLocal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<((ok: boolean) => void) | null>(null);
  const [panel, setPanel] = useState<Panel>(PANEL_FALLBACK);
  const bubbleId = useId();
  const gripHint = useId();
  const sprite = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const resize = useRef<{ id: number; x: number; y: number; w: number; h: number } | null>(null);
  const sizing = useRef<{ busy: boolean; next: { w: number; h: number; commit: boolean } | null }>({ busy: false, next: null });
  const lastMode = useRef<Mode | null>(null);
  const failed = useRef(false);
  const seq = useRef(-1);

  const remote = useMemo(
    () =>
      createRemote({
        ipc,
        newId,
        timeoutMs: callTimeoutMs,
        confirmClear: () => new Promise<boolean>((resolve) => setConfirm(() => resolve)),
      }),
    [ipc, newId, callTimeoutMs],
  );
  useEffect(() => () => remote.dispose(), [remote]);
  const chat = useSyncExternalStore(remote.subscribe, remote.get);

  const invoke = useCallback<InvokeFn>((cmd, args) => ipc.invoke(cmd, args) as Promise<never>, [ipc]);
  const deps = useMemo(() => ({ invoke, urls: skinDeps?.urls }), [invoke, skinDeps?.urls]);
  const skin = useSkin(st?.skin ?? BUILTIN_SKIN_ID, deps);
  const open = openLocal;

  // Events in: validated, dropped on anything wrong. The snapshot is asked for only once the listeners exist.
  useEffect(() => {
    let live = true;
    const offs: Array<() => void> = [];
    const on = (name: string, fn: (payload: unknown) => void) => ipc.listen(name, fn).then((off) => (live ? void offs.push(off) : off()));
    void Promise.all([
      on(EVT.state, (p) => {
        const ev = parseState(p);
        if (!ev || ev.seq <= seq.current) return;
        seq.current = ev.seq;
        setSt(ev);
        setOpenLocal(ev.open);
      }),
      on(EVT.chat, (p) => remote.onChat(p)),
      on(EVT.result, (p) => remote.onResult(p)),
    ]).then(() => {
      if (live) void ipc.emit(EVT.ready, { v: 1 });
    });
    void Promise.resolve(ipc.invoke('pet_quiet_get')).then(
      (q) => live && setQuietState(q === true),
      () => undefined,
    );
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, [ipc, remote]);

  // The main window decides the language (localStorage is shared, but it only changes on a restart otherwise).
  const lang = st?.lang;
  useEffect(() => {
    if (!lang) return;
    setLang(lang);
    applyHtmlLang(lang);
  }, [lang]);

  // Sprite art. The scale snaps to whole device pixels like the in-window sprite did.
  useLayoutEffect(() => {
    const el = sprite.current;
    if (!el) return;
    applySkinVars(el, skin.manifest, st?.state ?? 'idle', skin.sheetUrl);
    el.style.setProperty('--pet-scale', String(snapScale(st?.scale ?? 2, window.devicePixelRatio || 1)));
  }, [skin, st?.state, st?.scale]);

  // Not even the built-in skin can be drawn: close this window (the main window says so and turns the assistant off).
  useEffect(() => {
    if (skin.id !== BUILTIN_SKIN_ID || failed.current) return;
    let live = true;
    void canDraw(skin.sheetUrl('idle')).then((ok) => {
      if (live && !ok && !failed.current) {
        failed.current = true;
        void ipc.invoke('pet_start_failed');
      }
    });
    return () => {
      live = false;
    };
  }, [skin, canDraw, ipc]);

  // A finished answer pops a short toast by itself while the panel is closed, unless quiet.
  const streaming = chat.streaming;
  const wasStreaming = useRef(false);
  useEffect(() => {
    const ended = wasStreaming.current && !streaming;
    wasStreaming.current = streaming;
    if (!ended || open || quiet) return;
    const last = [...chat.messages].reverse().find((m) => m.role === 'assistant');
    const text = last ? last.text || last.error || last.notice?.() || '' : '';
    if (text.trim()) setToast(clampText(text.replace(/\s+/g, ' ').trim(), TOAST_TEXT_MAX));
  }, [streaming, open, quiet, chat.messages]);
  useEffect(() => {
    if (!toast || menu) return;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast, menu]);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenLocal(next);
      if (next) setToast(null);
      void remote.call('setOpen', [next]).catch(() => undefined);
    },
    [remote],
  );

  // The window grows to hold the bubble (the menu uses the panel's room) and shrinks back to the sprite.
  const wanted: Mode | null = menu || open ? 'panel' : toast ? 'toast' : null;
  useEffect(() => {
    let live = true;
    if (!wanted) {
      setView(null);
      if (lastMode.current) void ipc.invoke('pet_set_layout', { args: { mode: 'sprite' } });
      lastMode.current = null;
      return;
    }
    lastMode.current = wanted;
    void (async () => {
      const geo = asGeo(await ipc.invoke('pet_geometry'));
      if (!geo || !live) return;
      // The panel's size is the one the window remembered (clamped to this monitor); a toast has a fixed size.
      const b = wanted === 'panel' ? { w: geo.panel.w, h: geo.panel.h } : TOAST;
      if (wanted === 'panel') setPanel(geo.panel);
      const grown = growWindow(geo.sprite, { w: Math.round(b.w * geo.scale), h: Math.round(b.h * geo.scale) }, Math.round(BUBBLE_GAP * geo.scale), geo.areas);
      await ipc.invoke('pet_set_layout', { args: { mode: wanted, rect: grown.rect } });
      if (live) setView({ mode: wanted, side: grown.side, align: grown.align });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wanted, ipc]);

  // The bubble's size reaches the stylesheet as two variables set through CSSOM (the CSP has no inline style).
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!el) return;
    el.style.setProperty('--pet-bubble-w', `${panel.w}px`);
    el.style.setProperty('--pet-bubble-h', `${panel.h}px`);
  }, [view, panel.w, panel.h]);

  // Escape closes the clear question, then the menu (the panel closes itself on Escape); a click outside the menu closes it.
  useEffect(() => {
    if (!menu && !confirm) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (confirm) {
        confirm(false);
        setConfirm(null);
      } else setMenu(false);
    };
    const away = (e: PointerEvent) => {
      if (menu && !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', away);
    };
  }, [menu, confirm]);

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  const hide = useCallback(() => void remote.call('hide').catch(() => undefined), [remote]);
  const menuDeps: MenuDeps = {
    quiet,
    hide: async () => hide(),
    setQuiet: async (q) => {
      await ipc.invoke('pet_quiet_set', { quiet: q });
      setQuietState(q);
      if (q) setToast(null);
    },
    openMain: async () => void (await ipc.invoke('pet_open_main')),
  };
  const choose = (action: MenuAction) => {
    setMenu(false);
    void runMenuAction(action, menuDeps).catch(() => undefined);
  };

  // Press: a move beyond the threshold starts a window drag; a press that stays put toggles the panel. It never raises the main window.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    press.current = { x: e.clientX, y: e.clientY, dragged: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.dragged) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) {
      p.dragged = true;
      void ipc.startDragging();
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (e.button !== 0 || !p || p.dragged) return;
    setMenu(false);
    setOpen(!open);
  };
  const onClick = (e: React.MouseEvent) => {
    // A pointer click was handled on release; a click without a pointer (Enter, Space) comes here.
    if (e.detail === 0) {
      setMenu(false);
      setOpen(!open);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      setMenu(true);
    }
  };

  // Resizing: the window answers with the size it allows (bounds and this monitor), and that is the size drawn. One request at
  // a time; while one is running only the newest waits.
  const resizeTo = useCallback(
    (w: number, h: number, commit: boolean) => {
      const q = sizing.current;
      if (q.busy) {
        q.next = { w, h, commit: commit || (q.next?.commit ?? false) };
        return;
      }
      q.busy = true;
      void (async () => {
        let job: { w: number; h: number; commit: boolean } | null = { w: Math.round(w), h: Math.round(h), commit };
        while (job) {
          try {
            const info = asPanel(await ipc.invoke('pet_panel_size', { ...job }));
            const geo = info ? asGeo(await ipc.invoke('pet_geometry')) : null;
            if (info && geo) {
              const grown = growWindow(geo.sprite, { w: Math.round(info.w * geo.scale), h: Math.round(info.h * geo.scale) }, Math.round(BUBBLE_GAP * geo.scale), geo.areas);
              await ipc.invoke('pet_set_layout', { args: { mode: 'panel', rect: grown.rect } });
              setPanel(info);
              setView((v) => (v ? { ...v, side: grown.side, align: grown.align } : v));
            }
          } catch {
            /* the window may be gone; the next move tries again */
          }
          job = q.next;
          q.next = null;
        }
        q.busy = false;
      })();
    },
    [ipc],
  );
  const place = view ?? { mode: wanted ?? 'toast', side: 'above' as const, align: 'right' as const };
  /** A handle move of (dx, dy) screen px: the bubble grows away from the sprite. */
  const sized = (from: { w: number; h: number }, dx: number, dy: number) => ({
    w: from.w + (place.align === 'right' ? -dx : dx),
    h: from.h + (place.side === 'above' ? -dy : dy),
  });
  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resize.current = { id: e.pointerId, x: e.screenX, y: e.screenY, w: panel.w, h: panel.h };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onGripMove = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    const next = sized(r, e.screenX - r.x, e.screenY - r.y);
    resizeTo(next.w, next.h, false);
  };
  const onGripUp = (e: React.PointerEvent) => {
    const r = resize.current;
    if (!r || r.id !== e.pointerId) return;
    resize.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const next = sized(r, e.screenX - r.x, e.screenY - r.y);
    resizeTo(next.w, next.h, true);
  };
  const onGripKey = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Home') {
      e.preventDefault();
      resizeTo(PANEL_FALLBACK.w, PANEL_FALLBACK.h, true);
      return;
    }
    const dir = Object.hasOwn(ARROW, e.key) ? ARROW[e.key] : undefined;
    if (!dir) return;
    e.preventDefault();
    const step = e.shiftKey ? RESIZE_STEP_BIG : RESIZE_STEP;
    const next = sized(panel, dir[0] * step, dir[1] * step);
    resizeTo(next.w, next.h, true);
  };
  const grip = (
    <>
      <button
        type="button"
        className="pet-bubble-grip"
        aria-label={t('pet.resize')}
        aria-describedby={gripHint}
        title={t('pet.resizeHint')}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={() => resizeTo(PANEL_FALLBACK.w, PANEL_FALLBACK.h, true)}
        onKeyDown={onGripKey}
      />
      <span id={gripHint} className="pet-sr">
        {t('pet.resizeHint')}
      </span>
    </>
  );
  const answerConfirm = (ok: boolean) => {
    confirm?.(ok);
    setConfirm(null);
  };

  return (
    <div
      className="pet-desktop"
      data-side={place.side}
      data-align={place.align}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      {view && (
        <div ref={bubble} className="pet-desktop-bubble" data-mode={view.mode}>
          {menu ? (
            <div ref={menuRef} className="pet-desktop-menu" role="menu">
              {MENU_ITEMS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  aria-checked={item.action === 'quiet' ? quiet : undefined}
                  className="pet-desktop-menuitem"
                  onClick={() => choose(item.action)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          ) : view.mode === 'toast' ? (
            <p className="pet-desktop-text" role="status">
              {toast ?? ''}
            </p>
          ) : (
            <>
              <Bubble
                id={bubbleId}
                onClose={() => setOpen(false)}
                onHide={hide}
                chat={chat}
                activePath={st?.activePath || undefined}
                actions={remote.actions}
                grip={grip}
                sized={panel.w !== PANEL_FALLBACK.w || panel.h !== PANEL_FALLBACK.h}
                onResetSize={() => resizeTo(PANEL_FALLBACK.w, PANEL_FALLBACK.h, true)}
              />
              {confirm ? (
                <div className="pet-desktop-confirm" role="alertdialog" aria-label={t('history.clear')}>
                  <p>{t('history.clearConfirm')}</p>
                  <div className="pet-composer-actions">
                    <button type="button" className="btn" onClick={() => answerConfirm(false)}>
                      {t('dialog.cancel')}
                    </button>
                    <button type="button" className="btn primary" onClick={() => answerConfirm(true)}>
                      {t('history.clearAction')}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
      <button
        type="button"
        className="pet-desktop-sprite-button"
        aria-label={t('pet.desktop.pet')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? bubbleId : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (press.current = null)}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span ref={sprite} className="pet-desktop-sprite" data-state={st?.state ?? 'idle'} aria-hidden="true" />
      </button>
    </div>
  );
}
