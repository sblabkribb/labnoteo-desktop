// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
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
// jsdom has no scrollIntoView (the panel scrolls its log to the end).
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

type Invoked = [string, Record<string, unknown> | undefined];
type CallMsg = { v: number; id: string; method: string; args: unknown[] };

const PANEL = { w: 360, h: 440, minW: 300, minH: 340, maxW: 640, maxH: 900 };
const GEO = { sprite: { x: 1000, y: 800, w: 64, h: 64 }, areas: [{ x: 0, y: 0, w: 1920, h: 1040 }], scale: 1, panel: PANEL };
const ARGS_FIXTURE = JSON.parse(readFileSync('src-tauri/tests/ipc-args.json', 'utf-8')) as Record<string, string[]>;
const PET_CAP = JSON.parse(readFileSync('src-tauri/capabilities/pet.json', 'utf-8')) as { permissions: string[] };
const ALLOWED = new Set(PET_CAP.permissions.filter((p) => p.startsWith('allow-')).map((p) => p.slice(6).replace(/-/g, '_')));

/** What the fake main window answers to each call (the value of pet:result). */
type Answers = Partial<Record<string, (args: unknown[]) => unknown>>;
const DEFAULT_ANSWERS: Answers = { ready: () => true, webSearchConfigured: () => true, sectionChoices: () => null, workflowNotes: () => [] };

function fakeIpc(opts: { quiet?: boolean; skinData?: unknown; panel?: { w: number; h: number }; bounds?: Partial<typeof PANEL>; answers?: Answers } = {}) {
  const bounds = { ...PANEL, ...opts.bounds };
  let panel = { ...bounds, ...(opts.panel ?? {}) };
  const answers = { ...DEFAULT_ANSWERS, ...opts.answers };
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const calls: Invoked[] = [];
  const emitted: Array<[string, unknown]> = [];
  const deliver = (event: string, payload: unknown) => {
    for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
  };
  const ipc: PetIpc & {
    calls: Invoked[];
    emitted: Array<[string, unknown]>;
    fire(e: string, p: unknown): Promise<void>;
    names(): string[];
    sent(method?: string): CallMsg[];
  } = {
    calls,
    emitted,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === 'pet_quiet_get') return opts.quiet === true;
      if (cmd === 'pet_geometry') return { ...GEO, panel };
      if (cmd === 'pet_panel_size') {
        const a = args as { w: number; h: number };
        panel = { ...bounds, w: Math.min(Math.max(a.w, bounds.minW), bounds.maxW), h: Math.min(Math.max(a.h, bounds.minH), bounds.maxH) };
        return panel;
      }
      if (cmd === 'skin_read') return opts.skinData;
      return undefined;
    }),
    listen: async (event, fn) => {
      const set = handlers.get(event) ?? new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => void set.delete(fn);
    },
    emit: async (event, payload) => {
      emitted.push([event, payload]);
      if (event !== EVT.call) return;
      const c = payload as CallMsg;
      const answer = answers[c.method];
      // The main window answers on its own schedule: after this call has returned.
      void Promise.resolve().then(() => deliver(EVT.result, { v: 1, id: c.id, ok: true, value: answer ? answer(c.args) ?? null : true }));
    },
    startDragging: vi.fn(async () => undefined),
    fire: async (event, payload) => {
      await act(async () => deliver(event, payload));
    },
    names: () => calls.map((c) => c[0]),
    sent: (method) => emitted.filter(([e, p]) => e === EVT.call && (!method || (p as CallMsg).method === method)).map(([, p]) => p as CallMsg),
  };
  return ipc;
}

let seqN = 10;
const state = (o: Record<string, unknown> = {}) => ({ v: 1, seq: ++seqN, state: 'idle', skin: 'flasko', scale: 2, busy: false, lang: 'en', quiet: false, open: false, activePath: '', ...o });
const chat = (o: Record<string, unknown> = {}) => ({ v: 1, seq: ++seqN, folder: 'labnote/001_A', loading: false, summarised: false, streaming: false, notice: null, chip: 'chat', messages: [], ...o });
const msg = (id: string, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) => ({ id, role, text, sources: [], tainted: false, ...extra });

let idN = 0;
const newId = () => `call-${String(++idN).padStart(8, '0')}`;
const draws = async () => true;

