// @vitest-environment jsdom
import { catalogs } from '../../../i18n/t';
import { clearCommandsForTest, commands, registerCommand } from '../../../labnote/commands/registry';
import { registerAllCommands } from '../../../labnote/commands/registerAll';
import type { CommandContext } from '../../../labnote/commands/context';
import { getMode, setMode } from '../../live/mode';
import { appCommands, clearAppCommandsForTest, displayKey, registerAllAppCommands, registerAppCommand } from '../appCommands';

// Node 의 자체 localStorage 가 jsdom 의 것을 가리므로 메모리 저장소를 꽂는다(theme-guard.test.tsx 와 같다).
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  setMode('live');
  registerAllAppCommands();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearAppCommandsForTest();
  clearCommandsForTest();
});

describe('app-command registry', () => {
  it('registers editor-toggle-source with the CodeMirror key Mod-e', () => {
    const c = appCommands().find((x) => x.id === 'editor-toggle-source');
    expect(c).toBeTruthy();
    expect(c!.key).toBe('Mod-e');
    expect(c!.nameKey).toBe('cmd.toggleSource');
  });

  it('every app command nameKey exists in ko and en', () => {
    expect(appCommands().length).toBeGreaterThan(0);
    for (const c of appCommands()) {
      expect(catalogs.ko[c.nameKey]).toBeTruthy();
      expect(catalogs.en[c.nameKey]).toBeTruthy();
    }
  });

  it('registers the "Convert older notes to .labnote.md" palette command', () => {
    const c = appCommands().find((x) => x.id === 'app.convert-legacy-notes');
    expect(c?.nameKey).toBe('cmd.convertLegacyNotes');
    expect(catalogs.ko['cmd.convertLegacyNotes']).toBe('예전 형식 노트를 .labnote.md로 바꾸기');
    expect(catalogs.en['cmd.convertLegacyNotes']).toBe('Convert older notes to .labnote.md');
  });

  it('registers the "Integration settings" palette command', () => {
    const c = appCommands().find((x) => x.id === 'app.integration-settings');
    expect(c?.nameKey).toBe('cmd.integrationSettings');
    expect(catalogs.ko['cmd.integrationSettings']).toBe('연동 설정');
    expect(catalogs.en['cmd.integrationSettings']).toBe('Integration settings');
  });

  it('registers the "Open labnoteO link" palette command', () => {
    const c = appCommands().find((x) => x.id === 'app.open-labnoteo-link');
    expect(c?.nameKey).toBe('cmd.openLabnoteoLink');
    expect(catalogs.ko['cmd.openLabnoteoLink']).toBe('labnoteO 링크 열기');
    expect(catalogs.en['cmd.openLabnoteoLink']).toBe('Open labnoteO link');
  });

  it('displayKey turns CodeMirror keys into labels', () => {
    expect(displayKey('Mod-e')).toBe('Ctrl+E');
    expect(displayKey('Mod-Shift-.')).toBe('Ctrl+Shift+.');
    expect(displayKey('Mod-Alt-c')).toBe('Ctrl+Alt+C');
    expect(displayKey('Mod-;')).toBe('Ctrl+;');
  });

  it('no app command id collides with a vendor command id', () => {
    registerAllCommands();
    expect(commands().length).toBeGreaterThan(0);
    const v = new Set(commands().map((c) => c.id));
    for (const c of appCommands()) expect(v.has(c.id)).toBe(false);
  });

  it('registerAppCommand throws on a duplicate app id and on a vendor id', () => {
    expect(() => registerAppCommand({ id: 'editor-toggle-source', nameKey: 'cmd.toggleSource', run: () => undefined })).toThrow();
    registerCommand({ id: 'create-experiment', nameKey: 'Create experiment', run: async () => undefined });
    expect(() => registerAppCommand({ id: 'create-experiment', nameKey: 'cmd.toggleSource', run: () => undefined })).toThrow();
  });

  it('registerAllAppCommands is idempotent', () => {
    const n = appCommands().length;
    expect(() => registerAllAppCommands()).not.toThrow();
    expect(appCommands()).toHaveLength(n);
  });

  it('editor-toggle-source toggles the editor mode', async () => {
    const c = appCommands().find((x) => x.id === 'editor-toggle-source')!;
    await c.run({} as CommandContext);
    expect(getMode()).toBe('source');
    await c.run({} as CommandContext);
    expect(getMode()).toBe('live');
  });
});
