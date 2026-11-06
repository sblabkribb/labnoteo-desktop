import { indexBodies } from '../indexApi';

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
