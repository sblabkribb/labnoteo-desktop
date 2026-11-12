// @vitest-environment jsdom
/**
 * 샘플 탭의 PartBank 구역(PartbankSection.tsx): 연결 안 됨 → "연결하기", 찾기(쉼 400 ms, 두 글자부터, 한글 조합, 옛 답 버림),
 * 결과 줄(범위 칩, 그룹 이름), 오류 문장(Rust 의 글·주소 없음), 가져오기·열기, 연결이 바뀌면 결과 버림.
 * 가짜 invoke(pbFixture) 위에서만 돈다: 네트워크도 자격 증명 관리자도 건드리지 않는다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { sourceForItem } from '@labnoteo/core';
import { loadSamplesByType } from '@labnoteo/core/lib/sampleStorage';
import { setLang } from '../../i18n/lang';
import { catalogs, t } from '../../i18n/t';
import { notifySecretsChange } from '../../integrations/probes';
import { netError, secretStatusOf } from '../../integrations/__tests__/fakeNet';
import type { SecretStatus } from '../../integrations/netIpc';
import { coreT } from '../../labnote/i18n';
import { PartbankError } from '../../labnote/port/partbankClient';
import { openInPartbank } from '../../labnote/port/partbankActions';
import { handleImportUri } from '../../labnote/port/partbankUri';
import { setPartbankFeature } from '../../partbank/current';
import { PB_WEB, partbankRoutes, pbEnv, type PbEnv } from '../../partbank/__tests__/pbFixture';
import { openSettings } from '../../ui/SettingsModal';
import { PartbankSection, PB_PANEL_LIMIT } from '../PartbankSection';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../../ui/SettingsModal', () => ({ openSettings: vi.fn(async () => undefined) }));
vi.mock('../../labnote/port/partbankUri', async (orig) => {
  const m = await orig<typeof import('../../labnote/port/partbankUri')>();
  return { ...m, handleImportUri: vi.fn(m.handleImportUri) };
});
vi.mock('../../labnote/port/partbankActions', async (orig) => {
  const m = await orig<typeof import('../../labnote/port/partbankActions')>();
  return { ...m, openInPartbank: vi.fn(async () => undefined) };
});

const GLOBAL = 'resources/labsamples';
const NOTE = 'labnote/001_Exp/001_a.labnote.md';
const GROUP = '665f00000000000000000a01';
const OID = (n: number) => `665f1a2b3c4d5e6f7081${String(n).padStart(4, '0')}`;
const HITS = [
  { type: 'vector', id: OID(1), kid: 'KV-00231', name: 'pET28a-sfGFP', owner_is_me: true },
  { type: 'vector', id: OID(3), kid: 'KV-00187', name: 'pET21b-sfGFP', owner_is_me: false, group_id: GROUP },
  { type: 'vector', id: OID(4), kid: 'KV-00045', name: 'pSB1C3-sfGFP', owner_is_me: false, sharing_level: 'public' },
  { type: 'part', id: OID(2), kid: 'KP-01102', name: 'sfGFP CDS', owner_is_me: true },
];

/** 손으로 돌리는 시계: `flush` 가 걸린 타이머를 모두 부른다. */
function manualTimers() {
  let next = 0;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      set: ((fn: () => void) => {
        pending.set(++next, fn);
        return next;
      }) as unknown as typeof setTimeout,
      clear: ((h: number) => {
        pending.delete(h);
      }) as unknown as typeof clearTimeout,
    },
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      act(() => fns.forEach((f) => f()));
    },
    get size() {
      return pending.size;
    },
  };
}

let pb: PbEnv;
let status: SecretStatus;
let clock: ReturnType<typeof manualTimers>;
type ReadArgs = { method: string; path: string; query: unknown; body: unknown };
let onRead: (a: ReadArgs) => unknown;
const writeText = vi.fn(async () => undefined);

function setup(opts: { status?: SecretStatus; settings?: NonNullable<Parameters<typeof pbEnv>[1]>['settings']; answers?: Record<string, unknown> } = {}) {
  status = opts.status ?? secretStatusOf({ partbankWeb: true });
  pb = pbEnv(
    { [NOTE]: '# a\n', 'labnote/001_Exp/README.labnote.md': '---\ntitle: Exp\nsample_tracking: yes\n---\n' },
    {
      settings: { globalSampleFolder: GLOBAL, ...opts.settings },
      status,
      routes: {
        ...partbankRoutes(opts.answers ?? {}),
        secret_status: () => status,
        partbank_read: (a) => onRead(a as ReadArgs),
      },
    },
  );
  setPartbankFeature(pb.feature);
  clock = manualTimers();
  return render(<PartbankSection ctx={pb.th.ctx} env={pb.env} invoke={pb.invoke} timers={clock.timers} />);
}

