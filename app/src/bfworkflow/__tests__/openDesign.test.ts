// @vitest-environment jsdom
import { setLang } from '../../i18n/lang';
import { catalogs, t } from '../../i18n/t';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../../editor/commands/appCommands';
import { fakeInvoke, netError } from '../../integrations/__tests__/fakeNet';
import type { NetError } from '../../integrations/netIpc';
import type { ExternalDeps } from '../../links/openExternal';
import { designUrl, runDesignUsage, runOpenDesign, serviceUrl, workflowIdOfNote } from '../openDesign';

const DIR = 'labnote/001_단백질_발현';
const NOTE = `${DIR}/002_WB030_PCR.labnote.md`;
const README_PATH = `${DIR}/README.labnote.md`;
const BASE = 'https://workflow.example';

const NOTE_TEXT = [
  '---',
  'title: PCR',
  '---',
  '',
  '### [UHW010 Liquid Handling]',
  '',
  'text',
  '',
  '### [USW020 Analysis]',
  '',
  '### [UHW010 Liquid Handling] again',
  '',
].join('\n');

const SERVICES = [
  { id: 's1', code: 'SVC-01', name: 'Lab A', current_version_number: 2, has_draft: false, workflow_count: 3 },
  { id: 's3', code: 'SVC-03', name: 'Other', current_version_number: 1, has_draft: false, workflow_count: 1 },
];

const USAGE = [
  {
    catalog_id: 'WB030',
    used_by: [
      { service_id: 's1', service_name: 'Lab A', archived: false },
      { service_id: 's2', service_name: 'Old', archived: true },
    ],
  },
  { catalog_id: 'WT010', used_by: [{ service_id: 's3', service_name: 'Other', archived: false }] },
];

const UO_USAGE = [
  {
    uo_id: 'UHW010',
    workflows: [],
    services: [{ id: 's1', name: 'Lab A', code: 'SVC-01', workflows: [{ count: 2 }, { count: 1 }] }],
    workflow_count: 0,
    service_count: 1,
  },
  { uo_id: 'UHW999', workflows: [], services: [{ id: 's1', name: 'Lab A', code: 'SVC-01', workflows: [{ count: 9 }] }] },
];

interface Setup {
  th: TestHost;
  net: ReturnType<typeof fakeInvoke>;
  opened: string[];
  open: (url: string, deps: ExternalDeps) => Promise<'opened' | 'copied'>;
}

function setup(
  opts: {
    active?: string | null;
    files?: Record<string, string>;
    base?: string;
    usage?: unknown;
    fail?: NetError;
    settings?: Parameters<typeof createTestHost>[1];
  } = {},
): Setup {
  const th = createTestHost(opts.files ?? { [README_PATH]: '# r', [NOTE]: NOTE_TEXT }, opts.settings ?? {});
  if (opts.active !== null) th.setActive(opts.active ?? NOTE);
  const net = fakeInvoke({
    bfw_base: () => opts.base ?? BASE,
    bfw_request: (a) => {
      if (opts.fail) throw opts.fail;
      if (a.path === '/api/services') return SERVICES;
      if (a.path === '/api/design-usage/catalog-workflows') return opts.usage ?? USAGE;
      if (a.path === '/api/design-usage/catalog-unit-operations') return UO_USAGE;
      throw netError('forbiddenPath');
    },
  });
  const opened: string[] = [];
  const open = async (url: string) => {
    opened.push(url);
    return 'opened' as const;
  };
  return { th, net, opened, open };
}

const requests = (s: Setup) => s.net.calls.filter(([c]) => c === 'bfw_request').map(([, a]) => a);

beforeEach(() => setLang('en'));
afterEach(() => {
  closeAllDialogs();
  clearAppCommandsForTest();
});

