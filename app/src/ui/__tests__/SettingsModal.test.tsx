// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { catalogs, t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { DialogLayer } from '../../labnote/host/DialogLayer';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { fromPluginData, type AppSettings } from '../../labnote/settings';
import type { IntegrationDeps, IntegrationSettingsValue } from '../../integrations/IntegrationSettingsDialog';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import type { SampleSettingsValue } from '../../samples/SampleSettingsDialog';
import { clearAppCommandsForTest, registerAllAppCommands } from '../../editor/commands/appCommands';
import { getMode, setMode } from '../../editor/live/mode';
import type { Theme } from '../../theme/useTheme';
import { DEFAULT_PREFS, layoutStore } from '../layoutStore';
import { focusableIn } from '../focusable';
import { SETTINGS_PAGES, openSettings, setSettingsSource, type SettingsDeps } from '../SettingsModal';

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

function integrationDeps(): IntegrationDeps & { commit: ReturnType<typeof vi.fn> } {
  const s = fromPluginData(undefined);
  let current: IntegrationSettingsValue = {
    partbankDesktopUrl: s.partbankDesktopUrl,
    partbankWebUrl: s.partbankWebUrl,
    partbankDefaultConnection: s.partbankDefaultConnection,
    partbankSendUsages: s.partbankSendUsages,
    llmProvider: s.llmProvider,
    llmEndpointOllama: s.llmEndpointOllama,
    llmEndpointOpenai: s.llmEndpointOpenai,
    llmModel: s.llmModel,
    bfwUrl: s.bfwUrl,
    bfwConnection: s.bfwConnection,
    allowHttpOrigins: s.allowHttpOrigins,
    worksheetPaperSize: s.worksheetPaperSize,
    scanMaxImageEdge: s.scanMaxImageEdge,
    scanJpegQuality: s.scanJpegQuality,
    scanEmbedWidth: s.scanEmbedWidth,
    mcpEnabled: s.mcpEnabled,
    mcpPort: s.mcpPort,
  };
  return {
    value: () => current,
    commit: vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
      current = { ...current, ...patch };
    }),
    status: async () => secretStatusOf({}),
    setSecret: async () => undefined,
    clearSecret: async () => undefined,
  };
}

const SAMPLES: SampleSettingsValue = { sampleTracking: true, customSampleTypes: [], globalSampleFolder: 'resources/labsamples' };

function fakeDeps() {
  let settings: AppSettings = fromPluginData(undefined);
  let theme: Theme = 'system';
  const deps = {
    theme: () => theme,
    setTheme: vi.fn((next: Theme) => {
      theme = next;
    }),
    settings: () => settings,
    update: vi.fn(async (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch };
    }),
    version: '9.8.7',
    integrations: integrationDeps(),
    samples: { value: () => SAMPLES, apply: vi.fn(async () => undefined) },
  } satisfies SettingsDeps;
  return deps;
}

let off: (() => void) | undefined;
function install(deps: SettingsDeps = fakeDeps()) {
  off = setSettingsSource(() => deps);
  render(<DialogLayer />);
  return deps;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  layoutStore.update({ ...DEFAULT_PREFS });
  setMode('live');
  registerAllAppCommands();
});
afterEach(() => {
  act(() => closeAllDialogs());
  off?.();
  off = undefined;
  cleanup();
  clearAppCommandsForTest();
  vi.unstubAllGlobals();
  setLang('ko');
});

const dialog = () => within(screen.getByRole('dialog', { name: '설정' }));
const nav = () => within(dialog().getByRole('tablist', { name: '설정 항목' }));
const sw = (name: string) => dialog().getByRole('switch', { name });