async function mount(ipc: ReturnType<typeof fakeIpc>, extra: Partial<React.ComponentProps<typeof PetApp>> = {}) {
  const view = render(<PetApp ipc={ipc} newId={newId} canDraw={draws} {...extra} />);
  await act(async () => {});
  return view;
}
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const spriteButton = () => screen.getByRole('button', { name: t('pet.desktop.pet') });
const click = async (el: Element) => {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(el, { button: 0, clientX: 11, clientY: 11 });
  await flush();
};
const layouts = (ipc: ReturnType<typeof fakeIpc>) => ipc.calls.filter((c) => c[0] === 'pet_set_layout').map((c) => c[1]?.args as { mode: string; rect?: unknown });
/** Mounts, gives it a state and a conversation, and opens the panel from the main window (state open: true). */
async function openPanel(ipc: ReturnType<typeof fakeIpc>, st: Record<string, unknown> = {}, ch: Record<string, unknown> = {}) {
  const view = await mount(ipc);
  await ipc.fire(EVT.chat, chat(ch));
  await ipc.fire(EVT.state, state({ open: true, ...st }));
  await flush();
  return view;
}

beforeEach(() => {
  setLang('en');
  idN = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLang('ko');
});

describe('PetApp: the window', () => {
  it('emits pet:ready once, reads the quiet flag, and asks for geometry only when a bubble opens', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    expect(ipc.emitted.filter(([e]) => e === EVT.ready)).toEqual([[EVT.ready, { v: 1 }]]);
    expect(ipc.names()).toContain('pet_quiet_get');
    expect(ipc.names()).not.toContain('pet_geometry');
    await click(spriteButton());
    expect(ipc.names()).toContain('pet_geometry');
  });

  it('shows the state of a valid pet:state and ignores invalid or older payloads', async () => {
    const ipc = fakeIpc();
    const { container } = await mount(ipc);
    const sprite = () => container.querySelector('.pet-desktop-sprite') as HTMLElement;
    expect(sprite().dataset.state).toBe('idle');
    await ipc.fire(EVT.state, state({ state: 'think' }));
    expect(sprite().dataset.state).toBe('think');
    await ipc.fire(EVT.state, state({ state: 'error' }));
    await ipc.fire(EVT.state, state({ state: 'talk', skin: '../x' }));
    await ipc.fire(EVT.state, { ...state({ state: 'talk' }), seq: 1 });
    await ipc.fire(EVT.state, 42);
    expect(sprite().dataset.state).toBe('think');
  });

  it('a click opens the panel through growWindow, tells the main window, and never raises it; a second click closes it', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    await click(spriteButton());
    expect(layouts(ipc)[0]).toMatchObject({ mode: 'panel', rect: { w: 360, h: 64 + 8 + 440 } });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(ipc.sent('setOpen').map((c) => c.args)).toEqual([[true]]);
    await click(spriteButton());
    expect(layouts(ipc).at(-1)).toEqual({ mode: 'sprite' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ipc.sent('setOpen').map((c) => c.args)).toEqual([[true], [false]]);
    expect(ipc.names()).not.toContain('pet_open_main');
  });

  it('the main window opens and closes the panel too (Ctrl+Shift+Y, the assistant commands)', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    await ipc.fire(EVT.state, state({ open: true }));
    await flush();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await ipc.fire(EVT.state, state({ open: false }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moving beyond the threshold starts a window drag and does not toggle the panel', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    const el = spriteButton();
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { clientX: 12, clientY: 10 });
    expect(ipc.startDragging).not.toHaveBeenCalled();
    fireEvent.pointerMove(el, { clientX: 40, clientY: 10 });
    expect(ipc.startDragging).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(el, { button: 0, clientX: 40, clientY: 10 });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(layouts(ipc)).toEqual([]);
  });

  it('quiet off: an answer that finishes while the panel is closed shows a toast with the literal text for 6 s', async () => {
    const ipc = fakeIpc();
    const { container } = await mount(ipc);
    await ipc.fire(EVT.state, state());
    await ipc.fire(EVT.chat, chat({ streaming: true, messages: [msg('u1', 'user', 'q'), msg('a1', 'assistant', '', { pending: true })] }));
    const payload = '<img src=x onerror=alert(1)>';
    await ipc.fire(EVT.chat, chat({ messages: [msg('u1', 'user', 'q'), msg('a1', 'assistant', payload)] }));
    await flush();
    const toast = screen.getByRole('status');
    expect(toast.textContent).toBe(payload);
    expect(container.querySelector('img, [onerror]')).toBeNull();
    expect(layouts(ipc)[0]).toMatchObject({ mode: 'toast' });
    await advance(6100);
    expect(screen.queryByRole('status')).toBeNull();
    expect(layouts(ipc).at(-1)).toEqual({ mode: 'sprite' });
  });

  it('quiet on: the same answer opens no toast', async () => {
    const ipc = fakeIpc({ quiet: true });
    await mount(ipc);
    await ipc.fire(EVT.state, state());
    await ipc.fire(EVT.chat, chat({ streaming: true }));
    await ipc.fire(EVT.chat, chat({ messages: [msg('a1', 'assistant', 'done')] }));
    await flush();
    expect(screen.queryByRole('status')).toBeNull();
    expect(layouts(ipc)).toEqual([]);
  });
});

