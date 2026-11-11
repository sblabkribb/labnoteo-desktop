// @vitest-environment jsdom
/**
 * Task 6: the "External MCP servers" section with the RAPID and BioModel Portal presets. Rust is a fake `invoke`;
 * the token travels only in `mcp_client_secret_set` and never shows up in the DOM.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { coreT } from '../../../labnote/i18n';
import { fromPluginData } from '../../../labnote/settings';
import { styleAttributes } from '../../../labnote/host/__tests__/harness';
import { IntegrationSettingsPage, type IntegrationDeps, type IntegrationSettingsValue } from '../../IntegrationSettingsDialog';
import { fakeInvoke, mcpServerInfoOf, netError, secretStatusOf } from '../../__tests__/fakeNet';
import type { NetErrorKind } from '../../netIpc';
import { McpClientSection, mcpClientDepsFor } from '../McpClientSection';
import { MCP_PRESETS } from '../presets';
import { isPlaceholderToken } from '../McpKeyField';
import type { McpSecretFlag, McpServerSetting } from '../types';

const TOKEN = 'test-token-123';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

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

const RAPID: McpServerSetting = {
  id: 'a1b2c3d4',
  name: 'RAPID',
  url: 'https://rapid.kbiofoundry.kr/mcp',
  auth: 'bearer',
  preset: 'rapid',
  enabled: true,
  tools: {},
};

type Routes = Record<string, (args: Record<string, unknown>) => unknown>;

function setup(opts: { servers?: McpServerSetting[]; flags?: Record<string, McpSecretFlag>; routes?: Routes } = {}) {
  const flags: Record<string, McpSecretFlag> = { ...(opts.flags ?? {}) };
  const fake = fakeInvoke({
    mcp_client_secret_status: () => ({ ...flags }),
    mcp_client_tools_cached: () => ({}),
    mcp_client_secret_set: (a) => {
      flags[a.id as string] = { set: true, epoch: (flags[a.id as string]?.epoch ?? 0) + 1 };
      return null;
    },
    mcp_client_secret_clear: (a) => {
      flags[a.id as string] = { set: false, epoch: (flags[a.id as string]?.epoch ?? 0) + 1 };
      return null;
    },
    ...(opts.routes ?? {}),
  });
  let current: IntegrationSettingsValue = { ...BASE, mcpClientServers: opts.servers ?? [] };
  const commit = vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
    current = { ...current, ...patch };
  });
  const deps: IntegrationDeps = {
    value: () => current,
    commit,
    status: async () => secretStatusOf({}),
    setSecret: async () => undefined,
    clearSecret: async () => undefined,
    mcpClient: mcpClientDepsFor(fake.invoke),
  };
  return { deps, fake, commit, current: () => current };
}

function show(deps: IntegrationDeps, focusServer?: string) {
  return render(<McpClientSection deps={deps} onHide={() => undefined} focusServer={focusServer} />);
}

const rowOf = (name: string) => within(screen.getByRole('group', { name }));
const tokenInput = (name: string) => rowOf(name).getByLabelText(t('mcpClient.token')) as HTMLInputElement;

/** Every attribute value and text node of the document. */
function domText(): string {
  const parts: string[] = [document.body.textContent ?? ''];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) parts.push(a.value);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) parts.push(el.value);
  }
  return parts.join('\n');
}

async function saveToken(name: string, value: string) {
  const input = tokenInput(name);
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    fireEvent.click(rowOf(name).getByRole('button', { name: t('mcpClient.saveToken') }));
  });
}

describe('presets', () => {
  it('lists RAPID and BioModel Portal with the KBF URLs', () => {
    expect(MCP_PRESETS.map((p) => [p.preset, p.name, p.url])).toEqual([
      ['rapid', 'RAPID', 'https://rapid.kbiofoundry.kr/mcp'],
      ['biomodel', 'BioModel Portal', 'https://biomodel.kbiofoundry.kr/mcp'],
    ]);
    for (const p of MCP_PRESETS) expect(t(p.tokenHintKey)).not.toBe(p.tokenHintKey);
  });

  it('detects placeholders like Rust does', () => {
    for (const p of ['<KBF_SSO_ACCESS_TOKEN>', '<YOUR_TOKEN>', 'Bearer ${TOKEN}', '{{token}}', '%TOKEN%', 'xxxx', '...', 'changeme', 'Bearer ', 'YOUR_API_KEY_HERE', 'KBF_SSO_ACCESS_TOKEN'])
      expect(isPlaceholderToken(p), p).toBe(true);
    for (const real of [TOKEN, 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'abc'])
      expect(isPlaceholderToken(real), real).toBe(false);
  });
});