describe('bfworkflow: open a design and design usage', () => {
  it('designUrl encodes the id and trims the base slash', () => {
    expect(designUrl('https://w.example/', 'a b')).toBe('https://w.example/designer?service=a%20b');
    expect(designUrl('https://w.example', 's1')).toBe('https://w.example/designer?service=s1');
    expect(serviceUrl('https://w.example/', 'a/b')).toBe('https://w.example/services/a%2Fb');
  });

  it('workflowIdOfNote reads the id from a workflow file name only', () => {
    expect(workflowIdOfNote(NOTE)).toBe('WB030');
    expect(workflowIdOfNote(README_PATH)).toBeUndefined();
    expect(workflowIdOfNote(undefined)).toBeUndefined();
  });

  it('open: a workflow note offers the designs that use it', async () => {
    const s = setup();
    s.th.answer.pick((items) => items[1].value);
    await runOpenDesign(s.th.ctx, s.net.invoke, s.open);
    expect(requests(s).map((a) => a.path)).toEqual(['/api/design-usage/catalog-workflows']);
    const items = s.th.asked.pick[0].items;
    expect(items.map((i) => i.label)).toEqual(['Lab A', `Old (${t('bfw.archived')})`]);
    expect(s.opened).toEqual([`${BASE}/designer?service=s2`]);
  });

  it('open: no workflow note picks among all designs', async () => {
    const s = setup({ active: README_PATH });
    s.th.answer.pick((items) => items[0].value);
    await runOpenDesign(s.th.ctx, s.net.invoke, s.open);
    expect(requests(s).map((a) => a.path)).toEqual(['/api/services']);
    expect(s.th.asked.pick[0].items.map((i) => i.label)).toEqual(['Lab A', 'Other']);
    expect(s.th.asked.pick[0].items[0].detail).toBe('SVC-01');
    expect(s.opened).toEqual([`${BASE}/designer?service=s1`]);
  });

  it('open: dismissing the picker opens nothing', async () => {
    const s = setup({ active: null });
    await runOpenDesign(s.th.ctx, s.net.invoke, s.open);
    expect(s.opened).toEqual([]);
    expect(s.th.notes).toEqual([]);
  });

  it('open: an unused workflow says so', async () => {
    const s = setup({ usage: [{ catalog_id: 'WT010', used_by: [{ service_id: 's3', service_name: 'Other' }] }] });
    await runOpenDesign(s.th.ctx, s.net.invoke, s.open);
    expect(s.th.asked.pick).toHaveLength(0);
    expect(s.opened).toEqual([]);
    expect(s.th.notes).toEqual([{ kind: 'info', message: t('bfw.unusedWorkflow', 'WB030') }]);
  });

  it('usage lists used_by with archived marked and UO counts from the note', async () => {
    const s = setup();
    s.th.answer.pick((items) => items[0].value);
    await runDesignUsage(s.th.ctx, s.net.invoke, s.open);
    const services = requests(s).find((a) => a.path === '/api/services');
    expect(services?.query).toEqual([['include_archived', 'true']]);
    const items = s.th.asked.pick[0].items;
    expect(items.map((i) => i.label)).toEqual(['Lab A', `Old (${t('bfw.archived')})`]);
    expect(items[0].detail).toBe(
      ['SVC-01', t('bfw.uoUsage', 'UHW010', 3), t('bfw.uoUsage', 'USW020', 0)].join(' · '),
    );
    expect(items[1].detail).toBe([t('bfw.uoUsage', 'UHW010', 0), t('bfw.uoUsage', 'USW020', 0)].join(' · '));
    expect(s.opened).toEqual([`${BASE}/services/s1`]);
  });

  it('usage on a note with no unit operations shows the code only', async () => {
    const s = setup({ files: { [NOTE]: 'no unit operations here' } });
    s.th.answer.pick((items) => items[0].value);
    await runDesignUsage(s.th.ctx, s.net.invoke, s.open);
    expect(s.th.asked.pick[0].items[0].detail).toBe('SVC-01');
  });

  it('usage on a note that is not a workflow note says so and calls nothing', async () => {
    const s = setup({ active: README_PATH });
    await runDesignUsage(s.th.ctx, s.net.invoke, s.open);
    expect(s.net.calls).toEqual([]);
    expect(s.th.notes).toEqual([{ kind: 'info', message: t('bfw.notWorkflowNote') }]);
  });

  it('usage of an unused workflow says so', async () => {
    const s = setup({ usage: [] });
    await runDesignUsage(s.th.ctx, s.net.invoke, s.open);
    expect(s.opened).toEqual([]);
    expect(s.th.notes).toEqual([{ kind: 'info', message: t('bfw.unusedWorkflow', 'WB030') }]);
  });

  it('works with the desktop connection base from bfw_base', async () => {
    const s = setup({ active: README_PATH, base: 'http://127.0.0.1:47831/', settings: { bfwConnection: 'desktop' } });
    s.th.answer.pick((items) => items[0].value);
    await runOpenDesign(s.th.ctx, s.net.invoke, s.open);
    expect(s.net.calls.map(([c]) => c)).toContain('bfw_base');
    expect(s.opened).toEqual(['http://127.0.0.1:47831/designer?service=s1']);
  });

  it('a failure shows the bfworkflow sentence, never the raw text', async () => {
    const s = setup({ fail: netError('status', { status: 403 }) });
    await runDesignUsage(s.th.ctx, s.net.invoke, s.open);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.noScope', 'read') }]);
    expect(JSON.stringify(s.th.notes)).not.toContain('raw-rust-text');
  });

  it('both commands are registered and need a bfworkflow key', () => {
    registerAllAppCommands();
    for (const [id, key] of [
      ['app.bfw-open-design', 'cmd.bfwOpenDesign'],
      ['app.bfw-design-usage', 'cmd.bfwDesignUsage'],
    ] as const) {
      const cmd = appCommands().find((c) => c.id === id)!;
      expect(cmd.nameKey).toBe(key);
      expect(catalogs.ko[key]).toBeTruthy();
      expect(catalogs.en[key]).toBeTruthy();
      expect(cmd.available!(createTestHost().ctx)).toBe(false);
    }
  });

  it('the texts exist in ko and en', () => {
    for (const k of ['bfw.archived', 'bfw.unusedWorkflow', 'bfw.uoUsage', 'bfw.notWorkflowNote']) {
      expect(catalogs.ko[k], k).toBeTruthy();
      expect(catalogs.en[k], k).toBeTruthy();
    }
    expect(catalogs.ko['bfw.archived']).toBe('보관됨');
    expect(catalogs.en['bfw.uoUsage']).toBe('{0}: {1} designs');
  });
});
