// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { useTree, type TreeEntry } from '../useTree';

const row = (path: string): TreeEntry => ({ path, name: path, isDir: false, depth: 0 });

describe('트리 훅', () => {
  it('다른 보관함으로 바뀌면 새 목록이 올 때까지 이전 보관함의 줄을 비운다', async () => {
    let finishB: (v: TreeEntry[]) => void = () => {};
    const invoke = (async () => {
      if (calls++ === 0) return [row('a-only.md')];
      return new Promise<TreeEntry[]>((r) => (finishB = r));
    }) as never;
    let calls = 0;
    const { result, rerender } = renderHook(({ key }) => useTree(key, invoke), { initialProps: { key: 'A' } });
    await waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a-only.md']));

    rerender({ key: 'B' });
    await waitFor(() => expect(result.current.entries).toEqual([]));

    finishB([row('b-only.md')]);
    await waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['b-only.md']));
  });
});
