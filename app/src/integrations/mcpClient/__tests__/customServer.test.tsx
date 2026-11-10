// @vitest-environment jsdom
/**
 * Task 7: adding and removing custom MCP servers, and the per-tool switches (spec §6.1, §7.1). Rust is a fake `invoke`.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { coreT } from '../../../labnote/i18n';
import { fromPluginData } from '../../../labnote/settings';
import type { IntegrationDeps, IntegrationSettingsValue } from '../../IntegrationSettingsDialog';
import { fakeInvoke, mcpServerInfoOf, secretStatusOf } from '../../__tests__/fakeNet';
import { McpClientSection, mcpClientDepsFor } from '../McpClientSection';
import type { McpSecretFlag, McpServerInfo, McpServerSetting } from '../types';

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
const MINE: McpServerSetting = { id: '0badc0de', name: 'My lab server', url: 'https://mcp.example.org/mcp', auth: 'bearer', enabled: true, tools: {} };

type Routes = Record<string, (args: Record<string, unknown>) => unknown>;

function setup(
  opts: { servers?: McpServerSetting[]; flags?: Record<string, McpSecretFlag>; cached?: Record<string, McpServerInfo>; routes?: Routes } = {},
) {
  const flags: Record<string, McpSecretFlag> = { ...(opts.flags ?? {}) };
  const order: string[] = [];
  const fake = fakeInvoke({
    mcp_client_secret_status: () => ({ ...flags }),
    mcp_client_tools_cached: () => ({ ...(opts.cached ?? {}) }),
    mcp_client_secret_set: (a) => {
      flags[a.id as string] = { set: true, epoch: (flags[a.id as string]?.epoch ?? 0) + 1 };
      return null;
    },
    mcp_client_forget: (a) => {
      order.push(`forget:${a.id as string}`);
      flags[a.id as string] = { set: false, epoch: (flags[a.id as string]?.epoch ?? 0) + 1 };
      return null;
    },
    ...(opts.routes ?? {}),
  });
  let current: IntegrationSettingsValue = { ...BASE, mcpClientServers: opts.servers ?? [] };
  const commit = vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
    if (patch.mcpClientServers) order.push(`commit:${patch.mcpClientServers.map((s) => s.id).join(',')}`);
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
  return { deps, fake, commit, order, current: () => current };
}

async function show(deps: IntegrationDeps) {
  render(<McpClientSection deps={deps} onHide={() => undefined} />);
  await act(async () => {});
}

const rowOf = (name: string) => within(screen.getByRole('group', { name }));
const addForm = () => within(screen.getByRole('group', { name: t('mcpClient.add') }));

describe('per-tool switches', () => {
  const info = mcpServerInfoOf({
    name: 'RAPID',
    tools: [
      { name: 'search_parts', readOnly: true },
      { name: 'order_part', readOnly: false },
      { name: 'drop_all', readOnly: true, destructive: true },
      { name: 'huge', readOnly: true, tooLarge: true },
    ],
  });

  it('preset defaults: read-only on, others off, tooLarge disabled', async () => {
    const { deps } = setup({ servers: [RAPID], cached: { [RAPID.id]: info } });
    await show(deps);
    const sw = (n: string) => rowOf('RAPID').getByRole('switch', { name: n }) as HTMLInputElement;
    expect(sw('search_parts').checked).toBe(true);
    expect(sw('order_part').checked).toBe(false);
    expect(sw('drop_all').checked).toBe(false);
    expect(sw('huge').checked).toBe(false);
    expect(sw('huge').disabled).toBe(true);
    expect(rowOf('RAPID').getByText(t('mcpClient.tool.tooLarge'))).toBeTruthy();
  });

  it('tool rows say read-only or asks each time', async () => {
    const { deps } = setup({ servers: [RAPID], cached: { [RAPID.id]: info } });
    await show(deps);
    const item = (n: string) => within(rowOf('RAPID').getByRole('switch', { name: n }).closest('li')!);
    expect(item('search_parts').getByText(t('mcpClient.tool.readOnly'))).toBeTruthy();
    expect(item('order_part').getByText(t('mcpClient.tool.asks'))).toBeTruthy();
    expect(item('drop_all').getByText(t('mcpClient.tool.asks'))).toBeTruthy();
  });

  it('custom server: every tool is off by default; a switch saves the choice', async () => {
    const mineInfo = mcpServerInfoOf({ name: 'Mine', tools: [{ name: 'lookup', readOnly: true }] });
    const { deps, current } = setup({ servers: [MINE], cached: { [MINE.id]: mineInfo } });
    await show(deps);
    const sw = rowOf(MINE.name).getByRole('switch', { name: 'lookup' }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await act(async () => {
      fireEvent.click(sw);
    });
    expect(current().mcpClientServers?.[0].tools).toEqual({ lookup: true });
    expect((rowOf(MINE.name).getByRole('switch', { name: 'lookup' }) as HTMLInputElement).checked).toBe(true);
  });

  it('switching a default-on preset tool off stores false', async () => {
    const { deps, current } = setup({ servers: [RAPID], cached: { [RAPID.id]: info } });
    await show(deps);
    await act(async () => {
      fireEvent.click(rowOf('RAPID').getByRole('switch', { name: 'search_parts' }));
    });
    expect(current().mcpClientServers?.[0].tools).toEqual({ search_parts: false });
  });
});

describe('add MCP server', () => {
  async function openForm(deps: IntegrationDeps) {
    await show(deps);
    fireEvent.click(screen.getByRole('button', { name: t('mcpClient.add') }));
    return addForm();
  }
  const fill = (f: ReturnType<typeof addForm>, name: string, url: string) => {
    fireEvent.change(f.getByLabelText(t('mcpClient.name')), { target: { value: name } });
    fireEvent.change(f.getByLabelText(t('mcpClient.url')), { target: { value: url } });
  };
  const submit = async (f: ReturnType<typeof addForm>) => {
    await act(async () => {
      fireEvent.click(f.getByRole('button', { name: t('mcpClient.addSave') }));
    });
  };

  it('saves a bearer server with a fresh 8-hex id', async () => {
    const { deps, current, fake } = setup({ servers: [RAPID] });
    const f = await openForm(deps);
    fill(f, '  Lab tools ', 'https://mcp.example.org/mcp');
    await submit(f);
    const saved = current().mcpClientServers ?? [];
    expect(saved).toHaveLength(2);
    const added = saved[1];
    expect(added).toMatchObject({ name: 'Lab tools', url: 'https://mcp.example.org/mcp', auth: 'bearer', enabled: true, tools: {} });
    expect(added.preset).toBeUndefined();
    expect(added.id).toMatch(/^[0-9a-f]{8}$/);
    expect(added.id).not.toBe(RAPID.id);
    // The new row is there with a token field, and it has focus; nothing was contacted.
    expect(document.activeElement).toBe(rowOf('Lab tools').getByLabelText(t('mcpClient.token')));
    expect(fake.calls.map(([cmd]) => cmd).filter((c) => c === 'mcp_client_connect')).toEqual([]);
    expect(screen.queryByRole('group', { name: t('mcpClient.add') })).toBeNull();
  });

  it('saves a no-auth server without a token field', async () => {
    const { deps, current } = setup();
    const f = await openForm(deps);
    fill(f, 'Open', 'https://open.example.org/mcp');
    fireEvent.click(f.getByLabelText(t('mcpClient.auth.none')));
    await submit(f);
    expect(current().mcpClientServers?.[0].auth).toBe('none');
    expect(rowOf('Open').queryByLabelText(t('mcpClient.token'))).toBeNull();
  });

  it('refuses an empty or over-long name', async () => {
    const { deps, commit } = setup();
    const f = await openForm(deps);
    fill(f, '   ', 'https://mcp.example.org/mcp');
    await submit(f);
    expect(f.getByText(t('mcpClient.err.name'))).toBeTruthy();
    fill(f, 'x'.repeat(41), 'https://mcp.example.org/mcp');
    await submit(f);
    expect(f.getByText(t('mcpClient.err.name'))).toBeTruthy();
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses a name with control characters', async () => {
    const { deps, commit } = setup();
    const f = await openForm(deps);
    fill(f, 'a\u0007b', 'https://mcp.example.org/mcp');
    await submit(f);
    expect(f.getByText(t('mcpClient.err.name'))).toBeTruthy();
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses a URL with a query or userinfo', async () => {
    const bad = coreT('Enter a full address starting with http:// or https://.');
    for (const url of ['https://mcp.example.org/mcp?x=1', 'https://user:pw@mcp.example.org/mcp', 'ftp://mcp.example.org']) {
      const { deps, commit } = setup();
      const f = await openForm(deps);
      fill(f, 'Lab', url);
      await submit(f);
      expect(f.getByText(bad)).toBeTruthy();
      expect(commit).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('a secret-looking path shows urlSecret and the URL is not echoed', async () => {
    const secret = 'a1B2c3D4e5F6g7H8i9J0k1L2';
    const { deps, commit } = setup();
    const f = await openForm(deps);
    fill(f, 'Lab', `https://mcp.example.org/mcp/${secret}`);
    await submit(f);
    expect(f.getByText(t('mcpClient.err.urlSecret'))).toBeTruthy();
    expect(document.body.textContent).not.toContain(secret);
    expect(commit).not.toHaveBeenCalled();
  });

  it('http:// on another computer shows the cleartext box; allowing it lets the server be saved', async () => {
    const { deps, current } = setup();
    const f = await openForm(deps);
    fill(f, 'Lab', 'http://mcp.lab.internal/mcp');
    await submit(f);
    expect(f.getByText(coreT('This address is not encrypted, so the API key is sent in the clear.'))).toBeTruthy();
    expect(current().mcpClientServers).toEqual([]);
    await act(async () => {
      fireEvent.click(f.getByLabelText(t('integrations.allowHttp')));
    });
    expect(current().allowHttpOrigins).toContain('http://mcp.lab.internal');
    await submit(f);
    expect(current().mcpClientServers?.[0].url).toBe('http://mcp.lab.internal/mcp');
  });

  it('http:// on loopback needs no permission', async () => {
    const { deps, current } = setup();
    const f = await openForm(deps);
    fill(f, 'Local', 'http://127.0.0.1:9000/mcp');
    await submit(f);
    expect(current().mcpClientServers?.[0].url).toBe('http://127.0.0.1:9000/mcp');
  });

  it('cancel closes the form without saving', async () => {
    const { deps, commit } = setup();
    const f = await openForm(deps);
    fill(f, 'Lab', 'https://mcp.example.org/mcp');
    fireEvent.click(f.getByRole('button', { name: t('integrations.cancel') }));
    expect(screen.queryByRole('group', { name: t('mcpClient.add') })).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('there is no command (stdio) field and no stdio note outside import results', async () => {
    const { deps } = setup();
    await openForm(deps);
    expect(screen.queryByLabelText(/command/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/local command|stdio/i);
  });

  it('the add button is gone at 16 servers', async () => {
    const many = Array.from({ length: 16 }, (_, i): McpServerSetting => ({
      id: `0000000${i.toString(16)}`.slice(-8),
      name: `S${i}`,
      url: `https://s${i}.example.org/mcp`,
      auth: 'none',
      enabled: true,
      tools: {},
    }));
    const { deps } = setup({ servers: many });
    await show(deps);
    expect(screen.queryByRole('button', { name: t('mcpClient.add') })).toBeNull();
  });
});

describe('remove and URL change', () => {
  it('remove forgets the server before the commit drops it', async () => {
    const { deps, order, current } = setup({ servers: [RAPID, MINE], flags: { [MINE.id]: { set: true, epoch: 1 } } });
    await show(deps);
    await act(async () => {
      fireEvent.click(rowOf(MINE.name).getByRole('button', { name: t('mcpClient.remove') }));
    });
    expect(order).toEqual([`forget:${MINE.id}`, `commit:${RAPID.id}`]);
    expect(current().mcpClientServers).toEqual([RAPID]);
    expect(screen.queryByRole('group', { name: MINE.name })).toBeNull();
  });

  it('a failed forget keeps the server and says so', async () => {
    const { deps, commit, current } = setup({
      servers: [MINE],
      routes: {
        mcp_client_forget: () => {
          throw { kind: 'keychain', message: 'keychain refused' };
        },
      },
    });
    await show(deps);
    await act(async () => {
      fireEvent.click(rowOf(MINE.name).getByRole('button', { name: t('mcpClient.remove') }));
    });
    expect(commit).not.toHaveBeenCalled();
    expect(current().mcpClientServers).toEqual([MINE]);
    expect(rowOf(MINE.name).getByText(t('mcpClient.err.remove'))).toBeTruthy();
  });

  it('presets have no remove button', async () => {
    const { deps } = setup({ servers: [RAPID], flags: { [RAPID.id]: { set: true, epoch: 1 } } });
    await show(deps);
    expect(rowOf('RAPID').queryByRole('button', { name: t('mcpClient.remove') })).toBeNull();
    expect(rowOf('RAPID').getByRole('button', { name: t('mcpClient.removeToken') })).toBeTruthy();
  });

  it('changing a custom server URL forgets first, then commits; the token shows not set', async () => {
    const { deps, order, current } = setup({ servers: [MINE], flags: { [MINE.id]: { set: true, epoch: 1 } } });
    await show(deps);
    expect(rowOf(MINE.name).getByText(t('integrations.keySet'))).toBeTruthy();
    fireEvent.click(rowOf(MINE.name).getByRole('button', { name: t('mcpClient.changeUrl') }));
    const url = rowOf(MINE.name).getByLabelText(t('mcpClient.url')) as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://other.example.org/mcp' } });
    await act(async () => {
      fireEvent.blur(url);
    });
    expect(order).toEqual([`forget:${MINE.id}`, `commit:${MINE.id}`]);
    expect(current().mcpClientServers?.[0].url).toBe('https://other.example.org/mcp');
    expect(rowOf(MINE.name).getByText(t('integrations.keyNotSet'))).toBeTruthy();
  });
});