const reads = () => pb.calls.filter((c) => c[0] === 'partbank_read').map((c) => c[1] as ReadArgs);
const searches = () => reads().filter((r) => r.path === '/search/global');
const box = () => screen.getByRole('searchbox', { name: coreT('Search partbank') });
const statusText = () => document.querySelector('.pb-status')?.textContent;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const settle = () => act(async () => {});

beforeEach(() => {
  setLang('ko');
  onRead = (a) => {
    if (a.path === '/search/global') return { status: 200, json: { results: HITS } };
    if (a.path === '/groups/') return { status: 200, json: { groups: [{ id: GROUP, name: '발현 팀' }] } };
    throw { kind: 'forbiddenPath', message: 'raw-rust-text' };
  };
  writeText.mockClear();
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText, readText: vi.fn(async () => '') } });
  vi.mocked(openSettings).mockReset().mockResolvedValue(undefined);
  vi.mocked(handleImportUri).mockClear();
  vi.mocked(openInPartbank).mockClear();
});
afterEach(() => {
  cleanup();
  pb?.th.cleanup();
  setPartbankFeature(undefined);
  vi.unstubAllGlobals();
  setLang('en');
});

describe('PartbankSection: wording', () => {
  it('names the service "partbank" as the rest of the app and the reused core strings do, with the right Korean particles', () => {
    for (const lang of ['ko', 'en'] as const) {
      const pb = Object.entries(catalogs[lang]).filter(([k]) => k.startsWith('samples.pb.'));
      expect(pb.length).toBeGreaterThan(5);
      for (const [k, v] of pb) expect([k, v.includes('PartBank')]).toEqual([k, false]);
    }
    expect(catalogs.ko['samples.pb.title']).toBe('partbank');
    // 뱅크 ends in a vowel: 가, not 이
    expect(catalogs.ko['samples.pb.notConnected'].startsWith('partbank가 ')).toBe(true);
    expect(catalogs.ko['samples.pb.notConnected']).not.toContain('partbank이');
    // The core strings in the same section already say partbank
    setLang('ko');
    expect(coreT('Search partbank')).toContain('partbank');
  });
});

