// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { catalogs } from '../../i18n/t';
import type { CommandContext } from '../../labnote/commands/context';
import { appCommandById, appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../../editor/commands/appCommands';
import { layoutStore, PET_DEFAULT } from '../../ui/layoutStore';
import { shellShortcut } from '../../ui/shellKeys';
import { ASSISTANT_COMMAND_IDS, assistantCommands } from '../commands';
import { petStore } from '../petStore';
import { emptyHistory } from '../history';
import type { AssistantRuntime } from '../runtime';
import { assistantSession } from '../useAssistantSession';
import { chipGate } from '../chips';
import { openPalette } from '../../labnote/ui/CommandPalette';
import { clearCommandsForTest, commands } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';

vi.mock('../../ui/SettingsModal', () => ({ openSettings: vi.fn(async () => undefined) }));

function ctx(): CommandContext & { notes: Array<[string, string]> } {
  const notes: Array<[string, string]> = [];
  return {
    notes,
    host: { notify: (kind: string, message: string) => void notes.push([kind, message]) },
  } as unknown as CommandContext & { notes: Array<[string, string]> };
}

beforeEach(() => {
  registerAllAppCommands();
  petStore.resetForTest();
});
afterEach(() => {
  clearAppCommandsForTest();
  petStore.resetForTest();
  assistantSession.resetForTest();
});

const run = (id: string, c = ctx()) => appCommandById(id)!.run(c);

describe('assistant commands (spec §10.2, the ones that work after Task 5)', () => {
  it('are registered through allAppCommands, with ko and en names and icons', () => {
    expect(ASSISTANT_COMMAND_IDS).toEqual([
      'assistant.open',
      'assistant.toggleVisible',
      'assistant.resetPosition',
      'assistant.settings',
      'assistant.chat',
      'assistant.stop',
      'assistant.clearHistory',
      'assistant.howTo',
      'assistant.createSection',
      'assistant.createUnitOperation',
      'assistant.createWorkflow',
      'skins.import',
      'skins.export',
      'skins.editor',
      'skins.gallery',
      'skins.submit',
    ]);
    expect(assistantCommands().map((c) => c.id)).toEqual([...ASSISTANT_COMMAND_IDS]);
    const ids = appCommands().map((c) => c.id);
    for (const id of ASSISTANT_COMMAND_IDS) {
      expect(ids, id).toContain(id);
      const c = appCommandById(id)!;
      expect(catalogs.ko[c.nameKey], c.nameKey).toBeTruthy();
      expect(catalogs.en[c.nameKey], c.nameKey).toBeTruthy();
      expect(c.icon, id).toBeTruthy();
    }
    expect(appCommandById('assistant.open')!.key).toBe('Mod-Shift-y');
  });

  it('assistant.toggleVisible hides the pet, says how to get it back, and shows it again', async () => {
    const c = ctx();
    await run('assistant.toggleVisible', c);
    expect(layoutStore.get().pet.hidden).toBe(true);
    expect(petStore.get().hidden).toBe(true);
    expect(c.notes).toEqual([['info', '어시스턴트를 숨겼어요. 왼쪽 리본에서 다시 켤 수 있어요.']]);
    await run('assistant.toggleVisible', c);
    expect(layoutStore.get().pet.hidden).toBe(false);
    expect(c.notes).toHaveLength(1);
  });

  it('assistant.open shows a hidden pet and opens the bubble, remembering where focus was', async () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    layoutStore.setPet({ hidden: true });
    await run('assistant.open');
    expect(petStore.get()).toMatchObject({ hidden: false, open: true });
    const restore = petStore.takeRestore();
    expect(restore).toBeTypeOf('function');
    before.blur();
    restore!();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('assistant.resetPosition moves the pet back to the default corner', async () => {
    petStore.moveBy(-100, -100);
    await run('assistant.resetPosition');
    expect(layoutStore.get().pet).toMatchObject({ x: PET_DEFAULT.x, y: PET_DEFAULT.y });
  });

  it('assistant.settings opens the Assistant pane', async () => {
    const { openSettings } = await import('../../ui/SettingsModal');
    await run('assistant.settings');
    expect(openSettings).toHaveBeenCalledWith('assistant');
  });
});

describe('chat commands (Task 10)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function wire(opts: { hold?: boolean } = {}) {
    const cleared: string[] = [];
    let release: () => void = () => {};
    const rt: AssistantRuntime = {
      id: 'fake',
      label: () => 'Fake',
      available: async () => ({ ok: true }),
      run: (_turn, _sink, signal) =>
        new Promise((resolve) => {
          const done = () => resolve({ content: 'ok', sources: [], executed: [], tainted: false, cancelled: signal.aborted });
          release = done;
          if (!opts.hold) done();
          signal.addEventListener('abort', done);
        }),
    };
    assistantSession.resetForTest({
      runtime: () => rt,
      history: {
        read: async (folder) => ({ doc: emptyHistory(folder), token: 't' }),
        write: async () => {},
        clear: async (folder) => void cleared.push(folder),
      },
      confirm: async () => true,
      setPetState: () => {},
    });
    return { cleared, release: () => release() };
  }

  it('assistant.chat opens the bubble on the chat chip', async () => {
    assistantSession.setChip('section');
    await run('assistant.chat');
    expect(petStore.get().open).toBe(true);
    expect(assistantSession.get().chip).toBe('chat');
  });

  it('the four chip commands open the bubble (showing a hidden pet) on their chip (Task 11B)', async () => {
    const cases = [
      ['assistant.howTo', 'howTo'],
      ['assistant.createSection', 'section'],
      ['assistant.createUnitOperation', 'unitOp'],
      ['assistant.createWorkflow', 'workflow'],
    ] as const;
    for (const [id, chip] of cases) {
      petStore.setOpen(false);
      layoutStore.setPet({ hidden: true });
      await run(id);
      expect(petStore.get(), id).toMatchObject({ hidden: false, open: true });
      expect(assistantSession.get().chip, id).toBe(chip);
    }
  });

  it('assistant.stop is shown only while a reply runs, and says so when nothing runs', async () => {
    wire({ hold: true });
    const stop = appCommandById('assistant.stop')!;
    const c = ctx();
    expect(stop.available!(c)).toBe(false);
    await stop.run(c);
    expect(c.notes).toEqual([['info', '지금 진행 중인 대화가 없어요.']]);
    const p = assistantSession.send('q');
    await flush();
    expect(stop.available!(c)).toBe(true);
    await stop.run(c);
    await p;
    expect(assistantSession.get().streaming).toBe(false);
    expect(assistantSession.get().messages[1]!.stopped).toBe(true);
  });

  it('assistant.clearHistory clears this experiment, or says why it cannot', async () => {
    const { cleared } = wire();
    const c = ctx();
    assistantSession.setActivePath('notes/free.md');
    await run('assistant.clearHistory', c);
    expect(c.notes).toEqual([['info', '실험 노트를 열면 그 실험의 대화 기록을 지울 수 있어요.']]);
    assistantSession.setActivePath('labnote/001_A/README.labnote.md');
    await flush();
    await run('assistant.clearHistory', c);
    expect(cleared).toEqual(['labnote/001_A']);
  });
});