describe('PetApp: the panel is the app assistant panel', () => {
  it('draws the conversation the main window sends: the log, the experiment, sources and the end notice', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc, {}, {
      messages: [
        msg('u1', 'user', 'make it shorter'),
        msg('a1', 'assistant', 'See [1].', { sources: [{ kind: 'web', label: 'Paper', target: 'https://example.org/p' }] }),
        msg('a2', 'assistant', '', { notice: 'Changed 1 note.' }),
      ],
    });
    const log = screen.getByRole('log');
    expect(log.textContent).toContain('make it shorter');
    expect(log.textContent).toContain('Changed 1 note.');
    expect(within(log).getByRole('button', { name: 'Paper' })).toBeTruthy();
    expect(screen.getByText(t('pet.folder', '001_A'))).toBeTruthy();
  });

  it('under StrictMode (the page entry) the panel still reaches the main window: no set-up sentence when a provider is there', async () => {
    const ipc = fakeIpc();
    render(
      <StrictMode>
        <PetApp ipc={ipc} newId={newId} canDraw={draws} />
      </StrictMode>,
    );
    await act(async () => {});
    await ipc.fire(EVT.chat, chat());
    await ipc.fire(EVT.state, state({ open: true }));
    await flush();
    expect(screen.queryByText(t('ai.configureFirst'))).toBeNull();
    expect(screen.getByRole('textbox', { name: t('pet.composer') })).toBeTruthy();
  });

  it('Enter sends the question to the main window and clears the box', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc);
    const box = screen.getByRole('textbox', { name: t('pet.composer') }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'what is next?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(ipc.sent('send').map((c) => c.args)).toEqual([['what is next?']]);
    expect(box.value).toBe('');
  });

  it('without an AI provider it shows the set-up sentence and the Integration settings button, which raises the main window', async () => {
    const ipc = fakeIpc({ answers: { ready: () => false } });
    await openPanel(ipc);
    expect(screen.getByText(t('ai.configureFirst'))).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: t('pet.composer') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('pet.openIntegrations') }));
    await flush();
    expect(ipc.names()).toContain('pet_open_main');
    expect(ipc.sent('runCommand').map((c) => c.args)).toEqual([['app.integration-settings']]);
  });

  it('a chip change goes to the main window; unit operation names its target from the open workflow note', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc, { activePath: 'labnote/001_A/001_WD010_X.labnote.md' });
    fireEvent.click(screen.getByRole('button', { name: t('chip.unitOp') }));
    await flush();
    expect(ipc.sent('setChip').map((c) => c.args)).toEqual([['unitOp']]);
    expect(screen.getByText(t('chip.target', '001_WD010_X.labnote.md'))).toBeTruthy();
    const box = screen.getByRole('textbox', { name: t('pet.composer') });
    fireEvent.change(box, { target: { value: 'PCR' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(ipc.sent('runChip')[0].args[0]).toEqual({ chip: 'unitOp', params: { documentPath: 'labnote/001_A/001_WD010_X.labnote.md' }, line: 'PCR', text: 'PCR' });
  });

  it('the section chip lists the sections the main window read from the open note', async () => {
    const ipc = fakeIpc({
      answers: { sectionChoices: () => ({ path: 'labnote/001_A/README.labnote.md', options: [{ heading: 'Goal', existing: true, planning: false }] }) },
    });
    await openPanel(ipc, { activePath: 'labnote/001_A/README.labnote.md' }, { chip: 'section' });
    await flush();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toContain('Goal');
  });

  it('clear asks inside the window; Cancel sends nothing, Delete sends clear', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc, {}, { messages: [msg('u1', 'user', 'old')] });
    fireEvent.click(screen.getByRole('button', { name: t('history.clear') }));
    await flush();
    const ask = screen.getByRole('alertdialog');
    fireEvent.click(within(ask).getByRole('button', { name: t('dialog.cancel') }));
    await flush();
    expect(ipc.sent('clear')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: t('history.clear') }));
    await flush();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: t('history.clearAction') }));
    await flush();
    expect(ipc.sent('clear')).toHaveLength(1);
  });

  it('Hide assistant asks the main window to hide it; Close and Escape only close the panel', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc);
    fireEvent.click(screen.getByRole('button', { name: t('pet.close') }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    await click(spriteButton());
    fireEvent.keyDown(screen.getByRole('textbox', { name: t('pet.composer') }), { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    await click(spriteButton());
    fireEvent.click(screen.getByRole('button', { name: t('pet.hide') }));
    await flush();
    expect(ipc.sent('hide')).toHaveLength(1);
    expect(ipc.names()).not.toContain('pet_hide');
  });

  it('opening a source and inserting an answer raise the main window, where they happen', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc, {}, { messages: [msg('a1', 'assistant', 'See [1].', { sources: [{ kind: 'web', label: 'Paper', target: 'https://example.org/p' }] })] });
    fireEvent.click(within(screen.getByRole('log')).getByRole('button', { name: 'Paper' }));
    await flush();
    expect(ipc.sent('openSource')[0].args[0]).toEqual({ kind: 'web', label: 'Paper', target: 'https://example.org/p' });
    fireEvent.click(screen.getByRole('button', { name: t('pet.insert') }));
    await flush();
    expect(ipc.sent('insert')).toHaveLength(1);
    expect(ipc.names().filter((n) => n === 'pet_open_main')).toHaveLength(2);
  });
});