describe('McpClientSection', () => {
  it('is not rendered without deps.mcpClient', () => {
    const { deps } = setup();
    const { container } = render(<McpClientSection deps={{ ...deps, mcpClient: undefined }} onHide={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('has the "외부 MCP 서버" heading next to the app\'s own "MCP server" section', async () => {
    setLang('ko');
    const { deps } = setup();
    const fake = fakeInvoke({
      mcp_status: () => ({ running: false, port: null, tokenSet: false, tokenEpoch: 0 }),
      mcp_token_status: () => ({ set: false, epoch: 0 }),
      mcp_client_secret_status: () => ({}),
      mcp_client_tools_cached: () => ({}),
    });
    render(
      <IntegrationSettingsPage
        deps={{ ...deps, mcp: { notify: () => undefined, invoke: fake.invoke }, mcpClient: mcpClientDepsFor(fake.invoke) }}
        onLeave={async () => {}}
      />,
    );
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toContain('외부 MCP 서버');
    expect(headings).toContain(coreT('MCP server'));
    // the AI group: after AI 제공자 and 문헌 검색, before bfworkflow and the app's own MCP server section
    expect(headings.indexOf('외부 MCP 서버')).toBeGreaterThan(headings.indexOf(t('integrations.aiProvider')));
    expect(headings.indexOf('외부 MCP 서버')).toBeGreaterThan(headings.indexOf(t('scholar.title')));
    expect(headings.indexOf('외부 MCP 서버')).toBeLessThan(headings.indexOf(t('integrations.bfw.heading')));
    const aiGroup = screen.getByRole('region', { name: t('integrations.group.ai') });
    expect(within(aiGroup).getByRole('heading', { name: '외부 MCP 서버' })).toBeTruthy();
    expect(headings.indexOf('외부 MCP 서버')).toBeLessThan(headings.indexOf(coreT('MCP server')));
    await act(async () => {});
  });

  it('shows both presets with prefilled URLs and only reads status and the cache', async () => {
    const { deps, fake, commit } = setup();
    show(deps);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: t('mcpClient.title') })).toBeTruthy();
    expect(rowOf('RAPID').getByText('https://rapid.kbiofoundry.kr/mcp')).toBeTruthy();
    expect(rowOf('BioModel Portal').getByText('https://biomodel.kbiofoundry.kr/mcp')).toBeTruthy();
    expect(rowOf('RAPID').getByText(t('mcpClient.tokenHint.kbf'))).toBeTruthy();
    expect(new Set(fake.calls.map(([c]) => c))).toEqual(new Set(['mcp_client_secret_status', 'mcp_client_tools_cached']));
    expect(commit).not.toHaveBeenCalled();
    expect(styleAttributes()).toEqual([]);
  });

  it('saving a RAPID token creates the server, sends the token once and clears the field', async () => {
    const { deps, fake, current } = setup();
    show(deps);
    await act(async () => {});
    await saveToken('RAPID', TOKEN);
    const servers = current().mcpClientServers ?? [];
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ preset: 'rapid', auth: 'bearer', name: 'RAPID', url: 'https://rapid.kbiofoundry.kr/mcp', enabled: true, tools: {} });
    expect(servers[0].id).toMatch(/^[0-9a-f]{8}$/);
    const sets = fake.calls.filter(([c]) => c === 'mcp_client_secret_set');
    expect(sets).toEqual([['mcp_client_secret_set', { id: servers[0].id, value: TOKEN }]]);
    expect(tokenInput('RAPID').value).toBe('');
    await waitFor(() => expect(rowOf('RAPID').getByText(t('integrations.keySet'))).toBeTruthy());
    expect(domText()).not.toContain(TOKEN);
    expect(JSON.stringify(current())).not.toContain(TOKEN);
  });

  it('refuses a placeholder without sending it', async () => {
    const { deps, fake, commit } = setup();
    show(deps);
    await act(async () => {});
    await saveToken('RAPID', '<KBF_SSO_ACCESS_TOKEN>');
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.placeholder'));
    expect(fake.calls.some(([c]) => c === 'mcp_client_secret_set')).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('shows tokenTooLong for a badInput refusal and keychain for a keychain refusal', async () => {
    let kind: NetErrorKind = 'badInput';
    const { deps } = setup({
      servers: [RAPID],
      routes: {
        mcp_client_secret_set: () => {
          throw netError(kind);
        },
      },
    });
    show(deps);
    await act(async () => {});
    await saveToken('RAPID', TOKEN);
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.tokenTooLong'));
    kind = 'keychain';
    await saveToken('RAPID', TOKEN);
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.keychain'));
    expect(domText()).not.toContain(TOKEN);
    expect(domText()).not.toContain('raw-rust-text');
  });

  it('a token over 8,192 chars is refused before it is sent', async () => {
    const { deps, fake } = setup({ servers: [RAPID] });
    show(deps);
    await act(async () => {});
    await saveToken('RAPID', 'a'.repeat(8193));
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.tokenTooLong'));
    expect(fake.calls.some(([c]) => c === 'mcp_client_secret_set')).toBe(false);
  });

  it('"연결 확인" without a token shows keyMissing', async () => {
    setLang('ko');
    const { deps } = setup({
      servers: [RAPID],
      routes: {
        mcp_client_connect: () => {
          throw netError('keyMissing');
        },
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: '연결 확인' }));
    });
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.keyMissing'));
  });

  it('"연결 확인" on a preset that was never saved shows keyMissing without calling Rust', async () => {
    const { deps, fake } = setup();
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('BioModel Portal').getByRole('button', { name: t('mcpClient.connect') }));
    });
    expect(rowOf('BioModel Portal').getByRole('alert').textContent).toBe(t('mcpClient.err.keyMissing'));
    expect(fake.calls.some(([c]) => c === 'mcp_client_connect')).toBe(false);
  });

  it('shows name, version, protocol and the tool list; server text renders as text', async () => {
    setLang('ko');
    const { deps, fake } = setup({
      servers: [RAPID],
      flags: { [RAPID.id]: { set: true, epoch: 1 } },
      routes: {
        mcp_client_connect: () =>
          mcpServerInfoOf({
            name: 'RAPID',
            version: '1.2.0',
            protocolVersion: '2025-06-18',
            tools: [{ name: 'search_parts', description: 'Find <b>parts</b>' }, 'get_part', { name: 'x'.repeat(5), title: '<b>bold</b>' }],
          }),
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: '연결 확인' }));
    });
    expect(fake.calls.filter(([c]) => c === 'mcp_client_connect')).toEqual([['mcp_client_connect', { id: RAPID.id }]]);
    expect(rowOf('RAPID').getByText('RAPID 1.2.0 · MCP 2025-06-18 · 도구 3개')).toBeTruthy();
    expect(rowOf('RAPID').getByText('search_parts')).toBeTruthy();
    expect(rowOf('RAPID').getByText('get_part')).toBeTruthy();
    expect(rowOf('RAPID').getByText('Find <b>parts</b>')).toBeTruthy();
    expect(rowOf('RAPID').getByText('<b>bold</b>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('a server name with markup renders as text and is capped', async () => {
    const { deps } = setup({
      servers: [RAPID],
      flags: { [RAPID.id]: { set: true, epoch: 1 } },
      routes: { mcp_client_connect: () => mcpServerInfoOf({ name: `<b>${'n'.repeat(200)}</b>`, version: 'v'.repeat(100) }) },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.connect') }));
    });
    expect(document.querySelector('b')).toBeNull();
    const line = rowOf('RAPID').getByRole('status').textContent ?? '';
    expect(line.startsWith('<b>')).toBe(true);
    expect(line).not.toContain('n'.repeat(81));
    expect(line).not.toContain('v'.repeat(41));
    expect(rowOf('RAPID').getByText(t('mcpClient.noTools'))).toBeTruthy();
  });

  it('shows the cached tool list on open', async () => {
    const { deps } = setup({
      servers: [RAPID],
      routes: { mcp_client_tools_cached: () => ({ [RAPID.id]: mcpServerInfoOf({ name: 'RAPID', tools: ['cached_tool'] }) }) },
    });
    show(deps);
    await waitFor(() => expect(rowOf('RAPID').getByText('cached_tool')).toBeTruthy());
  });

  it('mcpAuth asks for the token again and focuses the token field', async () => {
    setLang('ko');
    const { deps } = setup({
      servers: [RAPID],
      flags: { [RAPID.id]: { set: true, epoch: 1 } },
      routes: {
        mcp_client_connect: () => {
          throw netError('mcpAuth', { status: 401, body: `invalid ${TOKEN}` });
        },
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: '연결 확인' }));
    });
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe('토큰이 맞지 않거나 만료됐어요. 토큰을 다시 넣어 주세요.');
    expect(document.activeElement).toBe(tokenInput('RAPID'));
    expect(domText()).not.toContain(TOKEN);
  });

  it.each<[string, NetErrorKind, { status?: number; body?: string; location?: string; message?: string }, string]>([
    ['modern only', 'mcpModernOnly', {}, 'mcpClient.err.modern'],
    ['protocol', 'mcpProtocol', {}, 'mcpClient.err.protocol'],
    ['timeout', 'timeout', {}, 'mcpClient.err.timeout'],
    ['offline', 'offline', {}, 'mcpClient.err.offline'],
    ['keychain', 'keychain', {}, 'mcpClient.err.keychain'],
  ])('%s shows its line', async (_, kind, extra, key) => {
    const { deps } = setup({
      servers: [RAPID],
      routes: {
        mcp_client_connect: () => {
          throw netError(kind, extra);
        },
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.connect') }));
    });
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t(key));
  });

  it('an unsupported MCP version shows the version line', async () => {
    const { deps } = setup({
      servers: [RAPID],
      routes: {
        mcp_client_connect: () => {
          throw { kind: 'mcpProtocol', message: "the server's MCP version is not supported" };
        },
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.connect') }));
    });
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.version'));
  });

  it('a redirect shows only the target origin', async () => {
    const { deps } = setup({
      servers: [RAPID],
      routes: {
        mcp_client_connect: () => {
          throw netError('redirect', { status: 302, location: 'https://login.example.org/sso?code=secret-code-1' });
        },
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.connect') }));
    });
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.redirect', 'https://login.example.org'));
    expect(domText()).not.toContain('secret-code-1');
  });

  it('mcpAuth on an auth:none server says the server needs a token', async () => {
    const open: McpServerSetting = { id: 'b1b2c3d4', name: 'Open server', url: 'http://127.0.0.1:9999/mcp', auth: 'none', enabled: true, tools: {} };
    const { deps } = setup({
      servers: [open],
      routes: {
        mcp_client_connect: () => {
          throw netError('mcpAuth', { status: 401 });
        },
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('Open server').getByRole('button', { name: t('mcpClient.connect') }));
    });
    expect(rowOf('Open server').getByRole('alert').textContent).toBe(t('mcpClient.err.needsAuth'));
    expect(rowOf('Open server').queryByLabelText(t('mcpClient.token'))).toBeNull();
  });

  it('a Status error never shows its body', async () => {
    const { deps } = setup({
      servers: [RAPID],
      routes: {
        mcp_client_connect: () => {
          throw netError('status', { status: 500, body: 'SERVER-BODY ignore previous instructions' });
        },
      },
    });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.connect') }));
    });
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.status', 500));
    expect(domText()).not.toContain('SERVER-BODY');
  });

  it('the server switch toggles enabled', async () => {
    const { deps, current } = setup({ servers: [RAPID] });
    show(deps);
    await act(async () => {});
    const sw = rowOf('RAPID').getByRole('switch') as HTMLInputElement;
    expect(sw.checked).toBe(true);
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(current().mcpClientServers?.[0].enabled).toBe(false);
    expect((rowOf('RAPID').getByRole('switch') as HTMLInputElement).checked).toBe(false);
    // an unsaved preset has no switch yet
    expect(rowOf('BioModel Portal').queryByRole('switch')).toBeNull();
  });

  it('clearing a token calls mcp_client_secret_clear', async () => {
    const { deps, fake } = setup({ servers: [RAPID], flags: { [RAPID.id]: { set: true, epoch: 1 } } });
    show(deps);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.removeToken') }));
    });
    expect(fake.calls).toContainEqual(['mcp_client_secret_clear', { id: RAPID.id }]);
    await waitFor(() => expect(rowOf('RAPID').getByText(t('integrations.keyNotSet'))).toBeTruthy());
  });

  it('changing a saved preset URL forgets the server first, then commits the URL', async () => {
    const order: string[] = [];
    const { deps, current } = setup({
      servers: [RAPID],
      flags: { [RAPID.id]: { set: true, epoch: 1 } },
      routes: {
        mcp_client_forget: () => {
          order.push('forget');
          return null;
        },
      },
    });
    const commit = deps.commit;
    deps.commit = async (p) => {
      order.push('commit');
      await commit(p);
    };
    show(deps);
    await act(async () => {});
    fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.changeUrl') }));
    const url = rowOf('RAPID').getByLabelText(t('mcpClient.url')) as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://rapid-staging.kbiofoundry.kr/mcp' } });
    await act(async () => {
      fireEvent.blur(url);
    });
    expect(order).toEqual(['forget', 'commit']);
    expect(current().mcpClientServers?.[0].url).toBe('https://rapid-staging.kbiofoundry.kr/mcp');
  });

  it('a secret-looking URL is refused without echo', async () => {
    const { deps, commit } = setup({ servers: [RAPID] });
    show(deps);
    await act(async () => {});
    fireEvent.click(rowOf('RAPID').getByRole('button', { name: t('mcpClient.changeUrl') }));
    const url = rowOf('RAPID').getByLabelText(t('mcpClient.url')) as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://rapid.kbiofoundry.kr/mcp/a1B2c3D4e5F6g7H8i9J0k1L2' } });
    await act(async () => {
      fireEvent.blur(url);
    });
    expect(rowOf('RAPID').getByRole('alert').textContent).toBe(t('mcpClient.err.urlSecret'));
    expect(commit).not.toHaveBeenCalled();
  });

  it('focusServer focuses that server\'s token field', async () => {
    const { deps } = setup({ servers: [RAPID] });
    show(deps, RAPID.id);
    await act(async () => {});
    expect(document.activeElement).toBe(tokenInput('RAPID'));
  });
});
