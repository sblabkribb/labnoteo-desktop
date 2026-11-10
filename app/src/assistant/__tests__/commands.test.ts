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

  it('assistant.chat opens the bubble', async () => {
    await run('assistant.chat');
    expect(petStore.get().open).toBe(true);
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
