// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import { fakeInvoke, secretStatusOf } from '../../../integrations/__tests__/fakeNet';
import type { IntegrationDeps, IntegrationSettingsValue } from '../../../integrations/IntegrationSettingsDialog';
import { clearSecret, secretStatus, setSecret, type Slot } from '../../../integrations/netIpc';
import { styleAttributes } from '../../host/__tests__/harness';
import { coreT, overrideOr } from '../../i18n';
import { fromPluginData } from '../../settings';
import { SlackInbox } from '../../port/slackInbox';
import { commitRangedNumber, folderStateLine } from '../../port/scanSettings';
import { ScanSettingsSection, type ScanSettingsFeature } from '../ScanSettingsSection';
import type { ScanFolderStatus, SlackLink } from '../scanIpc';

beforeEach(() => setLang('en'));
afterEach(() => {
  cleanup();
  setLang('ko');
});

const NO_FOLDER: ScanFolderStatus = { path: null, mode: 'dedicated', exists: false, insideVault: false, since: null, baseline: null };
const ALL_SCOPES = 'im:history,im:read,files:read,chat:write,reactions:write';

function value(): IntegrationSettingsValue {
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
  };
}

function setup(opts: { folder?: Partial<ScanFolderStatus>; link?: Partial<SlackLink>; slackSet?: boolean; scopes?: string; lastError?: string } = {}) {
  let folder: ScanFolderStatus = { ...NO_FOLDER, ...opts.folder };
  const state = new Map<string, string>();
  if (opts.link) {
    state.set(
      'slackLink',
      JSON.stringify({ enabled: true, mode: 'dm', channelId: 'D1', linkCode: '', userId: 'U1', lastTs: '', claimedTs: [], ...opts.link }),
    );
  }
  const keys: Partial<Record<Slot, boolean>> = { slackBot: opts.slackSet ?? false };
  const f = fakeInvoke({
    scan_folder_status: () => folder,
    scan_folder_choose: () => {
      folder = { path: 'D:\\scans', mode: 'dedicated', exists: true, insideVault: false, since: 1, baseline: [] };
      return folder;
    },
    scan_folder_clear: () => {
      folder = { ...NO_FOLDER };
      return null;
    },
    scan_folder_set_mode: (a) => {
      folder = { ...folder, mode: a.mode as ScanFolderStatus['mode'] };
      return null;
    },
    secret_status: () => secretStatusOf(keys),
    secret_set: (a) => {
      if (!String(a.value).startsWith('xoxb-')) throw { kind: 'badInput', message: 'bad token' };
      keys[a.slot as Slot] = true;
      return null;
    },
    secret_clear: (a) => {
      keys[a.slot as Slot] = false;
      return null;
    },
    integration_state_read: (a) => state.get(String(a.name)) ?? null,
    integration_state_write: (a) => {
      state.set(String(a.name), String(a.content));
      return null;
    },
    slack_call: (a) =>
      a.method === 'authTest'
        ? { status: 200, json: { ok: true, user: 'labbot' }, scopes: opts.scopes ?? ALL_SCOPES }
        : { status: 200, json: { ok: true } },
  });
  let current = value();
  const commit = vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
    current = { ...current, ...patch };
  });
  const deps: IntegrationDeps = {
    value: () => current,
    commit,
    status: () => secretStatus(f.invoke),
    setSecret: (slot, v) => setSecret(slot, v, f.invoke),
    clearSecret: (slot) => clearSecret(slot, f.invoke),
  };
  const slack = new SlackInbox({ run: async () => [], summarize: () => '', notify: () => undefined, report: () => undefined, invoke: f.invoke });
  slack.lastError = opts.lastError;
  const start = vi.spyOn(slack, 'start').mockImplementation(() => undefined);
  const restart = vi.fn();
  const feature: ScanSettingsFeature = {
    watcher: { restart },
    slack,
    processFolderNow: vi.fn(async () => undefined),
    openUnmatched: vi.fn(async () => undefined),
    unmatchedCount: vi.fn(async () => 2),
  };
  const onLeave = vi.fn(async () => undefined);
  const view = render(<ScanSettingsSection deps={deps} invoke={f.invoke} feature={feature} onLeave={onLeave} />);
  return { f, deps, commit, feature, restart, start, onLeave, state, view };
}

