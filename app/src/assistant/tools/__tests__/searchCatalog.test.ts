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
type Hit = { id: string; name: string; description: string };
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
    expect(def.inputSchema.required).toEqual(['kind', 'query']);
  });

  it('finds a unit operation by its id and by English words; results are {id, name, description} only', async () => {
    const ctx = ctxOf(await seeded());
    const byId = hitsOf(await run(ctx, { kind: 'unitOp', query: 'UHW010' }));
    expect(byId[0].id).toBe('UHW010');
    for (const h of byId) expect(Object.keys(h).sort()).toEqual(['description', 'id', 'name']);
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

  it('no hit is an empty list, not an error', async () => {
    const ctx = ctxOf(await seeded());
    expect(hitsOf(await run(ctx, { kind: 'workflow', query: 'zzzz-nothing' }))).toEqual([]);
  });
});
