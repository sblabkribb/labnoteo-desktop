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
