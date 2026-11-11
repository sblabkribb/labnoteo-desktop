/**
 * `search_catalog`(assistant plan Task 11A, spec §4.4): 보관함의 카탈로그 파일에서 단위 공정·워크플로를 찾는 읽기 도구.
 * 피커와 같은 순위(`rankPickItems`), 한국어 이름·검색어로도 찾고, 카탈로그 파일이 없으면 아무것도 쓰지 않고
 * "카탈로그 업데이트" 안내를 돌려준다.
 */
import { MemFileSystem, runTool, type ToolContext } from '@labnoteo/core';
import { ensureWorkflowResources } from '@labnoteo/core/lib/workflowDataLoader';
import { setLang } from '../../../i18n/lang';
import { SEARCH_CATALOG_MAX, searchCatalogTool } from '../searchCatalog';

async function seeded(): Promise<MemFileSystem> {
  const fs = new MemFileSystem();
  await ensureWorkflowResources(fs, '.');
  return fs;
}

const ctxOf = (fs: MemFileSystem): ToolContext => ({ fs, workspaceRoot: '.' });
const run = (ctx: ToolContext, args: Record<string, unknown>) => runTool([searchCatalogTool()], 'search_catalog', ctx, args);
type Hit = { kind: string; id: string; name: string; nameKo?: string; category: string; description: string; equipment?: string; software?: string };
const hitsOf = (res: { ok: boolean; data?: unknown; error?: string }): Hit[] => {
  expect(res.error).toBeUndefined();
  expect(res.ok).toBe(true);
  return (res.data as { results: Hit[] }).results;
};

beforeEach(() => setLang('en'));

