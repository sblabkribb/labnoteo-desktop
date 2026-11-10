// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { fromPluginData } from '../../labnote/settings';
import { styleAttributes } from '../../labnote/host/__tests__/harness';
import { IntegrationSettingsPage, type IntegrationDeps, type IntegrationSettingsValue } from '../IntegrationSettingsDialog';
import type { ImportOutcome } from '../importFile';
import type { McpClientDeps } from '../mcpClient/McpClientSection';
import type { McpServerSetting } from '../mcpClient/types';
import { secretStatusOf } from './fakeNet';

beforeEach(() => setLang('ko'));
afterEach(() => {
  cleanup();
  setLang('en');
});

const TOKEN = 'test-token-rapid-123';
const PASTED = JSON.stringify({
  mcpServers: {
    rapid: { url: 'https://rapid.kbiofoundry.kr/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
    biomodel: { url: 'https://biomodel.kbiofoundry.kr/mcp', headers: { Authorization: 'Bearer <KBF_SSO_ACCESS_TOKEN>' } },
    fs: { command: 'npx', args: ['-y', 'server-fs'] },
  },
});

const SERVERS: McpServerSetting[] = [
  { id: '0a1b2c3d', name: 'RAPID', url: 'https://rapid.kbiofoundry.kr/mcp', auth: 'bearer', preset: 'rapid', enabled: true, tools: {} },
  { id: '0a1b2c3e', name: 'BioModel Portal', url: 'https://biomodel.kbiofoundry.kr/mcp', auth: 'bearer', preset: 'biomodel', enabled: true, tools: {} },
];

/** Rust `integration_import_bytes` 의 답(가짜). 토큰은 들어 있지 않다. */
const OUTCOME: ImportOutcome = {
  status: 'done',
  imported: [],
  invalid: [
    { part: 'mcpServer', field: 'command', reason: 'stdioSkipped', name: 'fs' },
    { part: 'mcpServer', field: 'headers', reason: 'needsToken', name: 'BioModel Portal' },
  ],
  mcp: [
    { id: '0a1b2c3d', name: 'RAPID', origin: 'https://rapid.kbiofoundry.kr', preset: 'rapid', tokenStored: true, needsToken: false },
    { id: '0a1b2c3e', name: 'BioModel Portal', origin: 'https://biomodel.kbiofoundry.kr', preset: 'biomodel', tokenStored: false, needsToken: true },
  ],
  settings: { mcpClientServers: SERVERS },
};

function deps(outcome: ImportOutcome = OUTCOME) {
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
    mcpClientServers: [],
  };
  const seen: Uint8Array[] = [];
  const sent: string[] = [];
  const io = {
    run: vi.fn(async (): Promise<ImportOutcome | null> => outcome),
    runBytes: vi.fn(async (name: string, bytes: Uint8Array): Promise<ImportOutcome> => {
      seen.push(bytes);
      sent.push(`${name}:${new TextDecoder().decode(bytes)}`);
      return outcome;
    }),
    remove: vi.fn(async () => 'trashed' as const),
  };
  const mcpClient: McpClientDeps = {
    secretSet: vi.fn(async () => undefined),
    secretClear: vi.fn(async () => undefined),
    secretStatus: vi.fn(async () => ({ '0a1b2c3d': { set: true, epoch: 1 } })),
    connect: vi.fn(async () => {
      throw new Error('not used');
    }),
    forget: vi.fn(async () => undefined),
    toolsCached: vi.fn(async () => ({})),
  };
  const d: IntegrationDeps = {
    value: () => current,
    commit: vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
      current = { ...current, ...patch };
    }),
    status: vi.fn(async () => secretStatusOf({})),
    setSecret: vi.fn(async () => undefined),
    clearSecret: vi.fn(async () => undefined),
    importFile: io,
    mcpClient,
  };
  return { deps: d, io, seen, sent, commit: d.commit as ReturnType<typeof vi.fn> };
}

function show(d: IntegrationDeps) {
  return render(<IntegrationSettingsPage deps={d} onLeave={async () => {}} />);
}

const pasteArea = () => screen.getByRole('textbox', { name: t('mcpClient.import.paste') }) as HTMLTextAreaElement;

async function openPaste() {
  await userEvent.click(await screen.findByRole('button', { name: t('mcpClient.import.paste') }));
  return pasteArea();
}

