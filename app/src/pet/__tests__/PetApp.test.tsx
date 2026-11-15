// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_SKIN } from '../../assistant/skins/builtin';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { PetApp } from '../PetApp';
import type { PetIpc } from '../petIpc';
import { EVT } from '../protocol';

// jsdom 25 has no PointerEvent: fireEvent.pointer* would then send a plain Event without button or clientX.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal('PointerEvent', PointerEventPolyfill);
}

type Call = [string, Record<string, unknown> | undefined];

const GEO = { sprite: { x: 1000, y: 800, w: 64, h: 64 }, areas: [{ x: 0, y: 0, w: 1920, h: 1040 }], scale: 1 };
const ARGS_FIXTURE = JSON.parse(readFileSync('src-tauri/tests/ipc-args.json', 'utf-8')) as Record<string, string[]>;
const PET_CAP = JSON.parse(readFileSync('src-tauri/capabilities/pet.json', 'utf-8')) as { permissions: string[] };
const ALLOWED = new Set(PET_CAP.permissions.filter((p) => p.startsWith('allow-')).map((p) => p.slice(6).replace(/-/g, '_')));

function fakeIpc(opts: { quiet?: boolean; skinData?: unknown } = {}) {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const calls: Call[] = [];
  const emitted: Array<[string, unknown]> = [];
  const ipc: PetIpc & { calls: Call[]; emitted: Array<[string, unknown]>; fire(e: string, p: unknown): Promise<void>; names(): string[] } = {
    calls,
    emitted,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === 'pet_quiet_get') return opts.quiet === true;
      if (cmd === 'pet_geometry') return GEO;
      if (cmd === 'skin_read') return opts.skinData;
      return undefined;
    }),
    listen: async (event, fn) => {
      const set = handlers.get(event) ?? new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => void set.delete(fn);
    },
    emit: async (event, payload) => void emitted.push([event, payload]),
    startDragging: vi.fn(async () => undefined),
    fire: async (event, payload) => {
      await act(async () => {
        for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
      });
    },
    names: () => calls.map((c) => c[0]),
  };
  return ipc;
}

const state = (o: Record<string, unknown> = {}) => ({ v: 1, seq: 1, state: 'idle', skin: 'flasko', scale: 2, busy: false, lang: 'en', status: '', quiet: false, ...o });
const answer = (o: Record<string, unknown> = {}) => ({ v: 1, seq: 1, askId: 'ask-12345678', text: 'Three notes found.', done: true, error: false, ...o });

let seq = 0;
const newId = () => `ask-${String(++seq).padStart(8, '0')}`;
const draws = async () => true;

async function mount(ipc: ReturnType<typeof fakeIpc>, extra: Partial<React.ComponentProps<typeof PetApp>> = {}) {
  const view = render(<PetApp ipc={ipc} newId={newId} canDraw={draws} {...extra} />);
  await act(async () => {});
  return view;
}
const flush = () => act(async () => {});
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const spriteButton = () => screen.getByRole('button', { name: t('pet.desktop.pet') });
const click = async (el: Element) => {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(el, { button: 0, clientX: 11, clientY: 11 });
  await flush();
};
const layouts = (ipc: ReturnType<typeof fakeIpc>) => ipc.calls.filter((c) => c[0] === 'pet_set_layout').map((c) => c[1]?.args as { mode: string; rect?: unknown });

beforeEach(() => {
  setLang('en');
  seq = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLang('ko');
});

