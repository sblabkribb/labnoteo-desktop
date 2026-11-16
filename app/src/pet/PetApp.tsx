import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { applySkinVars, BUBBLE_GAP, DRAG_THRESHOLD, snapScale } from '../assistant/petStore';
import { BUILTIN_SKIN_ID } from '../assistant/skins/builtin';
import { useSkin, type SkinDeps } from '../assistant/skins/useSkin';
import { applyHtmlLang, setLang } from '../i18n/lang';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from '../ui/Icon';
import { growWindow, type Rect } from './geometry';
import { MENU_ITEMS, runMenuAction, type MenuAction, type MenuDeps } from './menuActions';
import { EMPTY_MIRROR, mirrorReduce } from './mirror';
import type { PetIpc } from './petIpc';
import { ASK_MAX, buildAsk, EVT, MODES, parseAnswer, parseReject, parseState, type AskMode, type SectionPick } from './protocol';

/** Logical size of the toast bubble in px; Rust's `size()` in pet/window.rs uses the same numbers. The panel's size comes from Rust. */
const TOAST = { w: 240, h: 72 } as const;
/** What the panel opens at before the window has said (it answers with the saved, clamped size). Same as PANEL_DEFAULT in window.rs. */
const PANEL_FALLBACK: Panel = { w: 360, h: 440, minW: 300, minH: 340, maxW: 640, maxH: 900 };
const RESIZE_STEP = 16;
const RESIZE_STEP_BIG = 64;
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
/** The panel's mode names (the same keys as the in-window chips) and the hint in the box, written out for the catalog check. */
const MODE_KEY: Record<AskMode, string> = {
  howTo: 'chip.howTo',
  section: 'chip.section',
  unitOp: 'chip.unitOp',
  workflow: 'chip.workflow',
  chat: 'chip.chat',
};
const MODE_PLACEHOLDER: Record<AskMode, string> = {
  howTo: 'pet.placeholder',
  section: 'chip.section.placeholder',
  unitOp: 'chip.unitOp.placeholder',
  workflow: 'chip.workflow.placeholder',
  chat: 'pet.placeholder',
};
/** Three and two, like the in-window toolbar. */
const MODE_ROWS: readonly (readonly AskMode[])[] = [MODES.slice(0, 3), MODES.slice(3)];
const ARROW: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
const OFFLINE_MS = 5000;
const TOAST_MS = 6000;
const NEW = 'new';

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

/** What the person picked in the section list: one of the labels of the list at the time, or "new title". */
type Picked = { index: number; label: string } | typeof NEW | null;

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