describe('search_catalog', () => {
  it('is read-only and takes kind, query and limit', () => {
    const def = searchCatalogTool();
    expect(def.name).toBe('search_catalog');
    expect(def.mutates).toBe(false);
    expect(def.describe).toBeUndefined();
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(['kind', 'limit', 'query']);
    expect(def.inputSchema.required).toEqual(['query']);
  });

  it('finds a unit operation by its id and by English words, with its category and equipment or software', async () => {
    const ctx = ctxOf(await seeded());
    const byId = hitsOf(await run(ctx, { kind: 'unitOp', query: 'UHW010' }));
    expect(byId[0]).toMatchObject({ kind: 'unitOp', id: 'UHW010', name: 'Liquid Handling', category: 'HW' });
    expect(byId[0].equipment).toBeTruthy();
    expect(byId[0].software).toBeUndefined();
    const sw = hitsOf(await run(ctx, { query: 'USW005' }));
    expect(sw[0]).toMatchObject({ kind: 'unitOp', id: 'USW005', category: 'SW' });
    expect(sw[0].software).toBeTruthy();
    const byWord = hitsOf(await run(ctx, { kind: 'unitOp', query: 'liquid handling' }));
    expect(byWord.map((h) => h.id)).toContain('UHW010');
  });

  it('finds unit operations and workflows by their Korean names and search words', async () => {
    const ctx = ctxOf(await seeded());
    expect(hitsOf(await run(ctx, { kind: 'unitOp', query: '액체 분주' }))[0].id).toBe('UHW010');
    expect(hitsOf(await run(ctx, { kind: 'unitOp', query: '피펫팅' })).map((h) => h.id)).toContain('UHW010');
    expect(hitsOf(await run(ctx, { kind: 'workflow', query: 'DNA 조립' }))[0].id).toBe('WB030');
    expect(hitsOf(await run(ctx, { kind: 'workflow', query: '깁슨' })).map((h) => h.id)).toContain('WB030');
  });

  it('searches software unit operations too, and workflows only for kind workflow', async () => {
    const ctx = ctxOf(await seeded());
    const sw = hitsOf(await run(ctx, { kind: 'unitOp', query: 'USW' }));
    expect(sw.some((h) => h.id.startsWith('USW'))).toBe(true);
    const wf = hitsOf(await run(ctx, { kind: 'workflow', query: 'UHW010' }));
    expect(wf.every((h) => !h.id.startsWith('U'))).toBe(true);
  });

  it('caps limit at 10 and defaults to 5', async () => {
    const ctx = ctxOf(await seeded());
    expect(SEARCH_CATALOG_MAX).toBe(10);
    expect(hitsOf(await run(ctx, { kind: 'unitOp', query: 'U', limit: 50 }))).toHaveLength(10);
    expect(hitsOf(await run(ctx, { kind: 'unitOp', query: 'U' }))).toHaveLength(5);
    expect(hitsOf(await run(ctx, { kind: 'unitOp', query: 'U', limit: 2 }))).toHaveLength(2);
  });

  it('a bad kind or an empty query is refused', async () => {
    const ctx = ctxOf(await seeded());
    expect((await run(ctx, { kind: 'sample', query: 'x' })).ok).toBe(false);
    expect((await run(ctx, { kind: 'unitOp', query: '  ' })).ok).toBe(false);
  });

  it('a missing catalog file writes nothing and returns the "Update catalogs" hint', async () => {
    const fs = new MemFileSystem({ 'labnote/001_Test/README.labnote.md': '# x\n' });
    const write = vi.spyOn(fs, 'write');
    const mkdir = vi.spyOn(fs, 'mkdir');
    for (const kind of ['unitOp', 'workflow']) {
      const res = await run(ctxOf(fs), { kind, query: 'PCR' });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('catalogMissing');
      expect(res.error).toMatch(/Update catalogs/);
    }
    expect(write).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(await fs.exists('resources/workflows/workflows_en.json')).toBe(false);
  });

  it('without kind a code finds its own kind, and a name finds Workflows and Unit Operations', async () => {
    const ctx = ctxOf(await seeded());
    const wf = hitsOf(await run(ctx, { query: 'wb030' }));
    expect(wf[0]).toMatchObject({ kind: 'workflow', id: 'WB030' });
    expect(wf[0].category).toBeTruthy();
    expect(wf.every((h) => h.kind === 'workflow')).toBe(true);
    const both = hitsOf(await run(ctx, { query: 'assembly', limit: 10 }));
    expect(both.some((h) => h.kind === 'workflow')).toBe(true);
    expect(hitsOf(await run(ctx, { query: '액체 분주' }))[0].id).toBe('UHW010');
  });

  it('an exact code keeps its whole description; other hits are clipped', async () => {
    const fs = await seeded();
    const path = 'resources/workflows/workflows_en.json';
    const json = JSON.parse(await fs.read(path)) as { workflows: Array<Record<string, unknown>> };
    const long = 'x'.repeat(900);
    json.workflows[0] = { ...json.workflows[0], description: long };
    await fs.write(path, JSON.stringify(json));
    const id = json.workflows[0].id as string;
    expect(hitsOf(await run(ctxOf(fs), { query: id }))[0].description).toBe(long);
    const byName = hitsOf(await run(ctxOf(fs), { kind: 'workflow', query: String(json.workflows[0].name) }));
    expect(byName[0].description.length).toBeLessThan(400);
  });

  it("returns a Workflow's typical Unit Operations only when the catalog lists them", async () => {
    const fs = await seeded();
    const path = 'resources/workflows/workflows_en.json';
    const json = JSON.parse(await fs.read(path)) as { workflows: Array<Record<string, unknown>> };
    const id = json.workflows[0].id as string;
    expect((hitsOf(await run(ctxOf(fs), { query: id }))[0] as Record<string, unknown>).unitOperations).toBeUndefined();
    json.workflows[0] = { ...json.workflows[0], unitOperations: ['UHW010', { id: 'UHW100' }] };
    await fs.write(path, JSON.stringify(json));
    expect((hitsOf(await run(ctxOf(fs), { query: id }))[0] as Record<string, unknown>).unitOperations).toEqual(['UHW010', 'UHW100']);
  });

  it('a long keyword query with no hit for every word still finds the best partial matches', async () => {
    const ctx = ctxOf(await seeded());
    const hits = hitsOf(await run(ctx, { query: 'liquid handling protocol for my samples' }));
    expect(hits[0].id).toBe('UHW010');
  });

  it('no hit is an empty list, not an error', async () => {
    const ctx = ctxOf(await seeded());
    expect(hitsOf(await run(ctx, { kind: 'workflow', query: 'zzzz-nothing' }))).toEqual([]);
  });
});