describe('PetApp', () => {
  it('emits pet:ready once, reads the quiet flag, and asks for geometry only when a bubble opens', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    expect(ipc.emitted.filter(([e]) => e === EVT.ready)).toEqual([[EVT.ready, { v: 1 }]]);
    expect(ipc.names()).toContain('pet_quiet_get');
    expect(ipc.names()).not.toContain('pet_geometry');
    await click(spriteButton());
    expect(ipc.names()).toContain('pet_geometry');
  });

  it('shows the state of a valid pet:state and ignores invalid payloads', async () => {
    const ipc = fakeIpc();
    const { container } = await mount(ipc);
    const sprite = () => container.querySelector('.pet-desktop-sprite') as HTMLElement;
    expect(sprite().dataset.state).toBe('idle');
    await ipc.fire(EVT.state, state({ seq: 2, state: 'think' }));
    expect(sprite().dataset.state).toBe('think');
    await ipc.fire(EVT.state, state({ seq: 3, state: 'error' }));
    await ipc.fire(EVT.state, state({ seq: 4, status: 'x'.repeat(5_000_000), state: 'talk', skin: '../x' }));
    await ipc.fire(EVT.state, 42);
    await ipc.fire(EVT.state, null);
    expect(sprite().dataset.state).toBe('think');
  });

  it('quiet off: a finished answer shows a toast with the literal text and dismisses itself after 6 s', async () => {
    const ipc = fakeIpc();
    const { container } = await mount(ipc);
    await ipc.fire(EVT.state, state());
    const payload = '<img src=x onerror=alert(1)>';
    await ipc.fire(EVT.answer, answer({ text: payload }));
    const toast = screen.getByRole('status');
    expect(toast.textContent).toBe(payload);
    expect(container.querySelector('img, [onerror]')).toBeNull();
    expect(layouts(ipc)[0]).toMatchObject({ mode: 'toast', rect: expect.any(Object) });
    await advance(6100);
    expect(screen.queryByRole('status')).toBeNull();
    expect(layouts(ipc).at(-1)).toEqual({ mode: 'sprite' });
  });

  it('quiet on: the same answer opens no toast and never changes the layout', async () => {
    const ipc = fakeIpc({ quiet: true });
    await mount(ipc);
    await ipc.fire(EVT.state, state({ quiet: false })); // the main window cannot turn quiet off
    await ipc.fire(EVT.answer, answer());
    expect(screen.queryByRole('status')).toBeNull();
    expect(layouts(ipc)).toEqual([]);
  });

  it('a click toggles the panel through growWindow and never raises the main window; Escape closes it', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    await click(spriteButton());
    const open = layouts(ipc);
    expect(open).toHaveLength(1);
    expect(open[0].mode).toBe('panel');
    expect(open[0].rect).toMatchObject({ w: 320, h: 64 + 8 + 260 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(ipc.names()).not.toContain('pet_open_main');
    await click(spriteButton());
    expect(layouts(ipc).at(-1)).toEqual({ mode: 'sprite' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await click(spriteButton());
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ipc.names()).not.toContain('pet_open_main');
  });

  it('moving beyond the threshold starts a window drag and does not toggle the panel', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    const el = spriteButton();
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { clientX: 12, clientY: 10 });
    expect(ipc.startDragging).not.toHaveBeenCalled();
    fireEvent.pointerMove(el, { clientX: 30, clientY: 10 });
    fireEvent.pointerMove(el, { clientX: 40, clientY: 10 });
    expect(ipc.startDragging).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(el, { button: 0, clientX: 40, clientY: 10 });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(layouts(ipc)).toEqual([]);
  });

  describe('the question box', () => {
    const open = async (ipc: ReturnType<typeof fakeIpc>) => {
      await mount(ipc);
      await ipc.fire(EVT.state, state());
      await click(spriteButton());
      return screen.getByRole('textbox') as HTMLTextAreaElement;
    };
    const asks = (ipc: ReturnType<typeof fakeIpc>) => ipc.emitted.filter(([e]) => e === EVT.ask).map(([, p]) => p as { v: number; askId: string; text: string });

    it('sends at most 500 characters with a valid askId, then clears the box; a second Enter while pending sends nothing', async () => {
      const ipc = fakeIpc();
      const box = await open(ipc);
      fireEvent.change(box, { target: { value: 'q'.repeat(600) } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await flush();
      expect(asks(ipc)).toHaveLength(1);
      expect(asks(ipc)[0].text.length).toBeLessThanOrEqual(500);
      expect(asks(ipc)[0].askId).toMatch(/^[A-Za-z0-9-]{8,40}$/);
      expect(box.value).toBe('');
      fireEvent.change(box, { target: { value: 'again' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await flush();
      expect(asks(ipc)).toHaveLength(1);
    });

    it('sends nothing for empty or whitespace input, and Shift+Enter is not a send', async () => {
      const ipc = fakeIpc();
      const box = await open(ipc);
      for (const v of ['', '   \n  ']) {
        fireEvent.change(box, { target: { value: v } });
        fireEvent.keyDown(box, { key: 'Enter' });
      }
      fireEvent.change(box, { target: { value: 'line' } });
      fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
      await flush();
      expect(asks(ipc)).toEqual([]);
      expect(box.value).toBe('line');
    });

    it('a reject shows exactly the catalog sentence of its code, in both languages, and never payload text', async () => {
      for (const lang of ['en', 'ko'] as const) {
        const ipc = fakeIpc();
        setLang(lang);
        const box = await open(ipc);
        for (const code of ['no-vault', 'not-configured', 'busy', 'invalid']) {
          fireEvent.change(box, { target: { value: 'hello' } });
          fireEvent.keyDown(box, { key: 'Enter' });
          await flush();
          const askId = asks(ipc).at(-1)?.askId;
          await ipc.fire(EVT.reject, { v: 1, askId, reason: code, message: 'LEAK secret' });
          const log = screen.getByRole('log');
          expect(log.textContent).toBe(t(`pet.desktop.reason.${code}`));
          expect(log.textContent).not.toContain('LEAK');
        }
        cleanup();
      }
    });

    it('no pet:state for 5 s after an ask shows the offline sentence and releases the pending ask', async () => {
      const ipc = fakeIpc();
      const box = await open(ipc);
      fireEvent.change(box, { target: { value: 'hello' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await flush();
      await advance(4900);
      expect(screen.getByRole('log').textContent).not.toContain(t('pet.desktop.reason.offline'));
      await advance(200);
      expect(screen.getByRole('log').textContent).toBe(t('pet.desktop.reason.offline'));
      fireEvent.change(box, { target: { value: 'retry' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await flush();
      expect(asks(ipc)).toHaveLength(2);
    });
  });

  describe('the right-click menu', () => {
    const items = () => screen.getAllByRole('menuitem');

    it('has exactly three entries and each calls its command; quiet toggles with aria-checked', async () => {
      const ipc = fakeIpc();
      await mount(ipc);
      fireEvent.contextMenu(spriteButton());
      await flush();
      expect(items().map((i) => i.textContent?.trim())).toEqual([t('pet.desktop.menu.hide'), t('pet.desktop.menu.quiet'), t('pet.desktop.menu.open')]);
      expect(items()[1].getAttribute('aria-checked')).toBe('false');
      fireEvent.click(items()[1]);
      await flush();
      expect(ipc.calls.find((c) => c[0] === 'pet_quiet_set')?.[1]).toEqual({ quiet: true });
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.contextMenu(spriteButton());
      await flush();
      expect(items()[1].getAttribute('aria-checked')).toBe('true');
      fireEvent.click(items()[0]);
      await flush();
      expect(ipc.names()).toContain('pet_hide');
      expect(ipc.names()).not.toContain('pet_open_main');
      fireEvent.contextMenu(spriteButton());
      await flush();
      fireEvent.click(items()[2]);
      await flush();
      expect(ipc.names().filter((n) => n === 'pet_open_main')).toHaveLength(1);
    });

    it('closes on Escape and on an outside click, never toggles the panel, and opens from the keyboard', async () => {
      const ipc = fakeIpc();
      await mount(ipc);
      fireEvent.contextMenu(spriteButton());
      await flush();
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.keyDown(document, { key: 'Escape' });
      await flush();
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.keyDown(spriteButton(), { key: 'F10', shiftKey: true });
      await flush();
      expect(screen.getByRole('menu')).toBeTruthy();
      fireEvent.pointerDown(document.body, { button: 0 });
      await flush();
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.keyDown(spriteButton(), { key: 'ContextMenu' });
      await flush();
      expect(screen.getByRole('menu')).toBeTruthy();
      expect(ipc.names()).not.toContain('pet_open_main');
    });
  });

  describe('skin art', () => {
    const pal = {
      manifest: { ...BUILTIN_SKIN, id: 'pal', name: 'Pal' },
      sheets: { idle: [1], talk: [2], think: [3], done: [4] },
    };

    it('the built-in skin reads nothing; another id is read, turned into blob URLs and revoked on change and unmount', async () => {
      const urls = { create: vi.fn((_b: Blob) => `blob:test/${urls.create.mock.calls.length}`), revoke: vi.fn() };
      const ipc = fakeIpc({ skinData: pal });
      const { unmount } = await mount(ipc, { skinDeps: { urls } });
      expect(ipc.names()).not.toContain('skin_read');
      await ipc.fire(EVT.state, state({ seq: 2, skin: 'pal' }));
      await flush();
      expect(ipc.calls.find((c) => c[0] === 'skin_read')?.[1]).toEqual({ id: 'pal' });
      expect(urls.create).toHaveBeenCalledTimes(4);
      expect(urls.revoke).not.toHaveBeenCalled();
      await ipc.fire(EVT.state, state({ seq: 3, skin: 'flasko' }));
      await flush();
      expect(urls.revoke).toHaveBeenCalledTimes(4);
      await ipc.fire(EVT.state, state({ seq: 4, skin: 'pal' }));
      await flush();
      expect(urls.create).toHaveBeenCalledTimes(8);
      unmount();
      expect(urls.revoke).toHaveBeenCalledTimes(8);
    });

    it('if even the built-in skin cannot be drawn it invokes pet_start_failed once', async () => {
      const ipc = fakeIpc();
      await mount(ipc, { canDraw: async () => false });
      await flush();
      expect(ipc.names().filter((n) => n === 'pet_start_failed')).toHaveLength(1);
    });
  });

  it('every command the page invokes is one the pet capability allows, with the argument names of the shared fixture', async () => {
    const ipc = fakeIpc({ skinData: { manifest: { ...BUILTIN_SKIN, id: 'pal' }, sheets: { idle: [1], talk: [1], think: [1], done: [1] } } });
    await mount(ipc, { skinDeps: { urls: { create: () => 'blob:x/1', revoke: () => undefined } } });
    await ipc.fire(EVT.state, state({ skin: 'pal' }));
    await click(spriteButton());
    fireEvent.contextMenu(spriteButton());
    await flush();
    for (const index of [0, 1, 2]) {
      fireEvent.click(screen.getAllByRole('menuitem')[index]);
      await flush();
      fireEvent.contextMenu(spriteButton());
      await flush();
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    await click(spriteButton());
    await mount(ipc, { canDraw: async () => false });
    const names = new Set(ipc.names());
    for (const n of ['pet_quiet_get', 'pet_geometry', 'pet_set_layout', 'pet_quiet_set', 'pet_hide', 'pet_open_main', 'pet_start_failed', 'skin_read']) expect(names.has(n), n).toBe(true);
    for (const [cmd, args] of ipc.calls) {
      expect(ALLOWED.has(cmd), cmd).toBe(true);
      expect(Object.keys(args ?? {}).sort(), cmd).toEqual([...(ARGS_FIXTURE[cmd] ?? [])].sort());
    }
  });
});

describe('the pet page sources', () => {
  it('render plain text only and set no inline style', () => {
    for (const f of ['src/pet/PetApp.tsx', 'src/pet/mainBridge.ts']) {
      let code = '';
      try {
        code = readFileSync(f, 'utf-8');
      } catch {
        continue; // mainBridge.ts arrives with the main-window bridge task
      }
      expect(code, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|cssText|style=|style=\{/);
    }
  });

  it('pet.html has no inline script body and no style', () => {
    const html = readFileSync('pet.html', 'utf-8');
    expect(html).not.toMatch(/style=|<style/);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(m[1]).toMatch(/\bsrc=/);
      expect(m[2].trim()).toBe('');
    }
  });
});