describe('PartbankSection: connection', () => {
  it('is a disclosure headed PartBank, open by default, whose body is a labelled region', async () => {
    setup();
    await settle();
    const head = screen.getByRole('button', { name: 'partbank' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByRole('region', { name: 'partbank' });
    expect(head.getAttribute('aria-controls')).toBe(region.id);
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(region.hidden).toBe(true);
    expect(document.querySelector('[style]')).toBeNull();
  });

  it('not connected: says so and offers Connect, which opens Settings > Integrations at PartBank', async () => {
    setup({ status: secretStatusOf({}) });
    await settle();
    expect(screen.getByText(t('samples.pb.notConnected'))).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    let close!: () => void;
    vi.mocked(openSettings).mockImplementation(() => new Promise<void>((r) => (close = r)));
    fireEvent.click(screen.getByRole('button', { name: '연결하기' }));
    expect(openSettings).toHaveBeenCalledWith('integrations', { focus: 'partbank' });
    // The key is saved in the settings window; closing it re-reads the key status and moves to the search box
    status = secretStatusOf({ partbankWeb: true });
    await act(async () => close());
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(pb.calls.filter((c) => c[0] === 'secret_status').length).toBeGreaterThanOrEqual(2);
  });

  it('Connect closed without a key keeps the focus on Connect', async () => {
    setup({ status: secretStatusOf({}) });
    await settle();
    const connect = screen.getByRole('button', { name: '연결하기' });
    fireEvent.click(connect);
    await settle();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '연결하기' })));
  });

  it('the other connection set but not the one used for search says which is missing', async () => {
    setup({ status: secretStatusOf({ partbankDesktop: true }) });
    await settle();
    expect(screen.getByText(t('samples.pb.defaultNotSet'))).toBeTruthy();
    expect(screen.getByRole('button', { name: '연결하기' })).toBeTruthy();
  });

  it('a key cleared elsewhere drops the results and shows Connect; a key set shows the search box again', async () => {
    setup();
    await settle();
    type('sfgfp');
    clock.flush();
    await screen.findByText('pET28a-sfGFP');
    status = secretStatusOf({});
    pb.feature.setStatus(status); // partbankApp does this on onSecretsChange
    await act(async () => notifySecretsChange(status));
    await waitFor(() => expect(screen.getByRole('button', { name: '연결하기' })).toBeTruthy());
    expect(screen.queryByText('pET28a-sfGFP')).toBeNull();
    status = secretStatusOf({ partbankWeb: true });
    pb.feature.setStatus(status);
    await act(async () => notifySecretsChange(status));
    await waitFor(() => expect(box()).toBeTruthy());
    expect((box() as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('pET28a-sfGFP')).toBeNull();
  });

  it('a status change aborts the search in flight without an error', async () => {
    setup();
    await settle();
    onRead = () => new Promise(() => undefined);
    type('sfgfp');
    clock.flush();
    status = secretStatusOf({});
    pb.feature.setStatus(status);
    await act(async () => notifySecretsChange(status));
    await settle();
    expect(screen.queryByText(t('samples.pb.error'))).toBeNull();
    expect(screen.getByText(t('samples.pb.notConnected'))).toBeTruthy();
  });

  it('renders nothing without a vault (no feature)', () => {
    setup();
    cleanup();
    setPartbankFeature(undefined);
    const { container } = render(<PartbankSection ctx={pb.th.ctx} env={pb.env} invoke={pb.invoke} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PartbankSection: search', () => {
  it('one character asks nothing; typing within the pause asks once, read-only, for mine, group and public', async () => {
    setup();
    await settle();
    expect(statusText()).toBe(coreT('Type at least {0} characters to search partbank.', '2'));
    type('s');
    expect(clock.size).toBe(0);
    expect(statusText()).toBe(coreT('Type at least {0} characters to search partbank.', '2'));
    type('sf');
    type('sfg');
    type('sfgfp');
    expect(statusText()).toBe(coreT('Searching partbank…'));
    expect(searches()).toHaveLength(0);
    clock.flush();
    await screen.findByText('pET28a-sfGFP');
    expect(searches()).toEqual([{ method: 'POST', path: '/search/global', query: null, body: { query: 'sfgfp', limit: PB_PANEL_LIMIT } }]);
    expect(PB_PANEL_LIMIT).toBe(15);
    expect(statusText()).toBe(t('samples.pb.count', '4'));
  });

  it('a slower earlier answer is ignored and the new query cancels it quietly', async () => {
    setup();
    await settle();
    let first!: (v: unknown) => void;
    onRead = (a) =>
      a.path === '/search/global' && (a.body as { query: string }).query === 'gf'
        ? new Promise((r) => (first = r))
        : { status: 200, json: { results: HITS.slice(3) } };
    type('gf');
    clock.flush();
    type('sfgfp');
    clock.flush();
    await screen.findByText('sfGFP CDS');
    await act(async () => first({ status: 200, json: { results: HITS } }));
    expect(screen.queryByText('pET28a-sfGFP')).toBeNull();
    expect(screen.queryByText(t('samples.pb.error'))).toBeNull();
    expect(screen.queryByText(t('integrations.cancelled'))).toBeNull();
  });

  it('IME: nothing is asked while composing; compositionend asks', async () => {
    setup();
    await settle();
    const input = box();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '플라스' } });
    expect(clock.size).toBe(0);
    fireEvent.compositionEnd(input, { target: { value: '플라스미드' } });
    clock.flush();
    await settle();
    expect(searches().map((s) => (s.body as { query: string }).query)).toEqual(['플라스미드']);
  });

  it('an empty answer says nothing was found', async () => {
    setup();
    await settle();
    onRead = () => ({ status: 200, json: { results: [] } });
    type('zzz');
    clock.flush();
    await waitFor(() => expect(statusText()).toBe(t('samples.pb.none')));
    expect(t('samples.pb.none')).toBe('찾은 항목이 없습니다.');
  });

  it('offline says PartBank cannot be reached, without the address or Rust text', async () => {
    setup();
    await settle();
    onRead = () => {
      throw netError('offline');
    };
    type('sfgfp');
    clock.flush();
    await waitFor(() => expect(statusText()).toBe(t('samples.pb.unreachable')));
    expect(document.body.textContent).not.toContain('partbank.kbiofoundry.kr');
    expect(document.body.textContent).not.toContain('raw-rust-text');
  });

  it('401 says the key was refused (describeError), as an answer or as a status error', async () => {
    setup();
    await settle();
    const refused = pb.feature.describeError(new PartbankError('unauthorized', 401, ''));
    onRead = () => ({ status: 401, json: null });
    type('sfgfp');
    clock.flush();
    await waitFor(() => expect(statusText()).toBe(refused));
    onRead = () => {
      throw netError('status', { status: 401, body: 'raw-body' });
    };
    type('sfgfp2');
    clock.flush();
    await waitFor(() => expect(statusText()).toBe(refused));
    expect(document.body.textContent).not.toContain('raw-');
  });
});