describe('Import a Claude-Desktop MCP JSON', () => {
  it('pastes through Rust, saves the servers, shows the summary and focuses the field that needs a token', async () => {
    const f = deps();
    show(f.deps);
    const area = await openPaste();
    // 제어하지 않는 칸: React 가 value 를 들고 있지 않다.
    expect(area.getAttribute('value')).toBeNull();
    expect(area.getAttribute('autocomplete')).toBe('off');
    expect(area.getAttribute('spellcheck')).toBe('false');
    fireEvent.change(area, { target: { value: PASTED } });
    // TextEncoder 가 만드는 배열의 원형(jsdom 과 Node 의 Uint8Array 는 다를 수 있다).
    const fill = vi.spyOn(Object.getPrototypeOf(new TextEncoder().encode('')) as Uint8Array, 'fill');
    await userEvent.click(screen.getByRole('button', { name: t('mcpClient.import.run') }));
    await waitFor(() => expect(f.io.runBytes).toHaveBeenCalledTimes(1));
    // 이름 "pasted.json" 과 내용이 한 번 갔다(보낼 때의 모습).
    expect(f.sent[0]).toBe(`pasted.json:${PASTED}`);
    // 보낸 뒤 칸은 비고 버퍼는 0 으로 지워진다.
    expect(pasteArea().value).toBe('');
    await waitFor(() => expect(Array.from(f.seen[0]!).every((b) => b === 0)).toBe(true));
    expect(fill).toHaveBeenCalledWith(0);
    fill.mockRestore();
    // 돌아온 mcpClientServers 는 늘 쓰는 저장 흐름으로 저장된다.
    await waitFor(() => expect(f.commit).toHaveBeenCalledWith({ mcpClientServers: SERVERS }));
    // 요약: 가져온 서버, 토큰을 넣어 달라는 줄, 건너뛴 stdio.
    expect(await screen.findByText('BioModel Portal: 토큰을 넣어 주세요.')).toBeTruthy();
    expect(screen.getByText(t('mcpClient.import.stdio', 'fs'))).toBeTruthy();
    expect(screen.getByText(t('mcpClient.import.doneToken', 'RAPID'))).toBeTruthy();
    expect(screen.getByText(t('mcpClient.import.done', 'BioModel Portal'))).toBeTruthy();
    // 붙여 넣은 것은 지울 파일이 없다.
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
    expect(screen.queryByText(t('integrations.import.dropDeleteYourself'))).toBeNull();
    // BioModel 토큰 칸에 포커스가 간다.
    const bio = screen.getByRole('group', { name: 'BioModel Portal' });
    await waitFor(() => expect(bio.contains(document.activeElement)).toBe(true));
    expect((document.activeElement as HTMLInputElement).type).toBe('password');
    // 토큰은 화면 어디에도 없다.
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(styleAttributes()).toEqual([]);
    expect(f.io.run).not.toHaveBeenCalled();
  });

  it('refuses a paste over 64 KiB before calling Rust, and clears the field', async () => {
    const f = deps();
    show(f.deps);
    const area = await openPaste();
    fireEvent.change(area, { target: { value: 'x'.repeat(64 * 1024 + 1) } });
    await userEvent.click(screen.getByRole('button', { name: t('mcpClient.import.run') }));
    expect(await screen.findByText(t('integrations.import.refused.tooLarge'))).toBeTruthy();
    expect(f.io.runBytes).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(pasteArea().value).toBe('');
  });

  it('an empty paste sends nothing', async () => {
    const f = deps();
    show(f.deps);
    await openPaste();
    await userEvent.click(screen.getByRole('button', { name: t('mcpClient.import.run') }));
    expect(f.io.runBytes).not.toHaveBeenCalled();
  });

  it('a dropped .json with mcpServers takes the same path', async () => {
    const f = deps();
    show(f.deps);
    await screen.findByRole('button', { name: t('mcpClient.import.paste') });
    const zone = screen.getByText(t('integrations.import.dropHere')).closest('.integration-drop')!;
    const dataTransfer = { files: [new File([PASTED], 'claude_desktop_config.json')], types: ['Files'] };
    fireEvent.drop(zone, { dataTransfer });
    await waitFor(() => expect(f.io.runBytes).toHaveBeenCalledTimes(1));
    expect(f.sent[0]!.startsWith('claude_desktop_config.json:')).toBe(true);
    await waitFor(() => expect(f.commit).toHaveBeenCalledWith({ mcpClientServers: SERVERS }));
    expect(await screen.findByText('BioModel Portal: 토큰을 넣어 주세요.')).toBeTruthy();
    // 끌어 놓은 파일에는 토큰이 평문으로 있으니 직접 지우라고 알린다.
    expect(screen.getByText(t('integrations.import.dropDeleteYourself'))).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('shows the other MCP problem lines with the server name', async () => {
    const outcome: ImportOutcome = {
      status: 'done',
      imported: [],
      invalid: [
        { part: 'mcpServer', field: 'type', reason: 'sseSkipped', name: 'old' },
        { part: 'mcpServer', field: 'headers', reason: 'otherHeaders', name: 'extra' },
        { part: 'mcpServer', field: 'url', reason: 'urlSecret', name: 'hosted' },
        { part: 'mcpServer', field: 'mcpServers', reason: 'tooMany', name: 's16' },
        { part: 'mcpServer', field: 'url', reason: 'badUrl', name: 'bad' },
      ],
      mcp: [],
      settings: {},
    };
    const f = deps(outcome);
    show(f.deps);
    const area = await openPaste();
    fireEvent.change(area, { target: { value: '{"mcpServers":{}}' } });
    await userEvent.click(screen.getByRole('button', { name: t('mcpClient.import.run') }));
    expect(await screen.findByText(t('mcpClient.import.sse', 'old'))).toBeTruthy();
    expect(screen.getByText(t('mcpClient.import.otherHeaders', 'extra'))).toBeTruthy();
    expect(screen.getByText(t('mcpClient.import.urlSecret', 'hosted'))).toBeTruthy();
    expect(screen.getByText(t('mcpClient.import.tooMany', 's16'))).toBeTruthy();
    expect(screen.getByText(t('mcpClient.import.badUrl', 'bad'))).toBeTruthy();
    expect(screen.getByText(t('integrations.import.nothing'))).toBeTruthy();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('drops servers from a patch that fail the settings rules', async () => {
    const bad = { ...SERVERS[0]!, id: 'NOT-HEX' };
    const outcome: ImportOutcome = { ...OUTCOME, settings: { mcpClientServers: [bad, SERVERS[1]!] } } as ImportOutcome;
    const f = deps(outcome);
    show(f.deps);
    const area = await openPaste();
    fireEvent.change(area, { target: { value: PASTED } });
    await userEvent.click(screen.getByRole('button', { name: t('mcpClient.import.run') }));
    await waitFor(() => expect(f.commit).toHaveBeenCalledWith({ mcpClientServers: [SERVERS[1]] }));
  });
});
