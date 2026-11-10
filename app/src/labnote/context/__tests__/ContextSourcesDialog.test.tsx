// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLang } from '../../../i18n/lang';
import { catalogs, t } from '../../../i18n/t';
import { appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../../../editor/commands/appCommands';
import type { AppFs } from '../../../fs/tauriLabnoteFs';
import type { CommandContext } from '../../commands/context';
import { createAppHost } from '../../host/createAppHost';
import { DialogLayer } from '../../host/DialogLayer';
import { closeAllDialogs, currentDialog } from '../../host/dialogStore';
import { cleanupDialogs, openIn, renderLayer, settled } from '../../host/__tests__/harness';
import { usePaletteHotkey } from '../../ui/CommandPalette';
import { contextBudget } from '../budget';
import { buildContext, type BuildInput, type BuiltContext } from '../contextBuilder';
import { ContextSourcesDialog, contextSourcesDialog } from '../ContextSourcesDialog';
import { buildFixtureVault, EXP_MAIN, EXP_STRESS, MAIN_FILES } from './fixtures';

const catalog: BuildInput['catalog'] = async opId =>
  opId.toUpperCase() === 'UHW020' ? { name: 'Gel Purification', description: 'Purify a band' } : undefined;

async function mainContext(): Promise<BuiltContext> {
  return buildContext({
    fs: await buildFixtureVault(),
    scope: { folder: EXP_MAIN, explicit: false, named: [] },
    target: { workflowPath: MAIN_FILES.cloning, unitOpIndex: 1 },
    budgetTokens: contextBudget(200_000, 100),
    catalog,
  });
}

const STAGE4 = `${EXP_STRESS}/004_WB040_Stage 4.labnote.md`;
async function stressContext(window: number): Promise<BuiltContext> {
  return buildContext({
    fs: await buildFixtureVault(),
    scope: { folder: EXP_STRESS, explicit: false, named: [] },
    target: { workflowPath: STAGE4, unitOpIndex: 9 },
    budgetTokens: contextBudget(window, 100),
    catalog,
  });
}

const rowOf = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-source-id]')].find(el => el.dataset.sourceId === id) as HTMLElement;
const boxOf = (id: string) => within(rowOf(id)).getByRole('checkbox') as HTMLInputElement;
const totalText = () => document.querySelector('.ai-ctx-total')?.textContent ?? '';
const flush = () => act(async () => {});

beforeEach(() => act(() => setLang('en')));
afterEach(() => {
  cleanupDialogs();
  act(() => setLang('ko'));
});