describe('Settings modal', () => {
  it('opens on the General page by default, with theme, language, density and system files', async () => {
    install();
    act(() => void openSettings());
    expect(nav().getAllByRole('tab').map((x) => x.textContent)).toEqual(['일반', '편집기', '실험·워크플로', '샘플', '연동', '단축키', '정보']);
    expect(nav().getByRole('tab', { name: '일반' }).getAttribute('aria-selected')).toBe('true');
    const panel = within(dialog().getByRole('tabpanel', { name: '일반' }));
    expect(within(panel.getByRole('radiogroup', { name: '테마' })).getAllByRole('radio').map((r) => r.textContent)).toEqual(['시스템', '밝게', '어둡게']);
    expect(panel.getByRole('button', { name: '언어: 한국어' })).toBeTruthy();
    expect(panel.getByRole('radiogroup', { name: '줄 간격' })).toBeTruthy();
    expect(panel.getByRole('switch', { name: '시스템 파일 표시' })).toBeTruthy();
    // 초점은 고른 탭에
    await waitFor(() => expect(document.activeElement).toBe(nav().getByRole('tab', { name: '일반' })));
  });

  it('openSettings(page) opens that page; a second open while it is showing does not stack', async () => {
    install();
    act(() => void openSettings('about'));
    expect(nav().getByRole('tab', { name: '정보' }).getAttribute('aria-selected')).toBe('true');
    act(() => void openSettings('general'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('the left nav changes page with the arrows, Home and End', async () => {
    install();
    act(() => void openSettings());
    const first = nav().getByRole('tab', { name: '일반' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const editor = nav().getByRole('tab', { name: '편집기' });
    expect(editor.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(editor);
    expect(dialog().getByRole('tabpanel', { name: '편집기' })).toBeTruthy();
    fireEvent.keyDown(editor, { key: 'End' });
    expect(nav().getByRole('tab', { name: '정보' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(nav().getByRole('tab', { name: '일반' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(nav().getByRole('tab', { name: '정보' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(nav().getByRole('tab', { name: '일반' }).getAttribute('aria-selected')).toBe('true');
    // 고르지 않은 탭은 Tab 으로 닿지 않는다(roving tabindex)
    expect(nav().getAllByRole('tab').map((x) => x.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
  });

  it('General: theme calls setTheme; density switches data-density; system files persists in the layout store', async () => {
    const deps = install();
    const user = userEvent.setup();
    act(() => void openSettings());
    await user.click(within(dialog().getByRole('radiogroup', { name: '테마' })).getByRole('radio', { name: '어둡게' }));
    expect(deps.setTheme).toHaveBeenCalledWith('dark');
    expect(within(dialog().getByRole('radiogroup', { name: '테마' })).getByRole('radio', { name: '어둡게' }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(dialog().getByRole('radiogroup', { name: '줄 간격' })).getByRole('radio', { name: '촘촘하게' }));
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(layoutStore.get().density).toBe('compact');
    const sys = sw('시스템 파일 표시');
    expect(sys.getAttribute('aria-checked')).toBe('false');
    await user.click(sys);
    expect(layoutStore.get().showSystemFiles).toBe(true);
    expect(sw('시스템 파일 표시').getAttribute('aria-checked')).toBe('true');
    // 언어
    await user.click(dialog().getByRole('button', { name: '언어: 한국어' }));
    await user.click(screen.getByRole('option', { name: 'English' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'General' })).toBeTruthy();
  });

  it('Editor: the default editor mode and the image folder', async () => {
    const deps = install();
    const user = userEvent.setup();
    act(() => void openSettings('editor'));
    await user.click(within(dialog().getByRole('radiogroup', { name: '기본 편집 방식' })).getByRole('radio', { name: '소스 보기' }));
    expect(getMode()).toBe('source');
    const folder = dialog().getByRole('radiogroup', { name: '그림 저장 폴더' });
    // 2026-11-10 사용자 결정: 그림도 기본은 resources, images 는 Obsidian·플러그인과 같은 선택
    expect(within(folder).getByRole('radio', { name: 'resources (기본)' }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(folder).getByRole('radio', { name: 'images (Obsidian·플러그인과 같음)' }));
    expect(deps.update).toHaveBeenCalledWith({ imageFolder: 'images' });
    expect(within(folder).getByRole('radio', { name: 'images (Obsidian·플러그인과 같음)' }).getAttribute('aria-checked')).toBe('true');
  });

  it('Experiments: toggling autoSyncUnitOpToc and autoUpdateLastUpdated persists through the settings store; the experimenter commits on blur', async () => {
    const deps = install();
    const user = userEvent.setup();
    act(() => void openSettings('experiments'));
    const toc = sw('UO 목차 자동 동기화');
    expect(toc.getAttribute('aria-checked')).toBe(String(fromPluginData(undefined).autoSyncUnitOpToc));
    await user.click(toc);
    expect(deps.update).toHaveBeenCalledWith({ autoSyncUnitOpToc: !fromPluginData(undefined).autoSyncUnitOpToc });
    expect(deps.settings().autoSyncUnitOpToc).toBe(!fromPluginData(undefined).autoSyncUnitOpToc);
    expect(sw('UO 목차 자동 동기화').getAttribute('aria-checked')).toBe(String(!fromPluginData(undefined).autoSyncUnitOpToc));
    await user.click(sw('마지막 수정일 자동 기록'));
    expect(deps.update).toHaveBeenCalledWith({ autoUpdateLastUpdated: !fromPluginData(undefined).autoUpdateLastUpdated });
    const name = dialog().getByRole('textbox', { name: '기본 실험자' }) as HTMLInputElement;
    await user.type(name, '  박예성 ');
    expect(deps.update).not.toHaveBeenCalledWith(expect.objectContaining({ defaultExperimenter: expect.anything() }));
    fireEvent.blur(name);
    expect(deps.update).toHaveBeenCalledWith({ defaultExperimenter: '박예성' });
    expect(name.value).toBe('박예성');
  });

  it('Samples: the existing sample settings; a plain change is applied at once, a folder change closes settings first', async () => {
    const deps = install();
    act(() => void openSettings('samples'));
    const panel = within(dialog().getByRole('tabpanel', { name: '샘플' }));
    fireEvent.click(panel.getByRole('switch', { name: coreT('Sample tracking') }));
    await waitFor(() => expect(deps.samples.apply).toHaveBeenCalledWith(SAMPLES, { ...SAMPLES, sampleTracking: false }));
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    // 폴더를 바꾸면 옮길지 묻는 대화상자가 이 창 뒤에 줄 서지 않게 먼저 닫는다
    const folder = panel.getByRole('textbox', { name: coreT('Global sample folder') }) as HTMLInputElement;
    fireEvent.change(folder, { target: { value: 'shared/samples' } });
    fireEvent.blur(folder);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull());
    await waitFor(() =>
      expect(deps.samples.apply).toHaveBeenLastCalledWith(
        { ...SAMPLES, sampleTracking: false },
        { ...SAMPLES, sampleTracking: false, globalSampleFolder: 'shared/samples' },
      ),
    );
  });

  it('Integrations renders the existing integration fields; closing the modal saves a field still being edited', async () => {
    const deps = install();
    setLang('en');
    act(() => void openSettings('integrations'));
    const d = within(screen.getByRole('dialog', { name: 'Settings' }));
    expect(await d.findByLabelText('partbank server API key')).toBeTruthy();
    expect(d.getByRole('heading', { name: coreT('AI provider') })).toBeTruthy();
    expect(d.getByRole('heading', { name: coreT('Barcode & scans') })).toBeTruthy();
    fireEvent.change(d.getByLabelText(coreT('Stored scan size')), { target: { value: '3000' } });
    fireEvent.keyDown(d.getByRole('tab', { name: 'Integrations' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(deps.integrations.commit).toHaveBeenCalledWith({ scanMaxImageEdge: 3000 });
  });

  it('Shortcuts lists the registry keys read-only', () => {
    install();
    act(() => void openSettings('shortcuts'));
    const panel = within(dialog().getByRole('tabpanel', { name: '단축키' }));
    const rows = panel.getAllByRole('row').map((r) => r.textContent);
    expect(rows).toEqual(expect.arrayContaining(['왼쪽 사이드바 보이기/숨기기Ctrl+\\', '빠른 이동: 노트, UO, 첨부 열기Ctrl+O', '설정 열기Ctrl+,', '명령 팔레트Ctrl+P', '뒤로 가기Alt+←']));
    expect(panel.queryByRole('textbox')).toBeNull();
    expect(panel.queryAllByRole('button')).toHaveLength(0);
  });

  it('About shows the version and the Lucide ISC notice', () => {
    install();
    act(() => void openSettings('about'));
    const panel = within(dialog().getByRole('tabpanel', { name: '정보' }));
    expect(panel.getByText('버전 9.8.7')).toBeTruthy();
    expect(panel.getByText(/Lucide/).textContent).toContain('ISC');
  });

  it('Tab from the last visible control wraps to the first, past controls on hidden pages; Shift+Tab the reverse', async () => {
    install();
    // 연동 페이지를 먼저 열고 일반으로 옮긴다: 입력란이 있는 숨은 연동 페이지가 일반 뒤에 남는다
    act(() => void openSettings('integrations'));
    await userEvent.click(nav().getByRole('tab', { name: '일반' }));
    const root = screen.getByRole('dialog', { name: '설정' });
    const hiddenPage = root.querySelector<HTMLElement>('.settings-page-integrations')!;
    expect(hiddenPage.hidden).toBe(true);
    const visible = focusableIn(root);
    expect(visible.some((el) => hiddenPage.contains(el))).toBe(false);
    expect(hiddenPage.querySelector('button, a[href], input, select, textarea')).not.toBeNull();
    const first = visible[0];
    const last = visible[visible.length - 1];
    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(first);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it('Esc closes and focus returns to where it was', async () => {
    install();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    act(() => void openSettings());
    await waitFor(() => expect(document.activeElement).not.toBe(outside));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('with no source (settings not read yet) openSettings does nothing', async () => {
    render(<DialogLayer />);
    await act(() => openSettings());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('every page label is in ko and en', () => {
    for (const page of SETTINGS_PAGES) {
      const key = `settings.page.${page}`;
      expect(catalogs.ko[key], key).toBeTruthy();
      expect(catalogs.en[key], key).toBeTruthy();
      expect(catalogs.en[key]).not.toBe(catalogs.ko[key]);
    }
    for (const key of Object.keys(catalogs.ko).filter((k) => k.startsWith('settings.'))) expect(catalogs.en[key], key).toBeTruthy();
  });
});
