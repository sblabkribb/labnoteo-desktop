// @vitest-environment jsdom
/**
 * 다섯 AI 명령의 등록(Task 36). 플러그인 main.ts:658-692 의 이름과 보이는 조건 그대로다(D21: 제공자 검사는 없다).
 * 명령의 run 은 createAiEnv(ctx) 를 쓰고 invoke 를 넣지 않으므로, Tauri invoke 를 흉내 내 llm_chat 이 없는지 본다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { cleanupDialogs } from '../../labnote/host/__tests__/harness';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { clearCommandsForTest, commandById, commands } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';
import { aiCommands } from '../commands';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === 'vault_current' ? { root: 'C:/Vault', name: 'Vault' } : null)),
}));

const NOTE = 'labnote/001_Test/001_WD010_A.labnote.md';
const README = 'labnote/001_Test/README.labnote.md';
const BODY = '## [WD010 A]\n\n### [UHW010 Spin]\n\n#### Method\n\n시료 S-001 을 원심분리\n';

let hosts: TestHost[] = [];
function host(files: Record<string, string>, settings: Record<string, unknown>): TestHost {
  const th = createTestHost(files, settings);
  hosts.push(th);
  return th;
}

beforeEach(() => {
  setLang('en');
  vi.mocked(tauriInvoke).mockClear();
});
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  clearCommandsForTest();
  closeAllDialogs();
  cleanupDialogs();
});

describe('AI 명령 등록', () => {
  it('all five are registered with the plugin names', () => {
    expect(aiCommands.map((c) => [c.id, c.nameKey])).toEqual([
      ['ai-draft-method', 'AI: Draft Method section'],
      ['ai-summarize-results', 'AI: Summarize workflow results'],
      ['ai-summarize-experiment', 'AI: Summarize experiment results'],
      ['ai-extract-samples', 'AI: Extract sample definitions'],
      ['ai-ask-agent', 'AI: Ask assistant (uses tools)'],
    ]);
    registerAllCommands();
    const ids = commands().map((c) => c.id);
    for (const c of aiCommands) expect(commandById(c.id)).toBe(c);
    expect(ids.filter((id) => id.startsWith('ai-'))).toEqual(aiCommands.map((c) => c.id));
  });

  it('shown while the provider is none, and running it gives the configure notice', async () => {
    const th = host({ [NOTE]: BODY }, { llmProvider: 'none' });
    await th.mount(NOTE);
    th.setActive(NOTE);
    for (const id of ['ai-draft-method', 'ai-extract-samples', 'ai-ask-agent']) {
      const c = aiCommands.find((x) => x.id === id)!;
      expect(c.available?.(th.ctx) ?? true).toBe(true);
      th.notes.length = 0;
      await c.run(th.ctx);
      expect(th.notes).toContainEqual({ kind: 'info', message: t('ai.configureFirst') });
    }
    const sentCmds = vi.mocked(tauriInvoke).mock.calls.map(([cmd]) => cmd);
    expect(sentCmds).not.toContain('llm_chat');
  });

  it('summarize-results hides on a README, summarize-experiment shows only there', () => {
    const th = host({ [NOTE]: BODY, [README]: '# Test\n' }, {});
    const results = aiCommands.find((c) => c.id === 'ai-summarize-results')!;
    const experiment = aiCommands.find((c) => c.id === 'ai-summarize-experiment')!;
    th.setActive(NOTE);
    expect(results.available!(th.ctx)).toBe(true);
    expect(experiment.available!(th.ctx)).toBe(false);
    th.setActive(README);
    expect(results.available!(th.ctx)).toBe(false);
    expect(experiment.available!(th.ctx)).toBe(true);
    th.setActive(undefined);
    expect(results.available!(th.ctx)).toBe(true);
    expect(experiment.available!(th.ctx)).toBe(false);
  });
});