describe('PartbankSection: results', () => {
  it('rows show name, KID · type and a scope chip; group names are read once', async () => {
    setup();
    await settle();
    type('sfgfp');
    clock.flush();
    await screen.findByText('pET28a-sfGFP');
    const list = screen.getByRole('list', { name: t('samples.pb.results') });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    await waitFor(() => expect(items[1].querySelector('.pb-scope')?.textContent).toBe('그룹 발현 팀'));
    expect(items.map((li) => li.querySelector('.pb-scope')?.getAttribute('data-scope'))).toEqual(['mine', 'group', 'public', 'mine']);
    expect(items.map((li) => li.querySelector('.pb-scope')?.textContent)).toEqual(['내 것', '그룹 발현 팀', '공개', '내 것']);
    expect(items[0].querySelector('.pb-item-detail')?.textContent).toBe(`KV-00231 · ${coreT('plasmid')}`);
    type('sfgfp cds');
    clock.flush();
    await settle();
    type('sfgfp');
    clock.flush();
    await settle();
    expect(reads().filter((r) => r.path === '/groups/')).toEqual([{ method: 'GET', path: '/groups/', query: [['limit', '100']], body: null }]);
  });

  it('a failed group list leaves the plain "group" word', async () => {
    setup();
    await settle();
    const base = onRead;
    onRead = (a) => {
      if (a.path === '/groups/') throw netError('offline');
      return base(a);
    };
    type('sfgfp');
    clock.flush();
    await screen.findByText('pET21b-sfGFP');
    await settle();
    expect(screen.getAllByText('그룹')).toHaveLength(1);
  });

  it('each row has Import and Open buttons named for the item, in ko and en', async () => {
    setup();
    await settle();
    type('sfgfp');
    clock.flush();
    await screen.findByText('pET28a-sfGFP');
    expect(screen.getByRole('button', { name: 'pET28a-sfGFP 샘플로 가져오기' }).textContent).toBe('샘플로 가져오기');
    expect(screen.getByRole('button', { name: 'pET28a-sfGFP partbank에서 열기' }).textContent).toBe('partbank에서 열기');
    act(() => setLang('en'));
    expect(t('samples.pb.importNamed', 'X')).toBe('Import X as sample');
    expect(t('samples.pb.openNamed', 'X')).toBe('Open X in partbank');
    expect(t('samples.pb.connect')).toBe('Connect');
  });

  it('Import runs the import flow with the configured origin, type and id', async () => {
    setup();
    await settle();
    vi.mocked(handleImportUri).mockImplementationOnce(async () => undefined);
    type('sfgfp');
    clock.flush();
    fireEvent.click(await screen.findByRole('button', { name: 'pET28a-sfGFP 샘플로 가져오기' }));
    await waitFor(() => expect(handleImportUri).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handleImportUri).mock.calls[0][1]).toBe(pb.feature);
    expect(vi.mocked(handleImportUri).mock.calls[0][2]).toEqual({ server: PB_WEB, type: 'plasmid', id: OID(1) });
  });

  it('Open shows the item in PartBank through its source', async () => {
    setup();
    await settle();
    type('sfgfp');
    clock.flush();
    fireEvent.click(await screen.findByRole('button', { name: 'sfGFP CDS partbank에서 열기' }));
    await waitFor(() => expect(openInPartbank).toHaveBeenCalledTimes(1));
    expect(vi.mocked(openInPartbank).mock.calls[0][1]).toEqual(
      sourceForItem({ type: 'part', id: OID(2), kid: 'KP-01102' }, 'web', PB_WEB),
    );
  });

  it('end to end: Import registers a Global sample with its source and never writes to PartBank', async () => {
    const item = { id: OID(2), kid: 'KP-01102', name: 'sfGFP CDS' };
    setup({ answers: { [`/parts/${OID(2)}`]: item, [`/stock-box/by-resource/part/${OID(2)}`]: { items: [] } } });
    pb.th.setActive(NOTE);
    await settle();
    pb.th.answer.prompt((o) => o.value);
    pb.th.answer.pick(GLOBAL);
    type('sfgfp');
    clock.flush();
    fireEvent.click(await screen.findByRole('button', { name: 'sfGFP CDS 샘플로 가져오기' }));
    await waitFor(async () => expect(Object.keys(await loadSamplesByType(pb.env.fs, GLOBAL, 'DNA'))).toHaveLength(1));
    const records = await loadSamplesByType(pb.env.fs, GLOBAL, 'DNA');
    expect(Object.values(records)[0]).toEqual(
      expect.objectContaining({ alias: 'sfGFP CDS', source: expect.objectContaining({ system: 'partbank', type: 'part', id: OID(2) }) }),
    );
    const requests = pb.calls.filter((c) => c[0] === 'partbank_request').map((c) => c[1] as { method?: string; path: string });
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.method ?? 'GET').toBe('GET');
      expect(r.path.startsWith('/labnoteo/')).toBe(false);
    }
    for (const r of reads()) expect(r.method === 'GET' || r.path === '/search/global').toBe(true);
  });
});
