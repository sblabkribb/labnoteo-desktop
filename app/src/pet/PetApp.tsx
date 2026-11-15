import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { applySkinVars, BUBBLE_GAP, DRAG_THRESHOLD, snapScale } from '../assistant/petStore';
import { BUILTIN_SKIN_ID } from '../assistant/skins/builtin';
import { useSkin, type SkinDeps } from '../assistant/skins/useSkin';
import { applyHtmlLang, setLang } from '../i18n/lang';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { growWindow, type Rect } from './geometry';
import { MENU_ITEMS, runMenuAction, type MenuAction, type MenuDeps } from './menuActions';
import { EMPTY_MIRROR, mirrorReduce } from './mirror';
import type { PetIpc } from './petIpc';
import { ASK_MAX, buildAsk, EVT, parseAnswer, parseReject, parseState } from './protocol';

/** Logical size of each bubble in px; Rust's `size()` in pet/window.rs uses the same numbers. */
const BUBBLES = { toast: { w: 240, h: 72 }, panel: { w: 320, h: 260 } } as const;
/** One sentence per reject code, written out so the catalog check sees every key. */
const REASON_KEY = {
  'no-vault': 'pet.desktop.reason.no-vault',
  'not-configured': 'pet.desktop.reason.not-configured',
  busy: 'pet.desktop.reason.busy',
  invalid: 'pet.desktop.reason.invalid',
  'no-note': 'pet.desktop.reason.no-note',
  'no-workflow': 'pet.desktop.reason.no-workflow',
  offline: 'pet.desktop.reason.offline',
} as const;
const OFFLINE_MS = 5000;
const TOAST_MS = 6000;

interface Geo {
  sprite: Rect;
  areas: Rect[];
  scale: number;
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
}

/** The skin loader's own invoke shape (kept here so the pet page imports nothing from the integrations code). */
type InvokeFn = NonNullable<SkinDeps['invoke']>;

const defaultNewId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const defaultCanDraw = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

const asGeo = (v: unknown): Geo | null => {
  const g = v as Geo | null;
  return g && typeof g.scale === 'number' && g.sprite && Array.isArray(g.areas) ? g : null;
};