describe('PetApp: resizing the bubble', () => {
  const grip = () => screen.getByRole('button', { name: t('pet.resize') });
  const sizeCalls = (ipc: ReturnType<typeof fakeIpc>) => ipc.calls.filter((c) => c[0] === 'pet_panel_size').map((c) => c[1]);

  it('opens at the size the window remembered and sets it as CSS variables (no inline style)', async () => {
    const ipc = fakeIpc({ panel: { w: 400, h: 500 } });
    const { container } = await openPanel(ipc);
    expect(layouts(ipc)[0].rect).toMatchObject({ w: 400, h: 64 + 8 + 500 });
    const bubble = container.querySelector('.pet-desktop-bubble') as HTMLElement;
    expect(bubble.style.getPropertyValue('--pet-bubble-w')).toBe('400px');
    expect(bubble.style.getPropertyValue('--pet-bubble-h')).toBe('500px');
    expect(bubble.getAttribute('style')).not.toMatch(/width:|height:/);
  });

  it('dragging the corner away from the sprite grows the bubble, then saves the size on release', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc);
    const g = grip();
    fireEvent.pointerDown(g, { button: 0, pointerId: 1, screenX: 500, screenY: 500 });
    fireEvent.pointerMove(g, { pointerId: 1, screenX: 450, screenY: 470 });
    await flush();
    expect(sizeCalls(ipc).at(-1)).toEqual({ w: 410, h: 470, commit: false });
    fireEvent.pointerUp(g, { button: 0, pointerId: 1, screenX: 450, screenY: 470 });
    await flush();
    expect(sizeCalls(ipc).at(-1)).toEqual({ w: 410, h: 470, commit: true });
  });

  it('arrow keys on the handle resize in steps; Home and "Default size" go back to the default', async () => {
    const ipc = fakeIpc();
    await openPanel(ipc);
    fireEvent.keyDown(grip(), { key: 'ArrowLeft' });
    await flush();
    expect(sizeCalls(ipc).at(-1)).toEqual({ w: 376, h: 440, commit: true });
    fireEvent.click(screen.getByRole('button', { name: t('pet.resetSize') }));
    await flush();
    expect(sizeCalls(ipc).at(-1)).toEqual({ w: 360, h: 440, commit: true });
  });
});

