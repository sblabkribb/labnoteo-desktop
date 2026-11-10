// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchPanel } from '../SearchPanel';
import type { SearchHit, SearchResults } from '../indexApi';

const hit: SearchHit = { path: 'lab/001/02.labnote.md', title: '형질전환 실험', snippet: '…대장균 형질전환 효율…' };

/** 가짜 invoke: search 호출의 인자를 기록하고 hits 를 돌려준다. */
function fake(hits: SearchHit[], truncated = false) {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'search') throw new Error(`unexpected ${cmd}`);
    calls.push(args);
    return { hits, truncated } satisfies SearchResults;
  }) as never;
  return { calls, invoke };
}

describe('검색 패널', () => {
  it('검색 결과를 고르면 그 노트를 연다', async () => {
    const user = userEvent.setup();
    const { calls, invoke } = fake([hit]);
    const opened: string[] = [];
    render(<SearchPanel invoke={invoke} onOpen={(p) => opened.push(p)} />);

    await user.type(screen.getByRole('searchbox'), '형질전환');
    const result = await screen.findByRole('button', { name: /형질전환 실험/ });
    expect(screen.getByText(/대장균 형질전환 효율/)).toBeTruthy();
    expect(calls.at(-1)).toEqual({ query: '형질전환', limit: 50 });

    await user.click(result);
    // 디스크에서 읽은 철자의 vault-relative 경로 그대로 넘긴다.
    expect(opened).toEqual(['lab/001/02.labnote.md']);
  });

  it('결과가 없으면 빈 결과 문구를, 입력이 비어 있으면 아무 문구도 보이지 않는다', async () => {
    const user = userEvent.setup();
    const { calls, invoke } = fake([]);
    render(<SearchPanel invoke={invoke} onOpen={() => {}} />);
    expect(screen.queryByText('검색 결과가 없습니다')).toBeNull();

    await user.type(screen.getByRole('searchbox'), '없는말');
    expect(await screen.findByText('검색 결과가 없습니다')).toBeTruthy();

    await user.clear(screen.getByRole('searchbox'));
    await waitFor(() => expect(screen.queryByText('검색 결과가 없습니다')).toBeNull());
    // 비어 있는 입력은 호출하지 않는다.
    expect(calls.every((c) => String(c?.query).trim() !== '')).toBe(true);
  });

  it('검색이 실패하면 오류 문구를 보인다', async () => {
    const user = userEvent.setup();
    const invoke = (async () => {
      throw { kind: 'io', message: 'x' };
    }) as never;
    render(<SearchPanel invoke={invoke} onOpen={() => {}} />);
    await user.type(screen.getByRole('searchbox'), '가나다');
    expect((await screen.findByRole('alert')).textContent).toBe('검색할 수 없습니다.');
  });

  it('결과가 잘렸으면 몇 개까지만 보이는지 알려 준다', async () => {
    const user = userEvent.setup();
    render(<SearchPanel invoke={fake([hit], true).invoke} onOpen={() => {}} />);
    await user.type(screen.getByRole('searchbox'), '실험');
    expect(await screen.findByText(/1개 이상 일치합니다/)).toBeTruthy();
  });

  it('잘리지 않았으면 그런 문구가 없다', async () => {
    const user = userEvent.setup();
    render(<SearchPanel invoke={fake([hit]).invoke} onOpen={() => {}} />);
    await user.type(screen.getByRole('searchbox'), '실험');
    await screen.findByRole('button', { name: /형질전환 실험/ });
    expect(screen.queryByText(/개 이상 일치/)).toBeNull();
  });

  it('skips system files (catalog, sample registries) unless they are shown', async () => {
    const user = userEvent.setup();
    const sys: SearchHit = { path: 'resources/labsamples/notes.md', title: '등록부 메모', snippet: '…형질전환…' };
    const { invoke } = fake([sys, hit]);
    const { rerender } = render(<SearchPanel invoke={invoke} onOpen={() => {}} />);
    await user.type(screen.getByRole('searchbox'), '형질전환');
    await screen.findByRole('button', { name: /형질전환 실험/ });
    expect(screen.queryByRole('button', { name: /등록부 메모/ })).toBeNull();
    rerender(<SearchPanel invoke={invoke} onOpen={() => {}} showSystem />);
    expect(screen.getByRole('button', { name: /등록부 메모/ })).toBeTruthy();
  });
});
