// @vitest-environment jsdom
/**
 * MCP settings, `toggle-mcp-server` and the per-vault start and stop (Task 37). Rust is a fake `invoke`
 * that keeps a running flag; the token itself never exists on this side (only `{set, epoch}`).
 */
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NotifyKind } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { fakeInvoke } from '../../../integrations/__tests__/fakeNet';
import type { ListenFn } from '../../../integrations/netIpc';
import type { CommandContext } from '../../commands/context';
import { styleAttributes } from '../../host/__tests__/harness';
import { coreT } from '../../i18n';
import { fromPluginData, type AppSettings } from '../../settings';
import { MCP_CLIENTS, clientSnippet, startMcpForVault, toggleMcpServer } from '../commands';
import { McpSection } from '../McpSection';
import { toolCatalog } from '../mcpHost';

const SNIPPETS: { port: number; token: string; snippets: Record<string, string> } = JSON.parse(
  readFileSync('src-tauri/tests/mcp-snippets.json', 'utf-8'),
);

beforeEach(() => setLang('en'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Notes = Array<{ kind: NotifyKind; message: string }>;

/** Rust as a fake: `mcp_start` / `mcp_stop` flip `running`; extra routes override. */
function fakeRust(routes: Record<string, (args: Record<string, unknown>) => unknown> = {}, token = { set: true, epoch: 3 }) {
  let running = false;
  let port: number | null = null;
  const status = () => ({ running, port, tokenSet: token.set, tokenEpoch: token.epoch });
  return fakeInvoke({
    mcp_status: () => status(),
    mcp_start: (a) => {
      running = true;
      port = a.port as number;
      return status();
    },
    mcp_stop: () => {
      running = false;
      port = null;
      return null;
    },
    mcp_drain: () => 0,
    mcp_token_status: () => ({ ...token }),
    mcp_token_regenerate: () => {
      token = { set: true, epoch: token.epoch + 1 };
      return { ...token };
    },
    mcp_token_copy: () => null,
    ...routes,
  });
}

function fakeCtx(settings: Partial<AppSettings> = {}) {
  let current: AppSettings = { ...fromPluginData(undefined), ...settings };
  const notes: Notes = [];
  const updateSettings = vi.fn(async (p: Partial<AppSettings>) => {
    current = { ...current, ...p };
  });
  const ctx = {
    host: { notify: (kind: NotifyKind, message: string) => notes.push({ kind, message }) },
    get settings() {
      return current;
    },
    updateSettings,
    activeView: () => undefined,
  } as unknown as CommandContext;
  return { ctx, notes, updateSettings };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => undefined);
}

function section(r: ReturnType<typeof fakeRust>, value: { mcpEnabled: boolean; mcpPort: number } = { mcpEnabled: false, mcpPort: 3987 }) {
  const notes: Notes = [];
  const commit = vi.fn(async () => undefined);
  render(
    <McpSection
      enabled={value.mcpEnabled}
      port={value.mcpPort}
      commit={commit}
      notify={(kind, message) => notes.push({ kind, message })}
      invoke={r.invoke}
    />,
  );
  return { notes, commit };
}

const cmds = (r: ReturnType<typeof fakeRust>) => r.calls.map(([c]) => c);

describe('toggle-mcp-server', () => {
  it('starts with the tool catalog and the saved port, and stops again', async () => {
    const r = fakeRust();
    const { ctx, notes, updateSettings } = fakeCtx({ mcpPort: 4000 });
    await toggleMcpServer(ctx, r.invoke);
    const start = r.calls.find(([c]) => c === 'mcp_start')!;
    expect(start[1]).toEqual({ port: 4000, tools: toolCatalog() });
    expect(notes).toEqual([{ kind: 'info', message: coreT('MCP server started on 127.0.0.1:{0}', '4000') }]);
    expect(updateSettings).toHaveBeenLastCalledWith({ mcpEnabled: true });

    r.calls.length = 0;
    await toggleMcpServer(ctx, r.invoke);
    expect(cmds(r)).toEqual(['mcp_status', 'mcp_drain', 'mcp_stop']);
    expect(updateSettings).toHaveBeenLastCalledWith({ mcpEnabled: false });
    expect(notes).toHaveLength(1); // no "stopped" notice
  });

  it('port in use and other bind errors give the plugin notices and leave the setting as it was', async () => {
    const busy = fakeRust({
      mcp_start: () => {
        throw { kind: 'portInUse', message: 'raw' };
      },
    });
    const a = fakeCtx();
    await toggleMcpServer(a.ctx, busy.invoke);
    expect(a.notes).toEqual([{ kind: 'error', message: coreT('MCP server port {0} is already in use.', '3987') }]);
    expect(a.updateSettings).not.toHaveBeenCalled();

    const denied = fakeRust({
      mcp_start: () => {
        throw { kind: 'io', message: 'denied' };
      },
    });
    const b = fakeCtx();
    await toggleMcpServer(b.ctx, denied.invoke);
    expect(b.notes).toEqual([{ kind: 'error', message: coreT('MCP server error: {0}', 'denied') }]);
    expect(b.updateSettings).not.toHaveBeenCalled();
  });
});

describe('the server follows the open vault', () => {
  it('starts on open when enabled, listens always, and drains, stops and unlistens on a switch', async () => {
    const r = fakeRust();
    const { ctx, notes, updateSettings } = fakeCtx({ mcpEnabled: true, mcpPort: 4100 });
    const unlisten = vi.fn();
    const listen = vi.fn(async () => unlisten) as unknown as ListenFn;
    const stop = startMcpForVault(ctx, { invoke: r.invoke, listen });
    await flush();
    expect(r.calls.find(([c]) => c === 'mcp_start')?.[1]).toEqual({ port: 4100, tools: toolCatalog() });
    expect(listen).toHaveBeenCalledTimes(2); // mcp://call and mcp://cancel
    expect(notes[0].message).toBe(coreT('MCP server started on 127.0.0.1:{0}', '4100'));
    r.calls.length = 0;
    stop();
    await flush();
    expect(cmds(r)).toEqual(['mcp_drain', 'mcp_stop']);
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('a vault with the server off starts nothing; a bind error keeps the setting on', async () => {
    const off = fakeRust();
    const a = fakeCtx({ mcpEnabled: false });
    const listen = (async () => () => undefined) as unknown as ListenFn;
    startMcpForVault(a.ctx, { invoke: off.invoke, listen })();
    await flush();
    expect(cmds(off)).not.toContain('mcp_start');

    const busy = fakeRust({
      mcp_start: () => {
        throw { kind: 'portInUse', message: 'raw' };
      },
    });
    const b = fakeCtx({ mcpEnabled: true });
    startMcpForVault(b.ctx, { invoke: busy.invoke, listen });
    await flush();
    expect(b.notes).toEqual([{ kind: 'error', message: coreT('MCP server port {0} is already in use.', '3987') }]);
    expect(b.updateSettings).not.toHaveBeenCalled();
    expect(b.ctx.settings.mcpEnabled).toBe(true);
  });

  it('a stop asked while a start is still binding runs after it', async () => {
    let release!: () => void;
    const r = fakeRust({
      mcp_start: () => new Promise((res) => (release = () => res({ running: true, port: 3987, tokenSet: true, tokenEpoch: 0 }))),
    });
    const { ctx } = fakeCtx({ mcpEnabled: true });
    const stop = startMcpForVault(ctx, { invoke: r.invoke, listen: (async () => () => undefined) as unknown as ListenFn });
    await flush();
    stop();
    await flush();
    expect(cmds(r)).toEqual(['mcp_start']);
    release();
    await flush();
    expect(cmds(r)).toEqual(['mcp_start', 'mcp_drain', 'mcp_stop']);
  });
});

describe('McpSection', () => {
  it('never renders a token, only its number', async () => {
    const r = fakeRust();
    section(r);
    expect(await screen.findByText(t('mcp.tokenIssued', 3))).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{48}/);
    expect(styleAttributes()).toEqual([]);
    cleanup();
    section(fakeRust({}, { set: false, epoch: 0 }));
    expect(await screen.findByText(t('mcp.tokenNone'))).toBeTruthy();
  });

  it('Copy token copies from Rust and says it is cleared after 60 s', async () => {
    const r = fakeRust();
    const { notes } = section(r);
    fireEvent.click(await screen.findByRole('button', { name: coreT('Copy token') }));
    await flush();
    expect(r.calls.find(([c]) => c === 'mcp_token_copy')?.[1]).toEqual({ snippet: null });
    expect(notes).toEqual([{ kind: 'info', message: t('mcp.tokenCopied') }]);
  });

  it('Regenerate needs a second click within 5 s and says the old token stopped working', async () => {
    vi.useFakeTimers();
    const r = fakeRust();
    const { notes } = section(r);
    await flush();
    const button = screen.getByRole('button', { name: coreT('Regenerate token') });
    fireEvent.click(button);
    expect(button.textContent).toBe(coreT('Click again to regenerate'));
    expect(button.className).toContain('danger');
    expect(cmds(r)).not.toContain('mcp_token_regenerate');
    await act(async () => {
      vi.advanceTimersByTime(5001);
    });
    expect(button.textContent).toBe(coreT('Regenerate token'));
    expect(button.className).not.toContain('danger');

    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    const order = cmds(r).filter((c) => c.startsWith('mcp_token_regenerate') || c === 'mcp_token_copy');
    expect(order).toEqual(['mcp_token_regenerate', 'mcp_token_copy']);
    expect(notes[0]).toEqual({ kind: 'info', message: coreT('New MCP token issued. The old token no longer works.') });
    expect(screen.getByText(t('mcp.tokenIssued', 4))).toBeTruthy();
    expect(button.textContent).toBe(coreT('Regenerate token'));
  });

  it('a failed copy after regenerate says to use Copy token', async () => {
    const r = fakeRust({
      mcp_token_copy: () => {
        throw { kind: 'clipboard', message: 'the clipboard could not be written' };
      },
    });
    const { notes } = section(r);
    const button = await screen.findByRole('button', { name: coreT('Regenerate token') });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(notes.map((n) => n.message)).toEqual([
      coreT('New MCP token issued. The old token no longer works.'),
      coreT('The new token could not be copied. Use "Copy token".'),
    ]);
  });

  it('the switch starts and stops the server and saves the setting; the status line shows the address', async () => {
    const r = fakeRust();
    const { commit } = section(r);
    const toggle = (await screen.findByRole('checkbox', { name: coreT('Enable MCP server') })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await flush();
    expect(r.calls.find(([c]) => c === 'mcp_start')?.[1]).toEqual({ port: 3987, tools: toolCatalog() });
    expect(commit).toHaveBeenLastCalledWith({ mcpEnabled: true });
    expect(screen.getByText(t('mcp.listening', 3987))).toBeTruthy();
    fireEvent.click(toggle);
    await flush();
    expect(cmds(r).slice(-2)).toEqual(['mcp_drain', 'mcp_stop']);
    expect(commit).toHaveBeenLastCalledWith({ mcpEnabled: false });
    expect(screen.queryByText(t('mcp.listening', 3987))).toBeNull();
  });

  it('a new port is saved on blur and restarts a running server; an invalid one is not saved', async () => {
    const r = fakeRust();
    await r.invoke('mcp_start', { port: 3987, tools: [] });
    const { commit } = section(r, { mcpEnabled: true, mcpPort: 3987 });
    const field = (await screen.findByLabelText(t('mcp.port'))) as HTMLInputElement;
    await flush();
    fireEvent.change(field, { target: { value: '80' } });
    fireEvent.blur(field);
    await flush();
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByText(t('mcp.portInvalid'))).toBeTruthy();
    r.calls.length = 0;
    fireEvent.change(field, { target: { value: '5000' } });
    fireEvent.blur(field);
    await flush();
    expect(commit).toHaveBeenCalledWith({ mcpPort: 5000 });
    expect(r.calls.find(([c]) => c === 'mcp_start')?.[1]).toEqual({ port: 5000, tools: toolCatalog() });
    expect(screen.getByText(t('mcp.listening', 5000))).toBeTruthy();
  });

  it('Connect a client shows each setup with a token placeholder and copies it, token filled in, from Rust', async () => {
    expect(MCP_CLIENTS.map((c) => c.id)).toEqual(Object.keys(SNIPPETS.snippets));
    for (const c of MCP_CLIENTS) expect(clientSnippet(c.id, SNIPPETS.port)).toBe(SNIPPETS.snippets[c.id]);
    const r = fakeRust();
    const { notes } = section(r);
    await flush();
    for (const c of MCP_CLIENTS) expect(document.body.textContent).toContain(SNIPPETS.snippets[c.id]);
    fireEvent.click(screen.getByRole('button', { name: t('mcp.connect.copy', 'Claude Code') }));
    await flush();
    expect(r.calls.find(([c]) => c === 'mcp_token_copy')?.[1]).toEqual({ snippet: { client: 'claudeCode', port: 3987 } });
    expect(notes).toEqual([{ kind: 'info', message: t('mcp.connect.copied', 'Claude Code') }]);
  });

  it('no MCP section text names Obsidian, in ko and en', async () => {
    for (const lang of ['ko', 'en'] as const) {
      setLang(lang);
      section(fakeRust());
      await flush();
      expect(document.body.textContent).toContain(coreT('MCP server'));
      expect(document.body.textContent).not.toContain('Obsidian');
      cleanup();
    }
  });
});