/** The desktop pet: the sprite, a drag handle, a three-item menu and a thin-client bubble. All state comes from validated events. */
export function PetApp({ ipc, skinDeps, canDraw = defaultCanDraw, newId = defaultNewId }: PetAppProps) {
  useLang();
  const [m, dispatch] = useReducer(mirrorReduce, EMPTY_MIRROR);
  const [view, setView] = useState<View | null>(null);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<AskMode>('chat');
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState<Picked>(null);
  const [newTitle, setNewTitle] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [panel, setPanel] = useState<Panel>(PANEL_FALLBACK);
  const [focusMode, setFocusMode] = useState<AskMode>('chat');
  const heading = useId();
  const gripHint = useId();
  const sprite = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modeButtons = useRef(new Map<AskMode, HTMLButtonElement>());
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const resize = useRef<{ id: number; x: number; y: number; w: number; h: number } | null>(null);
  const sizing = useRef<{ busy: boolean; next: { w: number; h: number; commit: boolean } | null }>({ busy: false, next: null });
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
      // The panel's size is the one the window remembered (clamped to this monitor); a toast has a fixed size.
      const b = wanted === 'panel' ? { w: geo.panel.w, h: geo.panel.h } : TOAST;
      if (wanted === 'panel') setPanel(geo.panel);
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

  // The bubble's size reaches the stylesheet as two variables set through CSSOM (the CSP has no inline style).
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!el) return;
    el.style.setProperty('--pet-bubble-w', `${panel.w}px`);
    el.style.setProperty('--pet-bubble-h', `${panel.h}px`);
  }, [view, panel.w, panel.h]);

  // A toast dismisses itself.
  useEffect(() => {
    if (m.bubble !== 'toast' || menu) return;
    const id = setTimeout(() => dispatch({ type: 'dismissToast' }), TOAST_MS);
    return () => clearTimeout(id);
  }, [m.bubble, m.answerSeq, menu]);

  // The panel takes the keyboard: focus the question box once it is on screen.
  useEffect(() => {
    if (view?.mode === 'panel' && !menu) input.current?.focus();
  }, [view?.mode, menu, mode]);

  // Escape closes the clear question, then the menu, then the panel; a click outside the menu closes it.
  useEffect(() => {
    if (!menu && m.bubble !== 'panel') return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmClear) setConfirmClear(false);
      else if (menu) setMenu(false);
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
  }, [menu, m.bubble, confirmClear]);

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

  const sectionPick = (): SectionPick | null => {
    if (picked === NEW) {
      const title = newTitle.replace(/\s+/g, ' ').trim();
      return title ? { kind: 'new', title } : null;
    }
    // A pick counts only while the list still has that label at that place.
    return picked && m.sections[picked.index] === picked.label ? { kind: 'pick', index: picked.index, label: picked.label } : null;
  };
  const working = m.pendingAsk !== null || m.busy;
  const needsExperiment = mode !== 'chat' && mode !== 'howTo' && m.folder === '';
  const event = () => buildAsk(draft, newId, mode, mode === 'section' ? (sectionPick() ?? undefined) : undefined);
  const canSend = !working && !needsExperiment && event() !== null;

  const ask = () => {
    if (!canSend) return;
    const ev = event();
    if (!ev) return;
    void ipc.emit(EVT.ask, ev);
    dispatch({ type: 'asked', askId: ev.askId });
    setDraft('');
    input.current?.focus();
    if (askTimer.current !== undefined) clearTimeout(askTimer.current);
    askTimer.current = setTimeout(() => dispatch({ type: 'offline' }), OFFLINE_MS);
  };

  const clearChat = () => {
    setConfirmClear(false);
    void ipc.emit(EVT.clear, { v: 1 });
    dispatch({ type: 'cleared' });
  };

  const selectMode = (next: AskMode) => {
    setMode(next);
    setFocusMode(next);
  };
  const onModesKey = (e: React.KeyboardEvent) => {
    const i = MODES.indexOf(focusMode);
    const n = MODES.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Object.hasOwn(STEP, e.key) ? (i + STEP[e.key] + n) % n : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setFocusMode(MODES[next]);
    modeButtons.current.get(MODES[next])?.focus();
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
              const grown = growWindow(
                geo.sprite,
                { w: Math.round(info.w * geo.scale), h: Math.round(info.h * geo.scale) },
                Math.round(BUBBLE_GAP * geo.scale),
                geo.areas,
              );
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

  const reason = m.reason ? t(REASON_KEY[m.reason]) : '';
  const composerFields =
    mode === 'section' ? (
      <div className="pet-field">
        <label className="pet-field-label" htmlFor={`${heading}-section`}>
          {t('section.pick')}
        </label>
        <select
          id={`${heading}-section`}
          className="pet-select"
          value={picked === NEW ? NEW : picked && m.sections[picked.index] === picked.label ? String(picked.index) : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === NEW) setPicked(NEW);
            else {
              const index = Number(v);
              setPicked(v === '' || m.sections[index] === undefined ? null : { index, label: m.sections[index] });
            }
          }}
        >
          <option value="" disabled>
            {t('section.choose')}
          </option>
          {m.sections.map((label, i) => (
            <option key={`${i}:${label}`} value={String(i)}>
              {label}
            </option>
          ))}
          <option value={NEW}>{t('section.new')}</option>
        </select>
        {picked === NEW ? (
          <>
            <label className="pet-field-label" htmlFor={`${heading}-title`}>
              {t('section.newTitle')}
            </label>
            <input
              id={`${heading}-title`}
              className="pet-input"
              type="text"
              value={newTitle}
              maxLength={200}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </>
        ) : null}
      </div>
    ) : mode === 'unitOp' ? (
      <p className="pet-chip-target">{m.unitTarget ? t('chip.target', m.unitTarget) : t('chip.noWorkflow')}</p>
    ) : null;

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
            <div className="pet-desktop-panel" role="dialog" aria-modal="false" aria-labelledby={heading}>
              <div className="pet-bubble-head">
                <div className="pet-bubble-heading">
                  <h2 id={heading} className="pet-bubble-title">
                    {t('pet.title')}
                  </h2>
                  {m.folder !== '' ? (
                    <span className="pet-bubble-folder" title={m.folder}>
                      {t('pet.folder', m.folder)}
                    </span>
                  ) : null}
                </div>
                <div className="pet-bubble-tools">
                  {m.folder !== '' ? (
                    <button
                      type="button"
                      className="ibtn pet-bubble-clear"
                      aria-label={t('history.clear')}
                      title={t('history.clear')}
                      onClick={() => setConfirmClear(true)}
                    >
                      <Icon name="eraser" size={16} />
                    </button>
                  ) : null}
                  <button type="button" className="ibtn pet-bubble-close" aria-label={t('pet.close')} title={t('pet.close')} onClick={() => dispatch({ type: 'toggle' })}>
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </div>
              {confirmClear ? (
                <div className="pet-desktop-confirm" role="group" aria-label={t('history.clear')}>
                  <p>{t('history.clearConfirm')}</p>
                  <div className="pet-composer-actions">
                    <button type="button" className="btn" onClick={() => setConfirmClear(false)}>
                      {t('dialog.cancel')}
                    </button>
                    <button type="button" className="btn primary" onClick={clearChat}>
                      {t('history.clearAction')}
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="pet-chips" role="toolbar" aria-label={t('pet.chips')} onKeyDown={onModesKey}>
                {MODE_ROWS.map((row) => (
                  <div key={row.join()} className="pet-chips-row">
                    {row.map((id) => (
                      <button
                        key={id}
                        ref={(el) => {
                          if (el) modeButtons.current.set(id, el);
                          else modeButtons.current.delete(id);
                        }}
                        type="button"
                        className="pet-chip"
                        data-chip={id}
                        aria-pressed={id === mode}
                        tabIndex={id === focusMode ? 0 : -1}
                        onFocus={() => setFocusMode(id)}
                        onClick={() => selectMode(id)}
                      >
                        {t(MODE_KEY[id])}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              {m.folder === '' ? <p className="pet-bubble-note">{t('pet.ephemeral')}</p> : null}
              <div className="pet-desktop-scroll" role="log" aria-live="polite" aria-relevant="additions" aria-label={t('pet.log')}>
                {reason ? (
                  <p className="pet-desktop-text" data-error="true">
                    {reason}
                  </p>
                ) : null}
                {working ? <p className="pet-desktop-status">{m.status || t('pet.desktop.working')}</p> : null}
                {m.recent.length > 0 ? (
                  <div className="pet-recent">
                    {m.recent.map((item, i) => (
                      <div key={i} className="pet-recent-item" data-role={item.role}>
                        <span className="pet-recent-role">{item.role === 'assistant' ? t('pet.title') : t('pet.you')}</span>
                        <p className="pet-recent-text" data-error={item.error ? 'true' : undefined}>
                          {item.text}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}
                {!reason && !working && !m.answer && m.recent.length === 0 ? <p className="pet-bubble-greeting">{t('pet.greeting')}</p> : null}
              </div>
              <div className="pet-chip-panel" data-chip={mode}>
                {mode === 'howTo' ? (
                  <section className="pet-howto" aria-label={t('chip.howTo')}>
                    <p>{t('howto.what')}</p>
                    <p>{t('howto.chips')}</p>
                    <p>{t('howto.history')}</p>
                    <p>{t('howto.hide')}</p>
                    <div className="pet-howto-actions">
                      <button type="button" className="btn primary" onClick={() => selectMode('chat')}>
                        {t('howto.startChat')}
                      </button>
                    </div>
                  </section>
                ) : needsExperiment ? (
                  <div className="pet-gate">
                    <p>{t('pet.needExperiment')}</p>
                  </div>
                ) : (
                  <form
                    className="pet-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      ask();
                    }}
                  >
                    {composerFields}
                    <textarea
                      ref={input}
                      className="pet-composer-input"
                      rows={2}
                      maxLength={ASK_MAX}
                      value={draft}
                      aria-label={t('pet.composer')}
                      placeholder={t(MODE_PLACEHOLDER[mode])}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                          e.preventDefault();
                          ask();
                        }
                      }}
                    />
                    <div className="pet-composer-actions">
                      <button type="submit" className="btn primary pet-send" disabled={!canSend}>
                        <Icon name="send" size={14} />
                        <span>{t('pet.send')}</span>
                      </button>
                    </div>
                  </form>
                )}
              </div>
              <div className="pet-bubble-foot">
                <button type="button" className="btn pet-bubble-hide" onClick={() => choose('hide')}>
                  <Icon name="eye-off" size={14} />
                  <span>{t('pet.hide')}</span>
                </button>
              </div>
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
