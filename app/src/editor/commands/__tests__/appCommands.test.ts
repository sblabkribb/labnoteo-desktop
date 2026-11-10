// @vitest-environment jsdom
import { catalogs } from '../../../i18n/t';
import { clearCommandsForTest, commands, registerCommand } from '../../../labnote/commands/registry';
import { registerAllCommands } from '../../../labnote/commands/registerAll';
import type { CommandContext } from '../../../labnote/commands/context';
import { getMode, setMode } from '../../live/mode';
import { appCommands, clearAppCommandsForTest, displayKey, registerAllAppCommands, registerAppCommand } from '../appCommands';
import { setLang } from '../../../i18n/lang';
import { check as pluginCheck } from '@tauri-apps/plugin-updater';
import { resetUpdateStoreForTest, startUpdateChecks, updateState } from '../../../update/updateStore';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.1.4') }));

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
    expect(displayKey('Alt-ArrowLeft')).toBe('Alt+←');
    expect(displayKey('Mod-,')).toBe('Ctrl+,');
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

describe('Check for updates (palette)', () => {
  const checkMock = pluginCheck as unknown as ReturnType<typeof vi.fn>;
  function ctxWithNotify() {
    const notify = vi.fn();
    return { ctx: { host: { notify } } as unknown as CommandContext, notify };
  }
  function cmd() {
    return appCommands().find((x) => x.id === 'app.check-for-updates')!;
  }

  beforeEach(() => {
    resetUpdateStoreForTest();
    checkMock.mockReset();
  });

  it('is registered with ko and en names', () => {
    expect(cmd().nameKey).toBe('cmd.checkForUpdates');
    expect(catalogs.ko['cmd.checkForUpdates']).toBe('업데이트 확인');
    expect(catalogs.en['cmd.checkForUpdates']).toBe('Check for updates');
  });

  it('says the app is up to date, with the current version (ko)', async () => {
    checkMock.mockResolvedValue(null);
    const { ctx, notify } = ctxWithNotify();
    await cmd().run(ctx);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('info', '최신 버전입니다(0.1.4).');
  });

  it('says the app is up to date (en)', async () => {
    setLang('en');
    checkMock.mockResolvedValue(null);
    const { ctx, notify } = ctxWithNotify();
    await cmd().run(ctx);
    expect(notify).toHaveBeenCalledWith('info', "You're up to date (0.1.4).");
  });

  it('warns when the check fails (ko and en)', async () => {
    checkMock.mockRejectedValue(new Error('offline'));
    const a = ctxWithNotify();
    await cmd().run(a.ctx);
    expect(a.notify).toHaveBeenCalledWith('warn', '업데이트를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.');
    setLang('en');
    const b = ctxWithNotify();
    await cmd().run(b.ctx);
    expect(b.notify).toHaveBeenCalledWith('warn', "Couldn't check for updates. Check your internet connection.");
  });

  it('a found update downloads quietly; the command then says it is ready, without checking again', async () => {
    const update = { version: '0.2.0', download: vi.fn(async () => {}), install: vi.fn(), close: vi.fn(async () => {}) };
    checkMock.mockResolvedValue(update);
    const stop = startUpdateChecks();
    await vi.waitFor(() => expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' }));
    const { ctx, notify } = ctxWithNotify();
    await cmd().run(ctx);
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('info', "새 버전 0.2.0을 받았어요. 왼쪽 아래 '업데이트'를 누르면 적용돼요.");
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    stop();
  });

  it('a failing periodic check shows nothing', async () => {
    checkMock.mockRejectedValue(new Error('offline'));
    const notify = vi.spyOn(await import('../../../labnote/host/toastStore'), 'notify');
    const stop = startUpdateChecks();
    await vi.waitFor(() => expect(updateState()).toEqual({ kind: 'failed', manual: false }));
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
    stop();
  });
});
