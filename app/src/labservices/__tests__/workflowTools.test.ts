/**
 * 읽기 전용 Workflow 서버 도구(lab-service tools design §2.4–2.7, §8 TS tests 8): `/api/services` 거르기(검색어, 접근,
 * 보관, `hidden_for_me`)와 캐시, `current-design` 요약(designToFlow 파서), 저장된 노트 제목과 마크다운 한도, 프로토콜 노트,
 * 논문 지식 베이스. 가짜 `LabIpc` 위에서 돈다.
 */
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { NetError } from '../../integrations/netIpc';
import type { Source } from '../../assistant/sources';
import { notifySecretsChange } from '../../integrations/secretsEvents';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { newRunState } from '../common';
import { clearDesignListCache, DESIGN_LIST_TTL_MS, PAPER_NOTICE, workflowTools } from '../workflowTools';
import { call, dataOf, fakeLab, unfence } from './fakeLab';

const ORIGIN = 'https://workflow.kbiofoundry.kr';

const SERVICES = [
  { id: 'svc1', name: 'GFP expression', code: 'S-GFP', description: 'Express sfGFP in E. coli', access_level: 'owner', owner_name: 'pys', current_version_number: 3, has_draft: true, workflow_count: 2, uo_count: 5, updated_at: '2026-11-01T00:00:00Z' },
  { id: 'svc2', name: 'Shared cloning', code: 'S-CL', description: 'Golden gate', access_level: 'read', owner_name: 'kim', updated_at: '2026-11-05T00:00:00Z' },
  { id: 'svc3', name: 'Hidden one', code: 'S-H', access_level: 'owner', hidden_for_me: true, updated_at: '2026-11-06T00:00:00Z' },
  { id: 'svc4', name: 'Old GFP', code: 'S-OLD', access_level: 'edit', archived: true, updated_at: '2026-01-01T00:00:00Z' },
];

const DESIGN = {
  nodes: [
    {
      id: 'n1',
      catalog_id: 'WD001',
      catalog_name: 'DNA assembly',
      domain: 'Design',
      data: {
        snapshot: {
          nodes: [
            { id: 'a', type: 'uo_hardware', uo_id: 'UHW100', uo_name: 'PCR', label: 'PCR 1', data: { input: ['template', 'primers'], output: 'amplicon', equipment: ['thermocycler'], method_hint: 'x'.repeat(500) } },
            { id: 'b', type: 'uo_software', uo_id: 'USW020', uo_name: 'Primer design', data: {} },
          ],
          edges: [{ id: 'e1', source: 'b', target: 'a' }],
        },
      },
    },
    {
      id: 'n2',
      catalog_id: 'WB010',
      catalog_name: 'Transformation',
      data: { snapshot: { nodes: [{ id: 'c', type: 'uo_hardware', uo_id: 'UHW200', uo_name: 'Heat shock', data: {} }], edges: [] } },
    },
    {
      id: 'pipeline-notes',
      data: {
        kind: 'note',
        snapshot: {
          workflow_notes: [
            { group_node_id: 'wf-group-n1', workflow_id: 'WD001', workflow_name: 'DNA assembly', markdown: '# Assembly\n' + 'm'.repeat(3000) },
            { group_node_id: 'wf-group-n2', workflow_id: 'WB010', workflow_name: 'Transformation', markdown: '# Transform\nshort' },
          ],
        },
      },
    },
  ],
  edges: [{ id: 'auto-1', source: 'n1', target: 'n2' }],
};