describe('PetApp: the right-click menu', () => {
  const items = () => screen.getAllByRole('menuitem');

  it('has exactly three entries; quiet toggles, hide asks the main window, open raises it', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    fireEvent.contextMenu(spriteButton());
    await flush();
    expect(items().map((i) => i.textContent?.trim())).toEqual([t('pet.desktop.menu.hide'), t('pet.desktop.menu.quiet'), t('pet.desktop.menu.open')]);
    fireEvent.click(items()[1]);
    await flush();
    expect(ipc.calls.find((c) => c[0] === 'pet_quiet_set')?.[1]).toEqual({ quiet: true });
    fireEvent.contextMenu(spriteButton());
    await flush();
    expect(items()[1].getAttribute('aria-checked')).toBe('true');
    fireEvent.click(items()[0]);
    await flush();
    expect(ipc.sent('hide')).toHaveLength(1);
    fireEvent.contextMenu(spriteButton());
    await flush();
    fireEvent.click(items()[2]);
    await flush();
    expect(ipc.names().filter((n) => n === 'pet_open_main')).toHaveLength(1);
  });

  it('closes on Escape and on an outside click, and opens from the keyboard', async () => {
    const ipc = fakeIpc();
    await mount(ipc);
    fireEvent.contextMenu(spriteButton());
    await flush();
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(spriteButton(), { key: 'F10', shiftKey: true });
    await flush();
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body, { button: 0 });
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('PetApp: skin art', () => {
  const pal = { manifest: { ...BUILTIN_SKIN, id: 'pal', name: 'Pal' }, sheets: { idle: [1], talk: [2], think: [3], done: [4] } };

  it('the built-in skin reads nothing; another id is read and its blob URLs revoked on change', async () => {
    const urls = { create: vi.fn((_b: Blob) => `blob:test/${urls.create.mock.calls.length}`), revoke: vi.fn() };
    const ipc = fakeIpc({ skinData: pal });
    await mount(ipc, { skinDeps: { urls } });
    expect(ipc.names()).not.toContain('skin_read');
    await ipc.fire(EVT.state, state({ skin: 'pal' }));
    await flush();
    expect(ipc.calls.find((c) => c[0] === 'skin_read')?.[1]).toEqual({ id: 'pal' });
    expect(urls.create).toHaveBeenCalledTimes(4);
    await ipc.fire(EVT.state, state({ skin: 'flasko' }));
    await flush();
    expect(urls.revoke).toHaveBeenCalledTimes(4);
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
  fireEvent.keyDown(screen.getByRole('button', { name: t('pet.resize') }), { key: 'ArrowLeft' });
  await flush();
  fireEvent.contextMenu(spriteButton());
  await flush();
  for (const index of [1, 2]) {
    fireEvent.click(screen.getAllByRole('menuitem')[index]);
    await flush();
    fireEvent.contextMenu(spriteButton());
    await flush();
  }
  await mount(ipc, { canDraw: async () => false });
  await flush();
  const names = new Set(ipc.names());
  for (const n of ['pet_quiet_get', 'pet_geometry', 'pet_set_layout', 'pet_panel_size', 'pet_quiet_set', 'pet_open_main', 'pet_start_failed', 'skin_read']) expect(names.has(n), n).toBe(true);
  for (const [cmd, args] of ipc.calls) {
    expect(ALLOWED.has(cmd), cmd).toBe(true);
    expect(Object.keys(args ?? {}).sort(), cmd).toEqual([...(ARGS_FIXTURE[cmd] ?? [])].sort());
  }
});

describe('the pet page sources', () => {
  it('render plain text only and set no inline style', () => {
    for (const f of ['src/pet/PetApp.tsx', 'src/pet/mainBridge.ts', 'src/pet/remote.ts', 'src/assistant/Bubble.tsx', 'src/assistant/MessageView.tsx']) {
      expect(readFileSync(f, 'utf-8'), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|cssText|style=|style=\{/);
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