describe('ContextSourcesDialog', () => {
  it('shows scope, sources, badges, tokens, required and default-excluded rows, issues, provider and total', async () => {
    const built = await mainContext();
    renderLayer();
    openIn(() => contextSourcesDialog(built, 200_000, 'Ollama', 'qwen2.5'));
    const dialog = screen.getByRole('dialog', { name: t('aiCtx.sources.title') });
    expect(dialog.textContent).toContain(EXP_MAIN);
    expect(dialog.textContent).toContain('Ollama');
    expect(dialog.textContent).toContain('qwen2.5');

    for (const s of built.sources) {
      const row = rowOf(s.id);
      expect(row, s.id).not.toBeNull();
      expect(row.textContent).toContain(s.label);
      expect(row.textContent).toContain(t('aiCtx.sources.tokens', String(s.tokens)));
      if (s.included) expect(row.textContent).toContain(t(`aiCtx.mode.${s.mode}`));
    }
    expect(boxOf('target')).toMatchObject({ checked: true, disabled: true });
    const results = built.sources.find(s => s.kind === 'results')!;
    expect(results).toBeTruthy();
    expect(boxOf(results.id)).toMatchObject({ checked: false, disabled: false });
    expect(rowOf(results.id).textContent).toContain(t('aiCtx.reason.default'));

    expect(built.issues.length).toBeGreaterThan(0);
    const issues = dialog.querySelector('.ai-ctx-issues')!;
    for (const i of built.issues) expect(issues.textContent).toContain(t(`aiCtx.issue.${i.code}`));

    expect(totalText()).toBe(t('aiCtx.sources.total', String(built.totalTokens), String(built.budget)));
  });

  it('unticking re-budgets and updates the total and badges', async () => {
    const built = await mainContext();
    renderLayer();
    openIn(() => contextSourcesDialog(built, 200_000, 'Ollama', 'm'));
    const victim = built.sources.find(s => s.kind === 'unitOp' && s.included)!;
    await userEvent.click(boxOf(victim.id));
    expect(boxOf(victim.id).checked).toBe(false);
    expect(rowOf(victim.id).textContent).toContain(t('aiCtx.reason.user'));
    expect(totalText()).toBe(t('aiCtx.sources.total', String(built.totalTokens - victim.tokens), String(built.budget)));
    await userEvent.click(boxOf('target'));
    expect(boxOf('target').checked).toBe(true);
  });

  it('the window select re-budgets: a larger window turns a summary back to verbatim', async () => {
    const built = await stressContext(2048);
    const summary = built.sources.find(s => s.kind === 'unitOp' && s.included && s.mode === 'summary')!;
    expect(summary).toBeTruthy();
    renderLayer();
    const p = openIn(() => contextSourcesDialog(built, 2048, 'Ollama', 'm'));
    expect(rowOf(summary.id).textContent).toContain(t('aiCtx.mode.summary'));
    await userEvent.selectOptions(screen.getByLabelText(t('aiCtx.sources.window')), '200000');
    expect(rowOf(summary.id).textContent).toContain(t('aiCtx.mode.verbatim'));
    expect(totalText()).toContain(String(contextBudget(200_000, 100)));
    await userEvent.click(screen.getByRole('button', { name: t('aiCtx.sources.send') }));
    const picked = await p;
    expect(picked?.window).toBe(200_000);
    expect(picked?.sources.find(s => s.id === summary.id)?.mode).toBe('verbatim');
  });

  it('Send resolves the selected sources and the window; Cancel and Escape resolve null', async () => {
    const built = await mainContext();
    renderLayer();
    const victim = built.sources.find(s => s.kind === 'unitOp' && s.included)!;
    const p = openIn(() => contextSourcesDialog(built, 200_000, 'Ollama', 'm'));
    await userEvent.click(boxOf(victim.id));
    await userEvent.click(screen.getByRole('button', { name: t('aiCtx.sources.send') }));
    const picked = await p;
    expect(picked?.window).toBe(200_000);
    expect(picked?.sources.find(s => s.id === victim.id)).toMatchObject({ included: false, reason: 'user' });
    expect(currentDialog()).toBeNull();

    const c = openIn(() => contextSourcesDialog(built, 200_000, 'Ollama', 'm'));
    await userEvent.click(screen.getByRole('button', { name: t('aiCtx.sources.cancel') }));
    await expect(c).resolves.toBeNull();

    const e = openIn(() => contextSourcesDialog(built, 200_000, 'Ollama', 'm'));
    const s = settled(e);
    await userEvent.keyboard('{Escape}');
    await flush();
    expect(s).toEqual({ done: true, value: null });
  });

  it('sets the bar width through CSSOM only; the markup has no style attribute', async () => {
    const built = await mainContext();
    const markup = renderToStaticMarkup(
      <ContextSourcesDialog
        spec={{ kind: 'aiContextSources', built, window: 200_000, providerLabel: 'Ollama', model: 'm' }}
        onDone={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(markup).not.toMatch(/style=/);
    renderLayer();
    openIn(() => contextSourcesDialog(built, 200_000, 'Ollama', 'm'));
    const fill = document.querySelector('.ai-ctx-bar-fill') as HTMLElement;
    expect(fill.style.getPropertyValue('--ai-ctx-fill')).toMatch(/^\d+(\.\d+)?%$/);
    // The only inline style is the CSSOM custom property on the bar.
    const styled = [...document.querySelectorAll('[style]')];
    expect(styled).toEqual([fill]);
  });
});

// ---------------------------------------------------------------- the command

function makeCtx(): CommandContext {
  const host = createAppHost({ fs: {} as AppFs, editTarget: () => undefined, openFile: async () => undefined });
  return {
    host,
    vaultRoot: 'C:/vault',
    settings: {} as CommandContext['settings'],
    updateSettings: () => undefined,
    activePath: () => undefined,
    activeView: () => undefined,
    openFile: async () => undefined,
    closeActive: async () => true,
    refresh: () => undefined,
    showPanel: () => undefined,
  };
}

function PaletteHarness({ ctx }: { ctx: CommandContext }) {
  const shell = useRef<HTMLDivElement>(null);
  usePaletteHotkey(ctx);
  return (
    <>
      <div className="shell" ref={shell} />
      <DialogLayer blockRef={shell} />
    </>
  );
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: k => void m.delete(k),
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const ctrlP = () =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true }));
  });
const optionLabels = () => screen.queryAllByRole('option').map(o => o.querySelector('.picker-label')?.textContent);

describe('ai-draft-planning command', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => {
    act(() => closeAllDialogs());
    clearAppCommandsForTest();
    vi.unstubAllGlobals();
  });

  it('is registered with ko and en names and appears in the command palette', async () => {
    registerAllAppCommands();
    const c = appCommands().find(x => x.id === 'ai-draft-planning');
    expect(c).toBeTruthy();
    expect(catalogs.ko[c!.nameKey]).toBeTruthy();
    expect(catalogs.en[c!.nameKey]).toBeTruthy();

    render(<PaletteHarness ctx={makeCtx()} />);
    act(() => setLang('ko'));
    ctrlP();
    await screen.findByRole('dialog');
    expect(optionLabels()).toContain(catalogs.ko[c!.nameKey]);
    act(() => closeAllDialogs());

    act(() => setLang('en'));
    ctrlP();
    await screen.findByRole('dialog');
    expect(optionLabels()).toContain(catalogs.en[c!.nameKey]);
  });
});