describe('ScanSettingsSection', () => {
  it('Choose folder calls Rust and shows the path; the webview never sends a path', async () => {
    const s = setup();
    fireEvent.click(await screen.findByRole('button', { name: t('scan.chooseFolder') }));
    expect(await screen.findByText('D:\\scans')).toBeTruthy();
    expect(s.f.calls).toContainEqual(['scan_folder_choose', {}]);
    expect(s.f.calls.every(([, a]) => !('path' in a))).toBe(true);
    expect(s.restart).toHaveBeenCalledTimes(1);
    expect(screen.getByText(coreT('Watching this folder. Only files added from now on are read.'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('scan.clearFolder') }));
    await waitFor(() => expect(screen.queryByText('D:\\scans')).toBeNull());
    expect(s.f.calls.map(([c]) => c)).toContain('scan_folder_clear');
    expect(s.restart).toHaveBeenCalledTimes(2);
  });

  it('a refused vault root says why and keeps the old folder', async () => {
    // The same deps and feature, with the choose routed to Rust's refusal of the vault folder itself.
    const s = setup();
    cleanup();
    const f = fakeInvoke({
      scan_folder_status: () => NO_FOLDER,
      scan_folder_choose: () => {
        throw { kind: 'badInput', message: 'the vault folder itself cannot be the scan folder' };
      },
      secret_status: () => secretStatusOf({}),
      integration_state_read: () => null,
    });
    render(<ScanSettingsSection deps={s.deps} invoke={f.invoke} feature={s.feature} onLeave={s.onLeave} />);
    fireEvent.click(await screen.findByRole('button', { name: t('scan.chooseFolder') }));
    expect(await screen.findByText(t('scan.vaultRootRefused'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('the vault folder itself');
  });

  it('an inside-vault folder disables Dedicated and says why', async () => {
    setup({ folder: { path: 'C:\\vault\\scans', exists: true, insideVault: true, mode: 'shared', since: 1, baseline: [] } });
    expect(await screen.findByText(overrideOr('scan.insideVault'))).toBeTruthy();
    const dedicated = screen.getByRole('option', { name: coreT('Dedicated folder') }) as HTMLOptionElement;
    expect(dedicated.disabled).toBe(true);
    expect((screen.getByRole('option', { name: coreT('Shared folder') }) as HTMLOptionElement).disabled).toBe(false);
  });

  it('a missing folder says so, and the mode select sets the mode through Rust', async () => {
    const s = setup({ folder: { path: 'E:\\gone', exists: false, since: 1, baseline: [] } });
    expect(await screen.findByText(coreT('This folder does not exist on this PC.'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(coreT('Scan folder mode')), { target: { value: 'shared' } });
    await waitFor(() => expect(s.f.calls).toContainEqual(['scan_folder_set_mode', { mode: 'shared' }]));
    await waitFor(() => expect(s.restart).toHaveBeenCalledTimes(1));
  });

  it('Process now and Process existing files too call the feature with false and true', async () => {
    const s = setup({ folder: { path: 'D:\\scans', exists: true, since: 1, baseline: [] } });
    fireEvent.click(await screen.findByRole('button', { name: coreT('Process now') }));
    await waitFor(() => expect(s.feature.processFolderNow).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole('button', { name: coreT('Process existing files too') }));
    await waitFor(() => expect(s.feature.processFolderNow).toHaveBeenLastCalledWith(true));
    expect(s.feature.processFolderNow).toHaveBeenCalledTimes(2);
    // The settings close first, so the progress and result dialogs are not queued behind them.
    expect(s.onLeave).toHaveBeenCalledTimes(2);
  });

  it('shows the unmatched count and opens the queue', async () => {
    const s = setup();
    expect(await screen.findByText(coreT('{0} page(s) wait to be assigned to a note.', '2'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: coreT('Assign unmatched scans') }));
    await waitFor(() => expect(s.feature.openUnmatched).toHaveBeenCalledTimes(1));
    expect(s.onLeave).toHaveBeenCalledTimes(1);
  });

  it('the paper size row commits worksheetPaperSize', async () => {
    const s = setup();
    fireEvent.change(await screen.findByLabelText(coreT('Worksheet paper size')), { target: { value: 'letter' } });
    await waitFor(() => expect(s.commit).toHaveBeenCalledWith({ worksheetPaperSize: 'letter' }));
  });

  it('quality slider steps by 0.05 between 0.5 and 1', async () => {
    const s = setup();
    const slider = (await screen.findByLabelText(coreT('Stored scan quality'))) as HTMLInputElement;
    expect([slider.type, slider.min, slider.max, slider.step]).toEqual(['range', '0.5', '1', '0.05']);
    fireEvent.change(slider, { target: { value: '0.7' } });
    await waitFor(() => expect(s.commit).toHaveBeenCalledWith({ scanJpegQuality: 0.7 }));
  });

  it('a size out of range is refused with the plugin notice and the field goes back', async () => {
    const s = setup();
    const edge = (await screen.findByLabelText(coreT('Stored scan size'))) as HTMLInputElement;
    fireEvent.change(edge, { target: { value: '100' } });
    fireEvent.blur(edge);
    expect(await screen.findByText(coreT('{0} takes {1}; the value was not saved and is back to {2}.', coreT('Stored scan size'), '800–6000', '2400'))).toBeTruthy();
    expect(edge.value).toBe('2400');
    const width = screen.getByLabelText(coreT('Scan width in notes')) as HTMLInputElement;
    fireEvent.change(width, { target: { value: '0' } });
    fireEvent.blur(width);
    await waitFor(() => expect(s.commit).toHaveBeenCalledWith({ scanEmbedWidth: 0 }));
    expect(s.commit).not.toHaveBeenCalledWith(expect.objectContaining({ scanMaxImageEdge: expect.anything() }));
  });

  it('Connect verifies scopes and stores only the link state', async () => {
    const s = setup();
    const key = (await screen.findByLabelText(coreT('Slack bot token'))) as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.placeholder).toBe('xoxb-…');
    fireEvent.change(key, { target: { value: 'xoxb-1-secret' } });
    fireEvent.click(screen.getByRole('button', { name: coreT('Connect') }));
    await waitFor(() => expect(s.start).toHaveBeenCalledTimes(1));
    expect(s.f.calls.some(([c, a]) => c === 'slack_call' && a.method === 'authTest')).toBe(true);
    const writes = s.f.calls.filter(([c]) => c === 'integration_state_write');
    expect(writes).toHaveLength(1);
    const link = JSON.parse(String(writes[0][1].content)) as SlackLink;
    expect(link.enabled).toBe(true);
    expect(link.linkCode).toMatch(/^labnote-\d{6}$/);
    expect(writes.every(([, a]) => !JSON.stringify(a).includes('xox'))).toBe(true);
    expect(await screen.findByText(coreT('Connected to the bot {0}. Send {1} to it in Slack to link this PC.', 'labbot', link.linkCode))).toBeTruthy();
    expect(document.body.textContent).not.toContain('xoxb-1-secret');
  });

  it('Connect with missing scopes links nothing and names them', async () => {
    const s = setup({ slackSet: true, scopes: 'im:read,chat:write' });
    fireEvent.click(await screen.findByRole('button', { name: coreT('Connect') }));
    expect(
      await screen.findByText(
        coreT('The Slack token is missing permissions: {0}. Add them under OAuth & Permissions and reinstall the app.', 'im:history, files:read'),
      ),
    ).toBeTruthy();
    expect(s.f.calls.map(([c]) => c)).not.toContain('integration_state_write');
    expect(s.start).not.toHaveBeenCalled();
  });

  it('Connect without a stored or typed token asks for it', async () => {
    const s = setup();
    fireEvent.click(await screen.findByRole('button', { name: coreT('Connect') }));
    expect(await screen.findByText(coreT('Enter the bot token (it starts with xoxb-).'))).toBeTruthy();
    expect(s.f.calls.map(([c]) => c)).not.toContain('slack_call');
  });

  it('Disconnect writes enabled false and offers to remove the token', async () => {
    const s = setup({ slackSet: true, link: {} });
    expect(await screen.findByText(coreT('Linked. Files you send to the bot ({0}) are filed every 90 seconds.', coreT('direct message')))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: coreT('Disconnect') }));
    expect(await screen.findByText(t('scan.slackTokenKept'))).toBeTruthy();
    expect((JSON.parse(s.state.get('slackLink')!) as SlackLink).enabled).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: t('integrations.removeKey') }));
    await waitFor(() => expect(s.f.calls).toContainEqual(['secret_clear', { slot: 'slackBot' }]));
  });

  it('the Slack key field ignores Enter while composing', async () => {
    const s = setup();
    const key = (await screen.findByLabelText(coreT('Slack bot token'))) as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'xoxb-1-secret' } });
    fireEvent.keyDown(key, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(key, { key: 'Enter', keyCode: 229 });
    await act(async () => undefined);
    expect(s.f.calls.map(([c]) => c)).not.toContain('secret_set');
  });

  it('sets no inline style', async () => {
    setup({ folder: { path: 'C:\\vault\\scans', exists: true, insideVault: true, mode: 'shared', since: 1, baseline: [] } });
    await screen.findByText(overrideOr('scan.insideVault'));
    expect(styleAttributes()).toEqual([]);
  });

  it('no rendered text names Obsidian, Labnote Assistant or docs/SCAN.md, in ko and en', async () => {
    for (const lang of ['ko', 'en'] as const) {
      setLang(lang);
      setup({
        folder: { path: 'C:\\vault\\scans', exists: true, insideVault: true, mode: 'shared', since: 1, baseline: [] },
        link: {},
        slackSet: true,
        lastError: 'missing_scope',
      });
      await screen.findByText(overrideOr('scan.insideVault'));
      const how = document.querySelector('details') as HTMLDetailsElement;
      how.open = true;
      expect(how.textContent).toContain(RECOMMENDED);
      const text = document.body.textContent ?? '';
      expect(text).toContain('missing_scope');
      expect(text).not.toMatch(/Obsidian|Labnote Assistant|docs\/SCAN\.md/);
      cleanup();
    }
  });
});