/** src/editor 의 테스트가 아닌 .ts/.tsx 파일. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('Ctrl+Shift+Y (assistant.open)', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('maps by code, also on a Korean layout, and never while composing', () => {
    expect(shellShortcut(key({ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true }))).toBe('assistant.open');
    expect(shellShortcut(key({ key: 'ㅛ', code: 'KeyY', ctrlKey: true, shiftKey: true }))).toBe('assistant.open');
    expect(shellShortcut(key({ key: 'ㅛ', code: 'KeyY', ctrlKey: true, shiftKey: true, isComposing: true }))).toBeUndefined();
    expect(shellShortcut(key({ key: 'Process', code: 'KeyY', ctrlKey: true, shiftKey: true, keyCode: 229 }))).toBeUndefined();
    expect(shellShortcut(key({ key: 'y', code: 'KeyY', ctrlKey: true }))).toBeUndefined();
    expect(shellShortcut(key({ key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true, altKey: true }))).toBeUndefined();
  });

  it('collides with no other shell key, app command key or CodeMirror keymap in src/editor', () => {
    // other shell keys: only Ctrl+Shift+\ and Ctrl+Shift+Y are Ctrl+Shift bindings
    const others = ['KeyN', 'KeyO', 'Comma', 'Backslash', 'KeyP', 'KeyE'].map((code) =>
      shellShortcut(key({ key: 'x', code, ctrlKey: true, shiftKey: true })),
    );
    expect(others.filter((id) => id === 'assistant.open')).toEqual([]);
    const withKey = appCommands().filter((c) => c.key && /^(?:Mod|Ctrl)-Shift-y$/i.test(c.key));
    expect(withKey.map((c) => c.id)).toEqual(['assistant.open']);
    const SHIFT_Y = /(?:Mod|Ctrl)-Shift-[yY]\b|Shift-(?:Mod|Ctrl)-[yY]\b/;
    const hits = sources('src/editor').filter((f) => SHIFT_Y.test(readFileSync(f, 'utf-8')));
    expect(hits).toEqual([]);
  });
});

describe('command audit (Task 21, spec §10.2)', () => {
  /** 팔레트가 보여 줄 줄의 명령 id(고르지 않고 닫는다). */
  async function paletteIds(): Promise<string[]> {
    let ids: string[] = [];
    const c = {
      host: {
        notify: () => {},
        pick: async (items: Array<{ value: { command: { id: string } } }>) => {
          ids = items.map((i) => i.value.command.id);
          return undefined;
        },
      },
    } as unknown as CommandContext;
    await openPalette(c);
    return ids;
  }

  it('every assistant and skin command is in the palette; assistant.stop only while a reply runs', async () => {
    const idle = await paletteIds();
    for (const id of ASSISTANT_COMMAND_IDS) {
      if (id === 'assistant.stop') expect(idle, id).not.toContain(id);
      else expect(idle, id).toContain(id);
    }
    let release: () => void = () => {};
    assistantSession.resetForTest({
      runtime: () => ({
        id: 'fake',
        label: () => 'Fake',
        available: async () => ({ ok: true }),
        run: (_turn, _sink, signal) =>
          new Promise((resolve) => {
            release = () => resolve({ content: 'ok', sources: [], executed: [], tainted: false, cancelled: signal.aborted });
            signal.addEventListener('abort', () => release());
          }),
      }),
      history: { read: async (folder) => ({ doc: emptyHistory(folder), token: 't' }), write: async () => {}, clear: async () => {} },
      confirm: async () => true,
      setPetState: () => {},
    });
    const p = assistantSession.send('q');
    await new Promise((r) => setTimeout(r, 0));
    expect(await paletteIds()).toContain('assistant.stop');
    release();
    await p;
  });

  it('no assistant or skin id collides with a vendor (plugin) command id', () => {
    clearAppCommandsForTest();
    registerAllCommands();
    try {
      const vendor = new Set(commands().map((c) => c.id));
      for (const id of ASSISTANT_COMMAND_IDS) expect(vendor.has(id), id).toBe(false);
      expect(() => registerAllAppCommands()).not.toThrow();
    } finally {
      clearCommandsForTest();
    }
  });

  it('every id is in the assistant. or skins. namespace and each nameKey is unique and Korean in ko', () => {
    const keys = assistantCommands().map((c) => c.nameKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of assistantCommands()) {
      expect(c.id).toMatch(/^(assistant|skins)\.[a-zA-Z]+$/);
      expect(catalogs.ko[c.nameKey], c.nameKey).toMatch(/[가-힣]/);
      expect(catalogs.ko[c.nameKey]).not.toBe(catalogs.en[c.nameKey]);
    }
  });

  it('chip commands without an experiment or a provider still open and the bubble says why', async () => {
    assistantSession.setActivePath('notes/free.md');
    const cases = [
      ['assistant.createSection', 'section'],
      ['assistant.createUnitOperation', 'unitOp'],
      ['assistant.createWorkflow', 'workflow'],
    ] as const;
    for (const [id, chip] of cases) {
      petStore.setOpen(false);
      await run(id);
      expect(petStore.get().open, id).toBe(true);
      const s = assistantSession.get();
      expect(s.chip, id).toBe(chip);
      expect(s.folder, id).toBeNull();
      expect(chipGate(s.chip, { provider: true, folder: s.folder }), id).toBe('noScope');
      expect(chipGate(s.chip, { provider: false, folder: s.folder }), id).toBe('noProvider');
    }
    // 사용법은 제공자도 실험도 없이 된다
    await run('assistant.howTo');
    expect(chipGate(assistantSession.get().chip, { provider: false, folder: null })).toBe('ok');
  });
});
