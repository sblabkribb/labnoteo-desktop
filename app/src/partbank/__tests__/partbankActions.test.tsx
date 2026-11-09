// @vitest-environment jsdom
/**
 * 정의 창과 Samples 패널의 partbank 동작(plan Task 23): 저장 위치 새로 고침과 partbank 에서 열기. 둘 다 연결 정보
 * (`record.source`)가 있는 샘플에만 보이고, 키나 설정은 보지 않는다(D21). 웹 주소는 설정의 서버, 없으면 링크의 origin.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { desktopAppLink, webAppPath, type SampleSource } from '@labnoteo/core';
import { loadSamplesByType, upsertSampleRecord, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import * as dialogs from '../../labnote/host/dialogStore';
import { coreT } from '../../labnote/i18n';
import { openInPartbank, partbankMenuItems, partbankOpenUrl } from '../../labnote/port/partbankActions';
import { definitionModel, SAMPLE_ACTION_LABEL } from '../../labnote/port/sampleDefinitionModel';
import type { ResolvedSampleDefinition } from '../../labnote/port/sampleQuery';
import { fromPluginData, type AppSettings } from '../../labnote/settings';
import { ContextMenu } from '../../labnote/ui/ContextMenu';
import { closeMenu, type MenuAction } from '../../labnote/ui/menuStore';
import { openExternal, type ExternalDeps } from '../../links/openExternal';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { runSampleDefinition } from '../../samples/definitionFlow';
import { samples } from '../../samples/sampleStore';
import { SamplesPanel } from '../../samples/SamplesPanel';
import { LOCAL, NOTE, SAMPLE_VAULT } from '../../samples/__tests__/fixtures';
import { setPartbankFeature } from '../current';
import { PB_WEB, pbEnv, partbankRoutes, type PbEnv } from './pbFixture';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../../labnote/host/dialogStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../labnote/host/dialogStore')>();
  return { ...real, openSampleDefinitionDialog: vi.fn(real.openSampleDefinitionDialog) };
});
const openDialog = vi.mocked(dialogs.openSampleDefinitionDialog);

const OID1 = '507f1f77bcf86cd799439011';
const settings: AppSettings = { ...fromPluginData(undefined), partbankWebUrl: PB_WEB };
const webSrc: SampleSource = { system: 'partbank', connection: 'web', origin: PB_WEB, type: 'part', id: OID1, kid: 'KBp_aa0001' };
const desktopSrc: SampleSource = { system: 'partbank', connection: 'desktop', origin: 'http://127.0.0.1:47830', type: 'plasmid', id: OID1, kid: null };

const record = (source?: SampleSource): SampleRecord => ({
  type: 'DNA',
  alias: 'pUC',
  descriptions: [],
  sources: [],
  location: 'Freezer A / B3',
  ...(source ? { source } : {}),
});

const lang = getLang();
let pb: PbEnv | undefined;
beforeEach(() => setLang('en'));
afterEach(() => {
  act(() => closeMenu());
  cleanup();
  dialogs.closeAllDialogs();
  openDialog.mockReset();
  pb?.th.cleanup();
  pb = undefined;
  samples.resetForTest();
  setPartbankFeature(undefined);
  setLang(lang);
});

describe('definition dialog actions', () => {
  it('definition dialog shows the partbank buttons for a linked record even with no key, before Change type', () => {
    pb = pbEnv({}, { status: secretStatusOf({}) });
    const def = (source?: SampleSource): ResolvedSampleDefinition & { type: string; id: string } => ({
      scope: 'local',
      folder: LOCAL,
      record: record(source),
      type: 'DNA',
      id: 'DNA-1',
    });
    const linked = definitionModel(pb.env, def(webSrc), { docPath: NOTE });
    expect(linked.actions).toEqual(['edit', 'delete', 'discard', 'moveGlobal', 'partbankRefresh', 'partbankOpen', 'changeType', 'openJson']);
    expect(SAMPLE_ACTION_LABEL.partbankRefresh).toBe('Refresh storage location from partbank');
    expect(SAMPLE_ACTION_LABEL.partbankOpen).toBe('Open in partbank');
    const plain = definitionModel(pb.env, def(), { docPath: NOTE });
    expect(plain.actions).not.toContain('partbankRefresh');
    expect(plain.actions).not.toContain('partbankOpen');
  });

  it('Refresh in the dialog runs refreshOneLocation and reopens the dialog', async () => {
    pb = pbEnv(SAMPLE_VAULT, {
      routes: partbankRoutes({ [`/stock-box/by-resource/part/${OID1}`]: { items: [{ stock_box: { name: 'Box-3' }, hole_position: 'A1' }] } }),
    });
    setPartbankFeature(pb.feature);
    await upsertSampleRecord(pb.env.fs, LOCAL, 'DNA', 'DNA-1', { alias: 'pUC', description: null, location: 'Freezer A / B3', source: webSrc });
    const rec = (await loadSamplesByType(pb.env.fs, LOCAL, 'DNA'))['DNA-1'];
    pb.th.answer.confirm(true);
    openDialog.mockResolvedValueOnce({ action: 'partbankRefresh' }).mockResolvedValueOnce(undefined);
    await runSampleDefinition(pb.env, { scope: 'local', folder: LOCAL, record: rec, type: 'DNA', id: 'DNA-1' }, { docPath: NOTE });
    expect(pb.calls.filter(([c]) => c === 'partbank_request').map(([, a]) => a.path)).toEqual([`/stock-box/by-resource/part/${OID1}`]);
    expect((await loadSamplesByType(pb.env.fs, LOCAL, 'DNA'))['DNA-1'].location).toBe('Box-3 / A1');
    expect(openDialog).toHaveBeenCalledTimes(2);
    // The reopened dialog shows the location just stored.
    expect(openDialog.mock.calls[1][0].rows.find((r) => r.label === coreT('Location'))?.value).toBe('Box-3 / A1');
  });

  it('Refresh with no partbank feature says where to set it up and reopens the dialog', async () => {
    pb = pbEnv(SAMPLE_VAULT);
    await upsertSampleRecord(pb.env.fs, LOCAL, 'DNA', 'DNA-1', { alias: 'pUC', description: null, location: 'Freezer A / B3', source: webSrc });
    const rec = (await loadSamplesByType(pb.env.fs, LOCAL, 'DNA'))['DNA-1'];
    openDialog.mockResolvedValueOnce({ action: 'partbankRefresh' }).mockResolvedValueOnce(undefined);
    await runSampleDefinition(pb.env, { scope: 'local', folder: LOCAL, record: rec, type: 'DNA', id: 'DNA-1' }, { docPath: NOTE });
    expect(pb.calls.filter(([c]) => c === 'partbank_request')).toEqual([]);
    expect(pb.th.notes.map((n) => n.message)).toEqual([t('partbank.setupFirst')]);
    expect(openDialog).toHaveBeenCalledTimes(2);
  });

  it('Open in the dialog opens the link and does not reopen', async () => {
    pb = pbEnv(SAMPLE_VAULT);
    setPartbankFeature(pb.feature);
    const opened: string[] = [];
    const open = vi.fn(async (url: string) => {
      opened.push(url);
      return 'opened' as const;
    });
    openDialog.mockResolvedValueOnce({ action: 'partbankOpen' });
    await runSampleDefinition(pb.env, { scope: 'local', folder: LOCAL, record: record(webSrc), type: 'DNA', id: 'DNA-1' }, { docPath: NOTE }, { open });
    expect(opened).toEqual([`${PB_WEB}${webAppPath(webSrc)}`]);
    expect(openDialog).toHaveBeenCalledTimes(1);
  });
});

describe('partbankOpenUrl', () => {
  it('web link uses the configured server after a server move', () => {
    expect(partbankOpenUrl({ ...settings, partbankWebUrl: 'https://new.example' }, { ...webSrc, origin: 'https://old.example' })).toBe(
      `https://new.example${webAppPath(webSrc)}`,
    );
    expect(partbankOpenUrl({ ...settings, partbankWebUrl: '' }, webSrc)).toBe(`${webSrc.origin}${webAppPath(webSrc)}`);
    expect(partbankOpenUrl({ ...settings, partbankWebUrl: 'https://new.example/' }, webSrc)).toBe(`https://new.example${webAppPath(webSrc)}`);
  });

  it('web link opens partbankWebUrl + webAppPath (plasmids under /devices)', () => {
    expect(
      partbankOpenUrl(settings, { system: 'partbank', connection: 'web', origin: 'https://partbank.kbiofoundry.kr', type: 'plasmid', id: OID1, kid: null }),
    ).toBe(`https://partbank.kbiofoundry.kr${webAppPath({ type: 'plasmid', id: OID1 })}`);
    expect(webAppPath({ type: 'plasmid', id: OID1 })).toContain('/devices');
  });

  it('desktop link opens partbank://open?type&id', () => {
    expect(partbankOpenUrl(settings, desktopSrc)).toBe(desktopAppLink({ type: 'plasmid', id: OID1 }));
    expect(desktopAppLink({ type: 'plasmid', id: OID1 })).toMatch(/^partbank:\/\/open\?/);
  });
});

describe('openInPartbank', () => {
  const failing = (copied: string[]) => (url: string, deps: ExternalDeps) =>
    openExternal(url, {
      ...deps,
      open: () => Promise.reject(new Error('no handler')),
      copy: async (text) => void copied.push(text),
    });

  it('an open failure copies the URL and shows the plugin sentence', async () => {
    pb = pbEnv();
    const copied: string[] = [];
    await openInPartbank(pb.env, desktopSrc, failing(copied));
    const url = desktopAppLink(desktopSrc);
    expect(copied).toEqual([url]);
    expect(pb.th.notes).toEqual([
      {
        kind: 'warn',
        message: `${coreT('Could not open the partbank app. If it is installed, start it once so that it registers its links.')}\n${t('links.external.failed', url)}`,
      },
    ]);
  });

  it('a web open failure says the browser could not open it', async () => {
    pb = pbEnv();
    const copied: string[] = [];
    await openInPartbank(pb.env, webSrc, failing(copied));
    expect(copied).toEqual([`${PB_WEB}${webAppPath(webSrc)}`]);
    expect(pb.th.notes[0].message.startsWith(coreT('Could not open partbank in the browser.'))).toBe(true);
  });

  it('a successful open shows nothing', async () => {
    pb = pbEnv();
    const urls: string[] = [];
    await openInPartbank(pb.env, webSrc, (url, deps) => openExternal(url, { ...deps, open: async (u) => void urls.push(u) }));
    expect(urls).toEqual([`${PB_WEB}${webAppPath(webSrc)}`]);
    expect(pb.th.notes).toEqual([]);
  });
});

describe('Samples panel', () => {
  it('partbankMenuItems lists both items for a linked sample and nothing for an unlinked one', () => {
    pb = pbEnv();
    const items = partbankMenuItems(pb.env, pb.feature, { type: 'DNA', id: 'DNA-1', folder: LOCAL, record: record(webSrc) });
    expect(items.map((i) => i.label)).toEqual([coreT('Refresh storage location from partbank'), coreT('Open in partbank')]);
    expect((items[0] as MenuAction).run).toBeTypeOf('function');
    expect(partbankMenuItems(pb.env, pb.feature, { type: 'DNA', id: 'DNA-1', folder: LOCAL, record: record() })).toEqual([]);
  });

  it('Samples panel menu lists both items for a linked sample', async () => {
    pb = pbEnv(SAMPLE_VAULT, { status: secretStatusOf({}) });
    setPartbankFeature(pb.feature);
    await upsertSampleRecord(pb.env.fs, LOCAL, 'DNA', 'DNA-1', { alias: 'pUC', description: null, location: 'Freezer A / B3', source: webSrc });
    render(
      <>
        <SamplesPanel ctx={pb.th.ctx} activePath={NOTE} />
        <ContextMenu />
      </>,
    );
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: /DNA-1/ }));
    const menu = await screen.findByRole('menu');
    // Vendor order: the partbank items follow "View usages" (views/sampleView.ts:345).
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      coreT('Show sample definition'),
      coreT('Copy sample ID'),
      coreT('Insert reference'),
      coreT('View usages'),
      coreT('Refresh storage location from partbank'),
      coreT('Open in partbank'),
      coreT('Edit sample'),
      coreT('Move to Global'),
      coreT('Change type'),
      coreT('Mark as discarded'),
      coreT('Delete sample'),
    ]);
  });

  it('an unlinked sample gets no partbank items in the panel', async () => {
    pb = pbEnv(SAMPLE_VAULT);
    setPartbankFeature(pb.feature);
    render(
      <>
        <SamplesPanel ctx={pb.th.ctx} activePath={NOTE} />
        <ContextMenu />
      </>,
    );
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: /DNA-1/ }));
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getAllByRole('menuitem').length).toBe(9));
    expect(within(menu).queryByRole('menuitem', { name: coreT('Open in partbank') })).toBeNull();
  });
});
