// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchPanel } from '../SearchPanel';
import type { SearchHit } from '../indexApi';

const hit: SearchHit = { path: 'lab/001/02.labnote.md', title: '형질전환 실험', snippet: '…대장균 형질전환 효율…' };

/** 가짜 invoke: search 호출의 인자를 기록하고 hits 를 돌려준다. */
function fake(hits: SearchHit[]) {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'search') throw new Error(`unexpected ${cmd}`);
    calls.push(args);
    return hits;
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

  it('색인을 만드는 중이면 그렇다고 알려 준다', () => {
    render(<SearchPanel invoke={fake([]).invoke} onOpen={() => {}} indexing />);
    expect(screen.getByText('색인을 만드는 중입니다')).toBeTruthy();
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
});