const RECOMMENDED = 'reactions:write';

describe('scanSettings port', () => {
  const tr = (s: string, ...a: Array<string | number | boolean>) => s.replace(/\{(\d+)\}/g, (_, i: string) => String(a[Number(i)] ?? ''));

  it('commitRangedNumber keeps a value in range or the extra values, and refuses the rest', () => {
    const opts = { label: 'Size', range: { min: 800, max: 6000 }, allowed: '800–6000', current: 2400 };
    expect(commitRangedNumber(tr, { ...opts, value: ' 3000 ' })).toEqual({ value: 3000 });
    expect(commitRangedNumber(tr, { ...opts, value: '0', also: [0] })).toEqual({ value: 0 });
    expect(commitRangedNumber(tr, { ...opts, value: 'abc' })).toEqual({
      value: 2400,
      notice: 'Size takes 800–6000; the value was not saved and is back to 2400.',
    });
  });

  it('folderStateLine follows exists and insideVault', () => {
    expect(folderStateLine(tr, NO_FOLDER)).toBeUndefined();
    expect(folderStateLine(tr, { ...NO_FOLDER, path: 'x', exists: false })).toEqual({ text: 'This folder does not exist on this PC.', warn: true });
    expect(folderStateLine(tr, { ...NO_FOLDER, path: 'x', exists: true, insideVault: true })).toEqual({ text: overrideOr('scan.insideVault'), warn: true });
    expect(folderStateLine(tr, { ...NO_FOLDER, path: 'x', exists: true })?.warn).toBe(false);
  });
});
