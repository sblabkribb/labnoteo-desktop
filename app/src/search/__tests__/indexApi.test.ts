import { indexBodies, searchNotesIn } from '../indexApi';

describe('indexBodies', () => {
  it('asks index_bodies for one page after a key', async () => {
    const page = { items: [{ path: 'A.md', body: 'a' }], next: null };
    const invoke = vi.fn(async () => page);
    expect(await indexBodies(null, 200, invoke as never)).toBe(page);
    expect(invoke).toHaveBeenCalledWith('index_bodies', { after: null, limit: 200 });
    await indexBodies('b.md', 5, invoke as never);
    expect(invoke).toHaveBeenLastCalledWith('index_bodies', { after: 'b.md', limit: 5 });
  });
});

describe('searchNotesIn', () => {
  it('asks index_search_in for hits inside one folder', async () => {
    const res = { hits: [{ path: 'labnote/001_A/README.md', title: 'A', snippet: 's' }], truncated: false };
    const invoke = vi.fn(async () => res);
    expect(await searchNotesIn('agarose', 'labnote/001_A', 20, invoke as never)).toBe(res);
    expect(invoke).toHaveBeenCalledWith('index_search_in', { query: 'agarose', prefix: 'labnote/001_A', limit: 20 });
  });

  it('passes a Rust refusal (badInput) through unchanged', async () => {
    const err = { kind: 'badInput', message: 'folder prefix "..": empty, . or .. segment' };
    const invoke = vi.fn(async () => {
      throw err;
    });
    await expect(searchNotesIn('x', '..', 5, invoke as never)).rejects.toBe(err);
  });
});