/** The desktop pet: the sprite, a drag handle, a three-item menu and a thin-client bubble. All state comes from validated events. */
export function PetApp({ ipc, skinDeps, canDraw = defaultCanDraw, newId = defaultNewId }: PetAppProps) {
  useLang();
  const [m, dispatch] = useReducer(mirrorReduce, EMPTY_MIRROR);
  const [view, setView] = useState<View | null>(null);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState('');
  const sprite = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const askTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastMode = useRef<Mode | null>(null);
  const failed = useRef(false);
  // The pet owns quiet mode (pet-window.json); a snapshot from the main window never flips it.
  const quiet = useRef(false);
  quiet.current = m.quiet;

  const invoke = useCallback<InvokeFn>((cmd, args) => ipc.invoke(cmd, args) as Promise<never>, [ipc]);
  const deps = useMemo(() => ({ invoke, urls: skinDeps?.urls }), [invoke, skinDeps?.urls]);
  const skin = useSkin(m.skin, deps);

  // Events in: validated, dropped on anything wrong. The snapshot is asked for only once the listeners exist.
  useEffect(() => {
    let live = true;
    const offs: Array<() => void> = [];
    const clearAsk = () => {
      if (askTimer.current !== undefined) clearTimeout(askTimer.current);
      askTimer.current = undefined;
    };
    const on = (name: string, fn: (payload: unknown) => void) =>
      ipc.listen(name, fn).then((off) => (live ? void offs.push(off) : off()));
    void Promise.all([
      on(EVT.state, (p) => {
        const event = parseState(p);
        if (!event) return;
        clearAsk();
        dispatch({ type: 'state', event: { ...event, quiet: quiet.current } });
      }),
      on(EVT.answer, (p) => {
        const event = parseAnswer(p);
        if (!event) return;
        clearAsk();
        dispatch({ type: 'answer', event });
      }),
      on(EVT.reject, (p) => {
        const event = parseReject(p);
        if (!event) return;
        clearAsk();
        dispatch({ type: 'reject', event });
      }),
    ]).then(() => {
      if (live) void ipc.emit(EVT.ready, { v: 1 });
    });
    void Promise.resolve(ipc.invoke('pet_quiet_get')).then(
      (q) => live && dispatch({ type: 'setQuiet', quiet: q === true }),
      () => undefined,
    );
    return () => {
      live = false;
      clearAsk();
      for (const off of offs) off();
    };
  }, [ipc]);

  // The main window decides the language (localStorage is shared, but it only changes on a restart otherwise).
  useEffect(() => {
    if (!m.online) return;
    setLang(m.lang);
    applyHtmlLang(m.lang);
  }, [m.online, m.lang]);

  // Sprite art. The scale snaps to whole device pixels like the in-window sprite.
  useLayoutEffect(() => {
    const el = sprite.current;
    if (!el) return;
    applySkinVars(el, skin.manifest, m.state, skin.sheetUrl);
    el.style.setProperty('--pet-scale', String(snapScale(m.scale, window.devicePixelRatio || 1)));
  }, [skin, m.state, m.scale]);

  // Not even the built-in skin can be drawn: close this window and let the main window show its own sprite.
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

  // The window grows to hold the bubble (the menu uses the panel's room) and shrinks back to the sprite.
  const wanted: Mode | null = menu || m.bubble === 'panel' ? 'panel' : m.bubble;
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
      const b = BUBBLES[wanted];
      const grown = growWindow(
        geo.sprite,
        { w: Math.round(b.w * geo.scale), h: Math.round(b.h * geo.scale) },
        Math.round(BUBBLE_GAP * geo.scale),
        geo.areas,
      );
      await ipc.invoke('pet_set_layout', { args: { mode: wanted, rect: grown.rect } });
      if (live) setView({ mode: wanted, side: grown.side, align: grown.align });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wanted, ipc]);

  // A toast dismisses itself.
  useEffect(() => {
    if (m.bubble !== 'toast' || menu) return;
    const id = setTimeout(() => dispatch({ type: 'dismissToast' }), TOAST_MS);
    return () => clearTimeout(id);
  }, [m.bubble, m.answerSeq, menu]);

  // The panel takes the keyboard: focus the question box once it is on screen.
  useEffect(() => {
    if (view?.mode === 'panel' && !menu) input.current?.focus();
  }, [view?.mode, menu]);

  // Escape closes the menu first, then the panel; a click outside the menu closes it.
  useEffect(() => {
    if (!menu && m.bubble !== 'panel') return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(false);
      else dispatch({ type: 'toggle' });
    };
    const away = (e: PointerEvent) => {
      if (menu && !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', away);
    };
  }, [menu, m.bubble]);

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  const menuDeps: MenuDeps = {
    quiet: m.quiet,
    hide: async () => void (await ipc.invoke('pet_hide')),
    setQuiet: async (quiet) => {
      await ipc.invoke('pet_quiet_set', { quiet });
      dispatch({ type: 'setQuiet', quiet });
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
    dispatch({ type: 'toggle' });
  };
  const onClick = (e: React.MouseEvent) => {
    // A pointer click was handled on release; a click without a pointer (Enter, Space) comes here.
    if (e.detail === 0) {
      setMenu(false);
      dispatch({ type: 'toggle' });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      setMenu(true);
    }
  };

  const ask = () => {
    if (m.pendingAsk !== null) return;
    const event = buildAsk(draft, newId);
    if (!event) return;
    void ipc.emit(EVT.ask, event);
    dispatch({ type: 'asked', askId: event.askId });
    setDraft('');
    if (askTimer.current !== undefined) clearTimeout(askTimer.current);
    askTimer.current = setTimeout(() => dispatch({ type: 'offline' }), OFFLINE_MS);
  };

  const reason = m.reason ? t(REASON_KEY[m.reason]) : '';
  const working = m.pendingAsk !== null || m.busy;
  const place = view ?? { mode: wanted ?? 'toast', side: 'above' as const, align: 'right' as const };

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
        <div className="pet-desktop-bubble" data-mode={view.mode}>
          {menu ? (
            <div ref={menuRef} className="pet-desktop-menu" role="menu">
              {MENU_ITEMS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  aria-checked={item.action === 'quiet' ? m.quiet : undefined}
                  className="pet-desktop-menuitem"
                  onClick={() => choose(item.action)}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          ) : view.mode === 'toast' ? (
            <p className="pet-desktop-text" role="status" data-error={m.answer?.error === true}>
              {m.answer?.text ?? ''}
            </p>
          ) : (
            <div className="pet-desktop-panel" role="dialog" aria-label={t('pet.desktop.ask.label')}>
              <button type="button" className="pet-desktop-close" aria-label={t('pet.desktop.close')} onClick={() => dispatch({ type: 'toggle' })}>
                {'×'}
              </button>
              <div className="pet-desktop-scroll" role="log" aria-live="polite">
                {reason ? (
                  <p className="pet-desktop-text" data-error="true">
                    {reason}
                  </p>
                ) : null}
                {working ? <p className="pet-desktop-status">{m.status || t('pet.desktop.working')}</p> : null}
                {m.answer ? (
                  <p className="pet-desktop-text" data-error={m.answer.error}>
                    {m.answer.text}
                  </p>
                ) : null}
              </div>
              <textarea
                ref={input}
                className="pet-desktop-input"
                rows={2}
                maxLength={ASK_MAX}
                value={draft}
                aria-label={t('pet.desktop.ask.label')}
                placeholder={t('pet.desktop.ask.placeholder')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    ask();
                  }
                }}
              />
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="pet-desktop-sprite-button"
        aria-label={t('pet.desktop.pet')}
        aria-haspopup="dialog"
        aria-expanded={m.bubble === 'panel'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (press.current = null)}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span ref={sprite} className="pet-desktop-sprite" data-state={m.state} aria-hidden="true" />
      </button>
    </div>
  );
}