function build(routes: Record<string, unknown>, o: { origin?: string | null; cacheKey?: string; now?: () => number; desktop?: boolean; notify?: (m: string) => void } = {}) {
  const lab = fakeLab(routes);
  const sources: Source[] = [];
  const state = newRunState('workflow', { desktop: !!o.desktop, ...(o.notify ? { notify: o.notify } : {}) });
  const tools = workflowTools({
    ipc: lab.ipc,
    origin: o.origin === undefined ? ORIGIN : o.origin,
    state,
    cite: (s) => sources.push(s),
    ...(o.cacheKey ? { cacheKey: o.cacheKey } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  return { ...lab, tools, sources, state };
}

beforeEach(() => {
  setLang('en');
  clearDesignListCache();
});

describe('workflow_list_designs', () => {
  it('drops hidden and archived designs, sorts by update time and links each design', async () => {
    const { tools, sent } = build({ '/api/services': SERVICES });
    const d = dataOf(await call(tools, 'workflow_list_designs', {}));
    expect(sent).toEqual([{ method: 'GET', service: 'workflow', path: '/api/services', query: [['include_archived', 'false']] }]);
    const rows = d.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.serviceId)).toEqual(['svc2', 'svc1']);
    expect(rows[1]).toMatchObject({ code: 'S-GFP', access: 'owner', owner: 'pys', version: 3, hasDraft: true, workflowCount: 2, uoCount: 5, link: `${ORIGIN}/services/svc1` });
  });

  it('filters by query words, access and archived', async () => {
    const { tools, sent } = build({ '/api/services': SERVICES });
    const q = dataOf(await call(tools, 'workflow_list_designs', { query: 'gfp' }));
    expect((q.rows as Array<Record<string, unknown>>).map((r) => r.serviceId)).toEqual(['svc1']);
    const shared = dataOf(await call(tools, 'workflow_list_designs', { access: 'shared' }));
    expect((shared.rows as Array<Record<string, unknown>>).map((r) => r.serviceId)).toEqual(['svc2']);
    const owner = dataOf(await call(tools, 'workflow_list_designs', { access: 'owner' }));
    expect((owner.rows as Array<Record<string, unknown>>).map((r) => r.serviceId)).toEqual(['svc1']);
    // The list is read once per run for the same archived flag.
    expect(sent).toHaveLength(1);
    const archived = dataOf(await call(tools, 'workflow_list_designs', { query: 'GFP', includeArchived: true }));
    expect((archived.rows as Array<Record<string, unknown>>).map((r) => [r.serviceId, r.archived])).toEqual([
      ['svc1', false],
      ['svc4', true],
    ]);
    expect(sent.map((s) => s.query)).toEqual([[['include_archived', 'false']], [['include_archived', 'true']]]);
  });

  it('keeps the list 5 minutes per vault and connection across runs; a key change clears it', async () => {
    let now = 1000;
    const a = build({ '/api/services': SERVICES }, { cacheKey: 'C:/Vault|server', now: () => now });
    await call(a.tools, 'workflow_list_designs', {});
    const b = build({ '/api/services': SERVICES }, { cacheKey: 'C:/Vault|server', now: () => now });
    await call(b.tools, 'workflow_list_designs', {});
    expect(b.sent).toEqual([]);
    const other = build({ '/api/services': SERVICES }, { cacheKey: 'D:/Other|server', now: () => now });
    await call(other.tools, 'workflow_list_designs', {});
    expect(other.sent).toHaveLength(1);
    now += DESIGN_LIST_TTL_MS + 1;
    const c = build({ '/api/services': SERVICES }, { cacheKey: 'C:/Vault|server', now: () => now });
    await call(c.tools, 'workflow_list_designs', {});
    expect(c.sent).toHaveLength(1);
    notifySecretsChange(secretStatusOf({ bfwServer: true }));
    const d = build({ '/api/services': SERVICES }, { cacheKey: 'C:/Vault|server', now: () => now });
    await call(d.tools, 'workflow_list_designs', {});
    expect(d.sent).toHaveLength(1);
  });
});

describe('workflow_get_design', () => {
  const routes = {
    '/api/services/svc1': { service: { name: 'GFP expression', code: 'S-GFP', access_level: 'owner' }, versions: [1, 2, 3, 4].map((n) => ({ version_number: n, status: 'published' })) },
    '/api/services/svc1/current-design': DESIGN,
    '/api/services/svc1/workflows': [
      { id: 'sw1', name: 'DNA assembly', catalog_id: 'WD001' },
      { id: 'sw2', name: 'Transformation', catalog_id: 'WB010' },
    ],
  };

  it('summarises Workflows, Unit Operations, edges and note titles with the designToFlow parser', async () => {
    const { tools, sent, sources } = build(routes);
    const d = dataOf(await call(tools, 'workflow_get_design', { serviceId: 'svc1' }));
    expect(sent.map((s) => s.path)).toEqual(['/api/services/svc1', '/api/services/svc1/current-design', '/api/services/svc1/workflows']);
    expect(d.versions).toEqual([
      { version: 2, status: 'published' },
      { version: 3, status: 'published' },
      { version: 4, status: 'published' },
    ]);
    const wfs = d.workflows as Array<Record<string, unknown>>;
    expect(wfs.map((w) => [w.catalogId, w.name, w.serviceWorkflowId, w.link])).toEqual([
      ['WD001', 'DNA assembly', 'sw1', `${ORIGIN}/services/svc1/workflows/sw1`],
      ['WB010', 'Transformation', 'sw2', `${ORIGIN}/services/svc1/workflows/sw2`],
    ]);
    const uos = wfs[0].unitOperations as Array<Record<string, unknown>>;
    expect(uos[0]).toMatchObject({ uoId: 'UHW100', name: 'PCR', label: 'PCR 1', kind: 'hardware', input: 'template; primers', output: 'amplicon', equipment: 'thermocycler' });
    expect((uos[0].methodHint as string).length).toBeLessThanOrEqual(200);
    expect(uos[1]).toMatchObject({ uoId: 'USW020', kind: 'software' });
    // Inside the first Workflow, then last UO of WD001 -> first UO of WB010 (the auto edge).
    expect(d.edges).toEqual(['USW020 -> UHW100', 'UHW100 -> UHW200']);
    expect(d.notes).toEqual([
      { workflowId: 'WD001', workflowName: 'DNA assembly', chars: 3011 },
      { workflowId: 'WB010', workflowName: 'Transformation', chars: 17 },
    ]);
    expect(sources).toEqual([{ kind: 'web', label: 'Workflow server: GFP expression', target: `${ORIGIN}/services/svc1` }]);
  });

  it('includeNotes adds each note\'s markdown, at most 2000 characters each', async () => {
    const { tools } = build(routes);
    const d = dataOf(await call(tools, 'workflow_get_design', { serviceId: 'svc1', includeNotes: true }));
    const notes = d.notes as Array<Record<string, unknown>>;
    expect((notes[0].markdown as string).length).toBe(2000);
    expect(notes[0].clipped).toBe(true);
    expect(notes[1].markdown).toBe('# Transform\nshort');
    expect(notes[1].clipped).toBeUndefined();
  });

  it('refuses a bad service id without IPC', async () => {
    const { tools, sent } = build(routes);
    const res = await call(tools, 'workflow_get_design', { serviceId: '../admin' });
    expect(res.params).toEqual(['workflow', 'badArgs']);
    expect(sent).toEqual([]);
  });
});

describe('workflow_get_protocol_notes', () => {
  const routes = {
    '/api/service-workflows/sw1': { workflow: { id: 'sw1', name: 'DNA assembly', service_id: 'svc1' } },
    '/api/service-workflows/sw1/notes': [
      { id: 'note1', name: 'Assembly protocol', updated_at: '2026-11-02' },
      { id: 'note2', name: 'QC', updated_at: '2026-11-03' },
    ],
    '/api/notes/note1': { note: { name: 'Assembly protocol', version: 2, markdown: 'n'.repeat(9000) }, versions: [] },
  };

  it('lists the notes of a Workflow with links built from its design id', async () => {
    const { tools } = build(routes);
    const d = dataOf(await call(tools, 'workflow_get_protocol_notes', { serviceWorkflowId: 'sw1' }));
    expect(d.notes).toEqual([
      { noteId: 'note1', name: 'Assembly protocol', updatedAt: '2026-11-02', link: `${ORIGIN}/services/svc1/workflows/sw1/notes/note1` },
      { noteId: 'note2', name: 'QC', updatedAt: '2026-11-03', link: `${ORIGIN}/services/svc1/workflows/sw1/notes/note2` },
    ]);
  });

  it('reads one note, its markdown capped at 8000 characters', async () => {
    const { tools, sources } = build(routes);
    const d = dataOf(await call(tools, 'workflow_get_protocol_notes', { serviceWorkflowId: 'sw1', noteId: 'note1' }));
    expect(d).toMatchObject({ noteId: 'note1', name: 'Assembly protocol', version: 2, clipped: true });
    expect((d.markdown as string).length).toBe(8000);
    expect(sources[0].target).toBe(`${ORIGIN}/services/svc1/workflows/sw1/notes/note1`);
  });

  it('without a design id the rows have no link', async () => {
    const { tools } = build({ ...routes, '/api/service-workflows/sw1': { workflow: { id: 'sw1' } } });
    const d = dataOf(await call(tools, 'workflow_get_protocol_notes', { serviceWorkflowId: 'sw1' }));
    expect((d.notes as Array<Record<string, unknown>>)[0].link).toBeNull();
  });
});

describe('workflow_get_method', () => {
  // Real server shapes (verify.md, 2026-11-11): the detail has no UO list; /resources has it; /papers is an array of runs.
  const DETAIL = { id: 'WB005', name: 'Golden Gate assembly', domain: 'Build', description: 'Type IIS assembly', paper_count: 12, run_count: 10, extracted_count: 9, extraction_rate: 0.75, state: { runs: [] } };
  const RESOURCES = {
    workflow_id: 'WB005',
    total_papers: 12,
    hardware_uos: [
      { catalog_id: 'UHW010', name: 'Liquid handling', occurrence_count: 7, source_papers: ['p1'], is_new: false },
      { catalog_id: 'UHW100', name: 'PCR', occurrence_count: 4 },
    ],
    software_uos: [{ catalog_id: 'USW020', name: 'Primer design', occurrence_count: 3 }],
    equipment: [{ name: 'thermocycler', count: 6, source_papers: ['p1'] }, { name: 'thermocycler', count: 1 }],
    consumables: [{ name: 'PCR tubes', count: 3 }],
    reagents: [{ name: 'BsaI', count: 8 }],
    samples: [{ name: 'pUC19', count: 2 }],
  };
  const notFound = (what: string) => () => {
    throw new NetError('status', 'raw-rust-text', 404, `{"detail":"${what} not found"}`);
  };

  it('its description sends the model to the local catalog first and says it only adds to it', () => {
    const { tools } = build({});
    const d = tools.find((x) => x.name === 'workflow_get_method')!.description;
    expect(d).toContain('search_catalog');
    expect(d).toMatch(/adds to the catalog/);
    expect(d).toMatch(/never guess a code/);
  });

  it('without uoId lists the Unit Operations from /resources and says it is not the lab protocol', async () => {
    const { tools, sent } = build({ '/api/workflows/WB005': DETAIL, '/api/workflows/WB005/resources': RESOURCES });
    const d = dataOf(await call(tools, 'workflow_get_method', { workflowId: 'WB005' }));
    expect(sent.map((s) => s.path)).toEqual(['/api/workflows/WB005', '/api/workflows/WB005/resources']);
    expect(d).toMatchObject({ workflowId: 'WB005', name: 'Golden Gate assembly', domain: 'Build', paperCount: 12 });
    expect(d.hardwareUos).toEqual([
      { uoId: 'UHW010', name: 'Liquid handling', papers: 7 },
      { uoId: 'UHW100', name: 'PCR', papers: 4 },
    ]);
    expect(d.softwareUos).toEqual([{ uoId: 'USW020', name: 'Primer design', papers: 3 }]);
    expect(d.link).toBe(`${ORIGIN}/workflows/WB005`);
    expect(d.source).toBe(PAPER_NOTICE);
  });

  it('with uoId reads the Unit Operation detail, clips fields and the whole result', async () => {
    const { tools, sent } = build({
      '/api/workflows/WB005/uo/UHW010': {
        id: 'UHW010',
        name: 'Liquid handling',
        type: 'hardware',
        input: ['template DNA', 'primers'],
        output: 'amplicon',
        equipment: ['thermocycler'],
        consumables: ['tubes'],
        material_and_method: 'm'.repeat(2000),
        method: 'short',
        parameters: { annealing: '58 C', cycles: 30 },
        environment: 'e'.repeat(2000),
        result: 'r'.repeat(2000),
        discussion: 'd'.repeat(2000),
      },
    });
    const d = dataOf(await call(tools, 'workflow_get_method', { workflowId: 'WB005', uoId: 'UHW010' }));
    expect(sent.map((s) => s.path)).toEqual(['/api/workflows/WB005/uo/UHW010']);
    expect(d).toMatchObject({ name: 'Liquid handling', type: 'hardware', input: 'template DNA; primers', parameters: 'annealing: 58 C; cycles: 30' });
    expect((d.method as string).startsWith('mmm')).toBe(true);
    expect((d.method as string).length).toBeLessThanOrEqual(800);
    const { source, link, cite, ...uo } = d;
    expect(JSON.stringify(uo).length).toBeLessThanOrEqual(6000);
    expect([source, link, cite]).toEqual([PAPER_NOTICE, `${ORIGIN}/workflows/WB005`, 1]);
  });

  it('include papers flattens the runs (accepted first, no duplicates); include resources reads the real keys', async () => {
    const run = (n: number, papers: unknown[]) => ({ run_id: `r${n}`, search_date: '2026-10-01', query: 'golden gate', papers });
    const { tools, sent } = build({
      '/api/workflows/WB005': DETAIL,
      '/api/workflows/WB005/resources': RESOURCES,
      '/api/workflows/WB005/papers': [
        run(1, [{ paper_id: 'a', title: 'Rejected paper', panel_verdict: 'reject', doi: '10.1/a', year: 2020 }]),
        run(2, [
          { paper_id: 'b', title: 'Good paper', panel_verdict: 'accept', doi: '10.1/b', year: 2022, journal: 'NAR' },
          { paper_id: 'a', title: 'Rejected paper', panel_verdict: 'reject', doi: '10.1/a' },
        ]),
      ],
    });
    const d = dataOf(await call(tools, 'workflow_get_method', { workflowId: 'WB005', include: ['papers', 'resources'] }));
    expect(sent.map((s) => s.path)).toEqual(['/api/workflows/WB005', '/api/workflows/WB005/resources', '/api/workflows/WB005/papers']);
    expect(d.papers).toEqual([
      { title: 'Good paper', verdict: 'accept', year: 2022, doi: '10.1/b' },
      { title: 'Rejected paper', verdict: 'reject', year: 2020, doi: '10.1/a' },
    ]);
    expect(d.resources).toEqual({
      equipment: ['thermocycler (6)'],
      consumables: ['PCR tubes (3)'],
      reagents: ['BsaI (8)'],
      samples: ['pUC19 (2)'],
    });
  });

  it('a large /papers answer is cut to 10 papers and the result stays small', async () => {
    const runs = Array.from({ length: 10 }, (_, r) => ({
      run_id: `r${r}`,
      papers: Array.from({ length: 40 }, (_, i) => ({ title: `Paper ${r}-${i} ${'t'.repeat(300)}`, panel_verdict: i % 2 ? 'accept' : 'reject', abstract: 'x'.repeat(500), doi: `10.1/${r}-${i}` })),
    }));
    const { tools } = build({ '/api/workflows/WB005/uo/UHW010': { type: 'hardware' }, '/api/workflows/WB005/papers': runs });
    const d = dataOf(await call(tools, 'workflow_get_method', { workflowId: 'WB005', uoId: 'UHW010', include: ['papers'] }));
    expect((d.papers as unknown[]).length).toBe(10);
    expect((d.papers as Array<{ verdict: string }>).every((p) => p.verdict === 'accept')).toBe(true);
    expect(JSON.stringify(d).length).toBeLessThan(6000);
  });

  it('a Workflow without paper data (404) is a normal answer that says so, not a failure', async () => {
    const { tools, sent } = build({ '/api/workflows/WD010': notFound('Workflow WD010'), '/api/workflows/WD010/resources': notFound('Workflow WD010') });
    const res = await call(tools, 'workflow_get_method', { workflowId: 'WD010', include: ['papers'] });
    expect(res.ok).toBe(true);
    const d = dataOf(res);
    expect(d).toMatchObject({ workflowId: 'WD010', noPaperData: true });
    expect(String(d.note)).toMatch(/no paper summaries/i);
    expect(d.link).toBeUndefined();
    expect(sent.map((s) => s.path)).toEqual(['/api/workflows/WD010']);
    expect(JSON.stringify(d)).not.toContain('raw-rust-text');
  });

  it('with uoId on a Workflow without paper data: the UO 404 and the Workflow 404 give noPaperData', async () => {
    const { tools, sent } = build({
      '/api/workflows/WD010/uo/UHW040': notFound('Workflow WD010'),
      '/api/workflows/WD010/resources': notFound('Workflow WD010'),
    });
    const res = await call(tools, 'workflow_get_method', { workflowId: 'WD010', uoId: 'UHW040' });
    expect(res.ok).toBe(true);
    expect(dataOf(res)).toMatchObject({ workflowId: 'WD010', uoId: 'UHW040', noPaperData: true });
    expect(sent.map((s) => s.path)).toEqual(['/api/workflows/WD010/uo/UHW040', '/api/workflows/WD010/resources']);
  });

  it('paper_count 0 is noPaperData too', async () => {
    const { tools } = build({ '/api/workflows/WD001': { ...DETAIL, id: 'WD001', paper_count: 0 } });
    expect(dataOf(await call(tools, 'workflow_get_method', { workflowId: 'WD001' }))).toMatchObject({ noPaperData: true });
  });

  it('a Unit Operation the papers of this Workflow do not cover is a normal answer with the codes they do cover', async () => {
    const { tools } = build({ '/api/workflows/WB005/uo/UHW015': notFound('UO UHW015'), '/api/workflows/WB005/resources': RESOURCES });
    const res = await call(tools, 'workflow_get_method', { workflowId: 'WB005', uoId: 'UHW015' });
    expect(res.ok).toBe(true);
    expect(dataOf(res)).toMatchObject({ workflowId: 'WB005', uoId: 'UHW015', uoNotInPapers: true, uosInPapers: ['UHW010', 'UHW100', 'USW020'] });
  });

  it('other errors are still failures', async () => {
    const { tools } = build({
      '/api/workflows/WB005': () => {
        throw new NetError('status', 'raw-rust-text', 500, 'body');
      },
    });
    expect((await call(tools, 'workflow_get_method', { workflowId: 'WB005' })).params).toEqual(['workflow', 'status', '500']);
  });

  it('refuses codes that are not catalog codes without IPC', async () => {
    const { tools, sent } = build({});
    for (const args of [{ workflowId: 'wd001' }, { workflowId: 'WD001', uoId: 'PCR' }, { workflowId: 'WD001', include: ['extractions'] }]) {
      expect((await call(tools, 'workflow_get_method', args)).params?.[1]).toBe('badArgs');
    }
    expect(sent).toEqual([]);
  });
});

describe('workflow_get_design with a catalog code', () => {
  it('refuses a catalog Workflow code without IPC and points to workflow_get_method', async () => {
    const { tools, sent } = build({});
    const res = await call(tools, 'workflow_get_design', { serviceId: 'WD010' });
    expect(res.params?.[1]).toBe('badArgs');
    expect(unfence(res.error).inner).toMatch(/workflow_get_method/);
    expect(sent).toEqual([]);
  });
});

describe('Workflow errors and budget', () => {
  it('the 9th call in a run is refused without IPC', async () => {
    const { tools, sent } = build({ '/api/services': [] });
    for (let i = 0; i < 8; i++) expect((await call(tools, 'workflow_list_designs', { includeArchived: i % 2 === 0 })).ok).toBe(true);
    const res = await call(tools, 'workflow_list_designs', {});
    expect(res.params).toEqual(['workflow', 'budget', '8']);
    expect(sent).toHaveLength(2);
  });

  it('the desktop app not running is its own message; a 429 says not to retry; no server text reaches the model', async () => {
    const notes: string[] = [];
    const a = build(
      {
        '/api/services': () => {
          throw new NetError('notConfigured', 'raw-rust-text');
        },
      },
      { desktop: true, origin: null, notify: (m) => notes.push(m) }
    );
    const r1 = await call(a.tools, 'workflow_list_designs', {});
    expect(r1.params).toEqual(['workflow', 'desktopNotRunning']);
    expect(unfence(r1.error).inner).toBe('The bfworkflow desktop app is not running.');
    expect(notes).toEqual([t('pet.labTools.notice.desktopNotRunning')]);

    const b = build({
      '/api/services': () => {
        throw new NetError('status', 'raw-rust-text', 429, 'slow down secret-body');
      },
    });
    const r2 = await call(b.tools, 'workflow_list_designs', {});
    expect(r2.params).toEqual(['workflow', 'rateLimited']);
    expect(unfence(r2.error).inner).toBe('The Workflow server is busy (too many requests). Try again later; do not retry now.');
    expect(JSON.stringify(r2)).not.toContain('secret-body');
    expect(JSON.stringify(r2)).not.toContain('raw-rust-text');
  });
});
