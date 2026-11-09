// @vitest-environment jsdom
/**
 * partbank 검색 창: 글자마다 묻지 않고(400 ms 쉼 뒤 한 번), 늦게 온 옛 답이 지금 목록을 덮지 않고,
 * 한글을 조합하는 동안에는 검색도 고르기도 하지 않는다.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartbankSearchEntity } from '@labnoteo/core';
import { setLang } from '../../i18n/lang';
import { PartbankClient, type PartbankSearchHit, type PartbankSearchResult } from '../../labnote/port/partbankClient';
import { PartbankSearchDialog, searchPartbankDialog, type PartbankSearchOpts } from '../PartbankSearchDialog';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from '../../labnote/host/__tests__/harness';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';

const OID1 = '64b7f0c1a2b3c4d5e6f70811';
const OID2 = '64b7f0c1a2b3c4d5e6f70812';

function hit(id: string, name: string, overrides: Partial<PartbankSearchHit> = {}): PartbankSearchHit {
  return {
    type: 'plasmid',
    id,
    kid: `KP_${name}`,
    name,
    description: null,
    moleculeType: null,
    ownedByMe: true,
    sharingLevel: 'private',
    ...overrides,
  };
}

type Search = (query: string, entities: PartbankSearchEntity[]) => Promise<PartbankSearchResult>;

/** searchGlobal 만 바꾼 클라이언트. 다른 메서드는 부르면 unrouted 로 거절된다. */
function clientWith(search: Search): { client: PartbankClient; search: ReturnType<typeof vi.fn<Search>> } {
  const client = new PartbankClient('web', 'https://partbank.kbiofoundry.kr', fakeInvoke({}).invoke);
  const fn = vi.fn<Search>(search);
  client.searchGlobal = fn as unknown as PartbankClient['searchGlobal'];
  return { client, search: fn };
}

function setup(search: Search, opts: Partial<PartbankSearchOpts> = {}) {
  const c = clientWith(search);
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const onError = vi.fn();
  const full: PartbankSearchOpts = {
    type: 'Plasmid',
    initialQuery: '',
    client: c.client,
    entities: ['vector'],
    onError,
    ...opts,
  };
  render(<PartbankSearchDialog spec={{ kind: 'partbankSearch', opts: full }} onDone={onDone} onCancel={onCancel} />);
  const input = screen.getByRole('combobox') as HTMLInputElement;
  return { ...c, onDone, onCancel, onError, input };
}

