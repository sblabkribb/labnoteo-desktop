// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { isSystemPath, useTree, visibleEntries, type TreeEntry } from '../useTree';

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

  it('reload() 는 새 목록이 올 때까지 지금 줄을 그대로 둔다 (깜빡임 없음)', async () => {
    let finish: (v: TreeEntry[]) => void = () => {};
    let calls = 0;
    const invoke = (async () => {
      if (calls++ === 0) return [row('a.md')];
      return new Promise<TreeEntry[]>((r) => (finish = r));
    }) as never;
    const { result } = renderHook(() => useTree('A', invoke));
    await waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a.md']));

    const seen: string[][] = [];
    act(() => result.current.reload());
    seen.push(result.current.entries.map((e) => e.path));
    await waitFor(() => expect(calls).toBe(2));
    seen.push(result.current.entries.map((e) => e.path));
    expect(seen).toEqual([['a.md'], ['a.md']]);

    finish([row('a.md'), row('b.md')]);
    await waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a.md', 'b.md']));
  });

  it('reload() 가 실패하면 줄은 두고 실패 표시를 하며, 다음 reload() 가 성공하면 걷는다', async () => {
    let fail = false;
    const invoke = (async () => {
      if (fail) throw new Error('x');
      return [row('a.md')];
    }) as never;
    const { result } = renderHook(() => useTree('A', invoke));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    fail = true;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.failed).toBe(true));
    // 다시 읽기가 실패해도 이미 보이던 줄은 그대로다 (같은 보관함의 줄은 아직 유효하다).
    expect(result.current.entries.map((e) => e.path)).toEqual(['a.md']);
    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.failed).toBe(false));
    expect(result.current.entries).toHaveLength(1);
  });
});

describe('system files (catalog JSON, sample registries)', () => {
  it('isSystemPath is resources/workflows at the root and every resources/labsamples, any case', () => {
    for (const p of [
      'resources/workflows',
      'resources/workflows/catalog.json',
      'Resources/Workflows/x.json',
      'resources/labsamples',
      'resources/labsamples/DNA.json',
      'labnote/001_PCR/resources/labsamples/Primer.json',
    ]) expect(isSystemPath(p), p).toBe(true);
    for (const p of [
      'resources',
      'resources/plate.csv',
      'labnote/001_PCR/resources/workflows/x.json',
      'labnote/001_PCR/resources/gel.png',
      'labsamples/x.json',
      'notes/resources/workflowsX/a.json',
    ]) expect(isSystemPath(p), p).toBe(false);
  });

  it('are hidden by default and shown with the toggle', () => {
    const d = (path: string, depth: number): TreeEntry => ({ path, name: path.split('/').pop()!, isDir: true, depth });
    const f = (path: string, depth: number): TreeEntry => ({ ...d(path, depth), isDir: false });
    const all = [
      d('resources', 0),
      d('resources/labsamples', 1),
      f('resources/labsamples/DNA.json', 2),
      d('resources/workflows', 1),
      f('resources/workflows/catalog.json', 2),
      f('resources/plate.csv', 1),
      f('a.md', 0),
    ];
    expect(visibleEntries(all, false).map((e) => e.path)).toEqual(['resources', 'resources/plate.csv', 'a.md']);
    expect(visibleEntries(all, true)).toBe(all);
  });
});
