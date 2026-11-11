// @vitest-environment jsdom
/**
 * Task 17 hook-ups in Integration settings: the context-window field sits in the AI provider part and
 * saves `llmContextWindow` through the dialog's patch; the SKILL.md section mounts after the MCP section
 * and calls only `skill_status` until clicked.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { IntegrationSettingsPage, type IntegrationDeps, type IntegrationSettingsValue } from '../../../integrations/IntegrationSettingsDialog';
import { fakeInvoke, secretStatusOf } from '../../../integrations/__tests__/fakeNet';
import { fromPluginData } from '../../settings';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => undefined);
}

function deps(value: Partial<IntegrationSettingsValue>, mcp?: IntegrationDeps['mcp']) {
  let current: IntegrationSettingsValue = { ...fromPluginData(undefined), ...value };
  const commit = vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
    current = { ...current, ...patch };
  });
  const d: IntegrationDeps = {
    value: () => current,
    commit,
    status: async () => secretStatusOf({}),
    setSecret: async () => undefined,
    clearSecret: async () => undefined,
    mcp,
  };
  return { d, commit };
}

describe('Integration settings hook-ups (Task 17)', () => {
  it('shows the context window only with a provider and saves it through the patch', async () => {
    const none = deps({ llmProvider: 'none' });
    render(<IntegrationSettingsPage deps={none.d} onLeave={async () => {}} />);
    await flush();
    expect(screen.queryByLabelText(t('aiCtx.window.label'))).toBeNull();
    cleanup();

    const { d, commit } = deps({ llmProvider: 'ollama', llmContextWindow: 8192 });
    render(<IntegrationSettingsPage deps={d} onLeave={async () => {}} />);
    await flush();
    const select = screen.getByLabelText(t('aiCtx.window.label')) as HTMLSelectElement;
    expect(select.value).toBe('8192');
    fireEvent.change(select, { target: { value: '16384' } });
    await flush();
    expect(commit).toHaveBeenCalledWith({ llmContextWindow: 16384 });
  });

  it('the temperature field under Advanced is blank by default, saves 0-2, clears to blank and refuses anything else', async () => {
    const { d, commit } = deps({ llmProvider: 'openai' });
    render(<IntegrationSettingsPage deps={d} onLeave={async () => {}} />);
    await flush();
    const advanced = screen.getByText(t('integrations.ai.advanced')).closest('details')!;
    expect(advanced.open).toBe(false);
    const input = screen.getByLabelText(t('integrations.ai.temperature')) as HTMLInputElement;
    expect(advanced.contains(input)).toBe(true);
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '0.6' } });
    fireEvent.blur(input);
    await flush();
    expect(commit).toHaveBeenLastCalledWith({ llmTemperature: 0.6 });
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t('integrations.ai.temperatureInvalid'))).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await flush();
    expect(commit).toHaveBeenLastCalledWith({ llmTemperature: null });
    expect(screen.queryByText(t('integrations.ai.temperatureInvalid'))).toBeNull();
    cleanup();
    // A saved value opens Advanced so it is not hidden
    const saved = deps({ llmProvider: 'ollama', llmTemperature: 0.7 });
    render(<IntegrationSettingsPage deps={saved.d} onLeave={async () => {}} />);
    await flush();
    expect((screen.getByLabelText(t('integrations.ai.temperature')) as HTMLInputElement).value).toBe('0.7');
    expect(screen.getByText(t('integrations.ai.advanced')).closest('details')!.open).toBe(true);
  });

  it('the thinking field under Advanced defaults to auto, saves on and off, and a saved non-auto value opens Advanced', async () => {
    const { d, commit } = deps({ llmProvider: 'openai', llmModel: 'qwen3.6-35b-a3b' });
    render(<IntegrationSettingsPage deps={d} onLeave={async () => {}} />);
    await flush();
    expect(screen.getByText(t('integrations.ai.advanced')).closest('details')!.open).toBe(false);
    const select = screen.getByLabelText(t('integrations.ai.thinking')) as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      t('integrations.ai.thinking.auto'),
      t('integrations.ai.thinking.on'),
      t('integrations.ai.thinking.off'),
    ]);
    fireEvent.change(select, { target: { value: 'off' } });
    await flush();
    expect(commit).toHaveBeenCalledWith({ llmThinking: 'off' });
    cleanup();
    const saved = deps({ llmProvider: 'ollama', llmThinking: 'off' });
    render(<IntegrationSettingsPage deps={saved.d} onLeave={async () => {}} />);
    await flush();
    expect((screen.getByLabelText(t('integrations.ai.thinking')) as HTMLSelectElement).value).toBe('off');
    expect(screen.getByText(t('integrations.ai.advanced')).closest('details')!.open).toBe(true);
  });

  it('the max output tokens field under Advanced is blank (automatic) by default, saves whole numbers from 256 and clears to blank', async () => {
    const { d, commit } = deps({ llmProvider: 'openai' });
    render(<IntegrationSettingsPage deps={d} onLeave={async () => {}} />);
    await flush();
    const input = screen.getByLabelText(t('integrations.ai.maxOutput')) as HTMLInputElement;
    expect(screen.getByText(t('integrations.ai.advanced')).closest('details')!.contains(input)).toBe(true);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(t('integrations.ai.maxOutputPlaceholder'));
    fireEvent.change(input, { target: { value: '16,384' } });
    fireEvent.blur(input);
    await flush();
    expect(commit).toHaveBeenLastCalledWith({ llmMaxOutputTokens: 16384 });
    expect(input.value).toBe('16384');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    await flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t('integrations.ai.maxOutputInvalid'))).toBeTruthy();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await flush();
    expect(commit).toHaveBeenLastCalledWith({ llmMaxOutputTokens: null });
    cleanup();
    // A saved value opens Advanced so it is not hidden
    const saved = deps({ llmProvider: 'openai', llmMaxOutputTokens: 32768 });
    render(<IntegrationSettingsPage deps={saved.d} onLeave={async () => {}} />);
    await flush();
    expect((screen.getByLabelText(t('integrations.ai.maxOutput')) as HTMLInputElement).value).toBe('32768');
    expect(screen.getByText(t('integrations.ai.advanced')).closest('details')!.open).toBe(true);
  });

  it('the blank temperature placeholder shows the model recommended value for qwen3, else the plain default', async () => {
    const q = deps({ llmProvider: 'ollama', llmModel: 'qwen3:8b' });
    render(<IntegrationSettingsPage deps={q.d} onLeave={async () => {}} />);
    await flush();
    const input = screen.getByLabelText(t('integrations.ai.temperature')) as HTMLInputElement;
    expect(input.placeholder).toBe(t('integrations.ai.temperatureRecommended', '0.7', 'qwen3'));
    expect(input.placeholder).toContain('0.7');
    cleanup();
    const on = deps({ llmProvider: 'ollama', llmModel: 'qwen3:8b', llmThinking: 'on' });
    render(<IntegrationSettingsPage deps={on.d} onLeave={async () => {}} />);
    await flush();
    expect((screen.getByLabelText(t('integrations.ai.temperature')) as HTMLInputElement).placeholder).toBe(
      t('integrations.ai.temperatureRecommended', '0.6', 'qwen3'),
    );
    cleanup();
    const o = deps({ llmProvider: 'openai', llmModel: 'gpt-4o-mini' });
    render(<IntegrationSettingsPage deps={o.d} onLeave={async () => {}} />);
    await flush();
    expect((screen.getByLabelText(t('integrations.ai.temperature')) as HTMLInputElement).placeholder).toBe(
      t('integrations.ai.temperaturePlaceholder'),
    );
  });

  it('mounts the SKILL.md section after the MCP section and calls only skill_status for it', async () => {
    const r = fakeInvoke({
      mcp_status: () => ({ running: false, port: null, tokenSet: false, tokenEpoch: 0 }),
      mcp_token_status: () => ({ set: false, epoch: 0 }),
      skill_status: () => ({ target: 'T/.claude/skills/labnoteo/SKILL.md', exists: false, same: false }),
    });
    const { d } = deps({}, { notify: () => undefined, invoke: r.invoke });
    render(<IntegrationSettingsPage deps={d} onLeave={async () => {}} />);
    await flush();
    const sections = [...document.querySelectorAll('section')];
    const mcp = sections.findIndex((s) => s.classList.contains('mcp-section'));
    const skill = sections.findIndex((s) => s.classList.contains('skill-section'));
    expect(mcp).toBeGreaterThanOrEqual(0);
    expect(skill).toBe(mcp + 1);
    expect(r.calls.map(([c]) => c).filter((c) => c.startsWith('skill_'))).toEqual(['skill_status']);
  });

  it('omits the SKILL.md section without MCP deps', async () => {
    const { d } = deps({});
    render(<IntegrationSettingsPage deps={d} onLeave={async () => {}} />);
    await flush();
    expect(document.querySelector('.skill-section')).toBeNull();
  });
});
