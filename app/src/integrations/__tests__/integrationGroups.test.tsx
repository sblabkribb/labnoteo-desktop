// @vitest-environment jsdom
/**
 * Settings > 연동 grouping: six groups in a fixed order (AI, research services, worksheet scans, GitHub, other AI
 * tools, import), each an h4 region with a one-line lead, sections one level below (h5), and a jump list at the top.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { fromPluginData } from '../../labnote/settings';
import { styleAttributes } from '../../labnote/host/__tests__/harness';
import { focusableIn } from '../../ui/focusable';
import type { GithubDeps } from '../GithubSection';
import { IntegrationSettingsPage, type IntegrationDeps, type IntegrationSettingsValue } from '../IntegrationSettingsDialog';
import { mcpClientDepsFor } from '../mcpClient/McpClientSection';
import { fakeInvoke, secretStatusOf } from './fakeNet';

beforeEach(() => setLang('en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLang('en');
});

const BASE: IntegrationSettingsValue = (() => {
  const s = fromPluginData(undefined);
  return {
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
    mcpClientServers: [],
  };
})();

const github: GithubDeps = {
  account: async () => null,
  secretStatus: async () => secretStatusOf({}),
  signInStart: async () => ({ outcome: 'notConfigured' }),
  signInWait: async () => ({ outcome: 'cancelled' }),
  signOut: async () => undefined,
  setToken: async () => ({ outcome: 'badToken' }),
  statuses: async () => ({}),
  unlink: async () => undefined,
  openExternal: async () => undefined,
  copy: async () => undefined,
  appSettings: async () => ({ clientIdDefault: true, forgetOnExit: false }),
  setAppSettings: async () => ({ clientIdDefault: true, forgetOnExit: false }),
  readmeOverlay: () => true,
  commitReadmeOverlay: async () => undefined,
  owners: async () => ({ outcome: 'needsSignIn' }),
  defaultOwner: async () => undefined,
  setDefaultOwner: async () => undefined,
};

function minimalDeps(): IntegrationDeps {
  let current = { ...BASE };
  return {
    value: () => current,
    commit: async (patch) => {
      current = { ...current, ...patch };
    },
    status: async () => secretStatusOf({}),
    setSecret: async () => undefined,
    clearSecret: async () => undefined,
  };
}

function fullDeps(): IntegrationDeps {
  const fake = fakeInvoke({
    mcp_status: () => ({ running: false, port: null, tokenSet: false, tokenEpoch: 0 }),
    mcp_token_status: () => ({ set: false, epoch: 0 }),
    mcp_client_secret_status: () => ({}),
    mcp_client_tools_cached: () => ({}),
  });
  return {
    ...minimalDeps(),
    mcp: { notify: () => undefined, invoke: fake.invoke },
    mcpClient: mcpClientDepsFor(fake.invoke),
    github,
    importFile: {
      run: async () => null,
      runBytes: async () => {
        throw new Error('unused');
      },
      remove: async () => 'deleted',
    },
  };
}

async function show(deps: IntegrationDeps) {
  const r = render(<IntegrationSettingsPage deps={deps} onLeave={async () => {}} />);
  await act(async () => {});
  return r;
}

const groupLabels = () => [
  t('integrations.group.ai'),
  t('integrations.group.research'),
  t('integrations.group.scan'),
  t('integrations.group.github'),
  t('integrations.group.agents'),
  t('integrations.import.heading'),
];

const SECTION_ORDER = () => [
  t('integrations.aiProvider'),
  t('scholar.title'),
  t('mcpClient.title'),
  t('integrations.bfw.heading'),
  coreT('partbank'),
  coreT('Barcode & scans'),
  coreT('Slack scans (optional)'),
  t('github.settings.title'),
  coreT('MCP server'),
  t('skill.heading'),
];

const names = (els: HTMLElement[]) => els.map((h) => h.textContent);

describe('Settings > Integrations groups', () => {
  it('groups the page in order: AI, research services, scans, GitHub, other AI tools, import (h4 each)', async () => {
    const { container } = await show(fullDeps());
    expect(names(screen.getAllByRole('heading', { level: 4 }))).toEqual(groupLabels());
    const body = container.querySelector('.integration-body')!;
    const groups = [...body.querySelectorAll(':scope > .integration-category')];
    expect(groups).toHaveLength(6);
    // the import group is the last one and its heading is the group heading
    const imp = screen.getByRole('heading', { name: t('integrations.import.heading') });
    expect(imp.tagName).toBe('H4');
    expect(groups[groups.length - 1].contains(imp)).toBe(true);
    expect(styleAttributes()).toEqual([]);
  });

  it('sections sit one level below their group (h5) in the new order; no h3 inside the page', async () => {
    const { container } = await show(fullDeps());
    expect(names(screen.getAllByRole('heading', { level: 5 }))).toEqual(SECTION_ORDER());
    expect(container.querySelector('.integration-body h3')).toBeNull();
  });

  it('each group is a named region holding its sections and a one-line lead', async () => {
    await show(fullDeps());
    const region = (name: string) => within(screen.getByRole('region', { name }));
    const ai = region(t('integrations.group.ai'));
    expect(ai.getByText(t('integrations.group.aiLead'))).toBeTruthy();
    for (const h of [t('integrations.aiProvider'), t('scholar.title'), t('mcpClient.title')]) expect(ai.getByRole('heading', { name: h })).toBeTruthy();
    const research = region(t('integrations.group.research'));
    expect(research.getByText(t('integrations.group.researchLead'))).toBeTruthy();
    expect(research.getByRole('heading', { name: t('integrations.bfw.heading') })).toBeTruthy();
    expect(research.getByLabelText('partbank server API key')).toBeTruthy();
    const scan = region(t('integrations.group.scan'));
    expect(scan.getByText(t('integrations.group.scanLead'))).toBeTruthy();
    expect(scan.getByRole('heading', { name: coreT('Slack scans (optional)') })).toBeTruthy();
    const gh = region(t('integrations.group.github'));
    expect(gh.getByText(t('integrations.group.githubLead'))).toBeTruthy();
    expect(gh.getByRole('heading', { name: t('github.settings.title') })).toBeTruthy();
    const agents = region(t('integrations.group.agents'));
    expect(agents.getByText(t('integrations.group.agentsLead'))).toBeTruthy();
    expect(agents.getByRole('heading', { name: coreT('MCP server') })).toBeTruthy();
    expect(agents.getByRole('heading', { name: t('skill.heading') })).toBeTruthy();
    const imp = region(t('integrations.import.heading'));
    expect(imp.getByText(t('integrations.import.intro'))).toBeTruthy();
    expect(imp.getByRole('button', { name: t('integrations.import.button') })).toBeTruthy();
  });

  it('without github, mcp and importFile only the AI, research and scan groups show, in headings and the jump list', async () => {
    await show(minimalDeps());
    const three = groupLabels().slice(0, 3);
    expect(names(screen.getAllByRole('heading', { level: 4 }))).toEqual(three);
    const toc = within(screen.getByRole('navigation', { name: t('integrations.toc.label') }));
    expect(names(toc.getAllByRole('button'))).toEqual(three);
  });

  it('the jump list has one button per group; click and Enter focus that group heading and scroll it to the top', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { container } = await show(fullDeps());
    const toc = within(screen.getByRole('navigation', { name: t('integrations.toc.label') }));
    const buttons = toc.getAllByRole('button');
    expect(names(buttons)).toEqual(groupLabels());
    // the jump list comes before every group
    const firstGroup = container.querySelector('.integration-category')!;
    expect(buttons[0].compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toc.getByRole('button', { name: t('integrations.group.agents') }));
    const agentsHead = screen.getByRole('heading', { level: 4, name: t('integrations.group.agents') });
    expect(document.activeElement).toBe(agentsHead);
    expect(scroll).toHaveBeenLastCalledWith({ block: 'start' });

    toc.getByRole('button', { name: t('integrations.group.scan') }).focus();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 4, name: t('integrations.group.scan') }));
    toc.getByRole('button', { name: t('integrations.import.heading') }).focus();
    await userEvent.keyboard(' ');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 4, name: t('integrations.import.heading') }));
    expect(scroll).toHaveBeenCalledTimes(3);

    // the headings take focus only from the jump list; they are not Tab stops
    const tabbable = focusableIn(container as HTMLElement);
    for (const h of screen.getAllByRole('heading', { level: 4 })) expect(tabbable).not.toContain(h);
    // @ts-expect-error jsdom has no scrollIntoView; remove the stub again
    delete Element.prototype.scrollIntoView;
  });

  it('a jump still focuses the heading when scrollIntoView is missing (jsdom, old WebView)', async () => {
    await show(minimalDeps());
    const toc = within(screen.getByRole('navigation', { name: t('integrations.toc.label') }));
    fireEvent.click(toc.getByRole('button', { name: t('integrations.group.research') }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 4, name: t('integrations.group.research') }));
  });

  it('focus "partbank" (the Samples tab Connect button) scrolls the PartBank heading up and focuses it', async () => {
    const scroll = vi.fn();
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = scroll;
    try {
      render(<IntegrationSettingsPage deps={fullDeps()} onLeave={async () => {}} focus="partbank" />);
      await act(async () => {});
      const head = screen.getByRole('heading', { level: 5, name: coreT('partbank') });
      expect(document.activeElement).toBe(head);
      expect(head.getAttribute('tabindex')).toBe('-1');
      expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it('without a focus target the PartBank heading is not focused', async () => {
    await show(fullDeps());
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { level: 5, name: coreT('partbank') }));
  });

  it('ko copy keeps "Workflow" in English; en copy has no Hangul', async () => {
    setLang('ko');
    const keys = [
      'integrations.toc.label',
      'integrations.group.ai',
      'integrations.group.aiLead',
      'integrations.group.research',
      'integrations.group.researchLead',
      'integrations.group.scan',
      'integrations.group.scanLead',
      'integrations.group.github',
      'integrations.group.githubLead',
      'integrations.group.agents',
      'integrations.group.agentsLead',
    ] as const;
    const ko = keys.map((k) => t(k));
    expect(t('integrations.group.ai')).toBe('AI 모델과 도구');
    expect(t('integrations.group.research')).toBe('연구 서비스');
    expect(t('integrations.group.researchLead')).toContain('Workflow');
    for (const s of ko) {
      expect(s).not.toMatch(/워크플로|유닛 ?오퍼레이션/);
      expect(s).toMatch(/[가-힣]/);
    }
    await show(fullDeps());
    expect(screen.getByRole('navigation', { name: '연동 설정 바로 가기' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '다른 AI 도구에서 labnoteO 쓰기' })).toBeTruthy();
    setLang('en');
    for (const k of keys) {
      expect(t(k)).not.toBe(ko[keys.indexOf(k)]);
      expect(t(k)).not.toMatch(/[가-힣]/);
    }
  });
});