/** 미뤄 둔 약속을 끝낸 뒤 React 갱신까지 흘려보낸다. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.input(input, { target: { value } });
}

const rows = () => screen.queryAllByRole('option').map((o) => o.querySelector('.picker-label')?.textContent);

beforeEach(() => {
  setLang('en');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanupDialogs();
});

describe('PartbankSearchDialog', () => {
  it('searches once, 400 ms after the last keystroke, from 2 characters', async () => {
    const { input, search } = setup(async () => ({ hits: [] }));
    expect(input.placeholder).toBe('Search partbank');
    type(input, 'p');
    vi.advanceTimersByTime(1000);
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText('Type at least 2 characters to search partbank.')).toBeTruthy();
    type(input, 'pU');
    vi.advanceTimersByTime(399);
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText('Searching partbank…')).toBeTruthy();
    vi.advanceTimersByTime(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('pU', ['vector']);
    await flush();
    vi.advanceTimersByTime(1000);
    expect(search).toHaveBeenCalledTimes(1);
    expect(styleAttributes()).toEqual([]);
  });

  it('does not search or pick while composing', async () => {
    const { input, search, onDone } = setup(async () => ({ hits: [hit(OID1, 'pUC19')] }));
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: '플라스' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    vi.advanceTimersByTime(1000);
    expect(search).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: '플라스' });
    vi.advanceTimersByTime(399);
    expect(search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(search).toHaveBeenCalledWith('플라스', ['vector']);
    expect(onDone).not.toHaveBeenCalled();
    // 조합이 끝난 뒤 브라우저가 같은 글자로 input 을 한 번 더 보내도 다시 묻지 않는다
    fireEvent.input(input, { target: { value: '플라스' } });
    vi.advanceTimersByTime(1000);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('Enter while composing does not pick a shown hit', async () => {
    const { input, onDone } = setup(async () => ({ hits: [hit(OID1, 'pUC19')] }));
    type(input, 'pUC');
    vi.advanceTimersByTime(400);
    await flush();
    expect(rows()).toEqual(['pUC19']);
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onDone).not.toHaveBeenCalled();
    // 조합 플래그 없이 Enter 가 와도, compositionend 전이면 고르지 않는다
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: '' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: OID1 }));
  });

  it('Escape while composing does not cancel; Escape after it does', () => {
    const { input, onCancel } = setup(async () => ({ hits: [] }));
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: '' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('drops a stale answer', async () => {
    const answers = new Map<string, (r: PartbankSearchResult) => void>();
    const { input, search } = setup((q) => new Promise((resolve) => answers.set(q, resolve)));
    type(input, 'pUC');
    vi.advanceTimersByTime(400);
    type(input, 'pUC1');
    vi.advanceTimersByTime(400);
    expect(search.mock.calls.map((c) => c[0])).toEqual(['pUC', 'pUC1']);
    answers.get('pUC1')!({ hits: [hit(OID2, 'pUC19')] });
    await flush();
    answers.get('pUC')!({ hits: [hit(OID1, 'pUC-old')] });
    await flush();
    expect(rows()).toEqual(['pUC19']);
  });

  it('arrow keys move and Enter picks the active row', async () => {
    const { input, onDone } = setup(async () => ({ hits: [hit(OID1, 'pUC19'), hit(OID2, 'pUC57')] }));
    type(input, 'pUC');
    vi.advanceTimersByTime(400);
    await flush();
    expect(rows()).toEqual(['pUC19', 'pUC57']);
    const detail = screen.getAllByRole('option')[0].querySelector('.picker-desc')?.textContent;
    expect(detail).toBe('KP_pUC19 · plasmid · mine');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: OID2 }));
  });

  it('shows the not-found sentence with the public-items hint', async () => {
    const { input } = setup(async () => ({ hits: [] }));
    type(input, 'zz');
    vi.advanceTimersByTime(400);
    await flush();
    const note = document.querySelector('.partbank-search-status')?.textContent ?? '';
    expect(note).toContain('Nothing found among partbank plasmids.');
    expect(note).toContain('Only your own items and items shared with your groups are searched, not public ones.');
    expect(note).toContain('Search parts with @dna; or @sample;.');
  });

  it('shows the truncation notice under the list', async () => {
    const many = Array.from({ length: 10 }, (_, i) => hit(`${OID1.slice(0, -2)}${String(i).padStart(2, '0')}`, `p${i}`));
    const { input } = setup(async () => ({ hits: many, typeCounts: { plasmid: 23 } }));
    type(input, 'p1');
    vi.advanceTimersByTime(400);
    await flush();
    expect(screen.getByText('Only the first 10 of each type are shown (plasmid 23). Type more to narrow the search.')).toBeTruthy();
  });

  it('starts with initialQuery and searches it', async () => {
    const { input, search } = setup(async () => ({ hits: [hit(OID1, 'pUC19')] }), { initialQuery: 'pUC' });
    expect(input.value).toBe('pUC');
    vi.advanceTimersByTime(400);
    expect(search).toHaveBeenCalledWith('pUC', ['vector']);
    await flush();
    expect(rows()).toEqual(['pUC19']);
  });

  it('reports a search failure through onError and keeps the dialog open', async () => {
    const boom = new Error('offline');
    const { input, onError, onCancel, onDone } = setup(async () => {
      throw boom;
    });
    type(input, 'pUC');
    vi.advanceTimersByTime(400);
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.queryByText('Searching partbank…')).toBeNull();
  });
});

describe('searchPartbankDialog', () => {
  it('opens in the dialog layer and resolves to the clicked hit, undefined on Escape', async () => {
    renderLayer();
    const { client } = clientWith(async () => ({ hits: [hit(OID1, 'pUC19')] }));
    const opts: PartbankSearchOpts = { type: null, initialQuery: 'pUC', client, entities: ['vector'], onError: () => undefined };
    const picked = openIn(() => searchPartbankDialog(opts));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await flush();
    fireEvent.click(screen.getByRole('option'));
    await expect(picked).resolves.toMatchObject({ id: OID1 });

    const dismissed = openIn(() => searchPartbankDialog(opts));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await expect(dismissed).resolves.toBeUndefined();
  });
});
