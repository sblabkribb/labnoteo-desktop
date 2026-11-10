// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { PickItem } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import { ALIAS_BACK, aliasDialog, pickDialog, pickThen } from '../dialogStore';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from './harness';

/** 카탈로그 고르기(UI 재설계 Task 11): 한 줄 행, 묶음 머리, 최근, 별칭 단계의 뒤로/Esc. */

const ITEMS: PickItem<string>[] = [
  { label: 'WD010: Protein Design', description: '단백질 설계 · Design', detail: '단백질을 설계합니다.', value: 'WD010' },
  { label: 'WB010: DNA Oligomer Assembly', description: 'DNA 올리고머 조립 · Build', detail: '올리고를 조립합니다.', value: 'WB010' },
  { label: 'WB030: DNA Assembly', description: 'DNA 조립 · Build', detail: 'DNA 조각을 조립합니다.', keywords: ['DNA 조립'], value: 'WB030' },
  { label: 'WT010: Nucleotide Sequencing', description: '염기서열 분석 · Test', value: 'WT010' },
];
const GROUP: Record<string, string> = { WD010: 'Design', WB010: 'Build', WB030: 'Build', WT010: 'Test' };
const opts = { title: '워크플로 선택', catalog: true, groupOf: (i: PickItem<unknown>) => GROUP[i.value as string], recentKey: 'test-wf' };

const options = () => screen.queryAllByRole('option');
const groups = () => [...document.querySelectorAll('.picker-group')].map((g) => g.textContent);

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

beforeEach(() => {
  setLang('ko');
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  cleanupDialogs();
  vi.unstubAllGlobals();
});

describe('catalog picker rows', () => {
  it('one-line rows: mono code, English name, muted description; only the active row shows its detail', async () => {
    renderLayer();
    const p = openIn(() => pickDialog(ITEMS, opts));
    const first = options()[0];
    expect(first.querySelector('.picker-code')?.textContent).toBe('WD010');
    expect(first.querySelector('.picker-label')?.textContent).toBe('Protein Design');
    expect(first.querySelector('.picker-desc')?.textContent).toBe('단백질 설계 · Design');
    expect(first.querySelector('.picker-detail')?.textContent).toBe('단백질을 설계합니다.');
    expect(options()[1].querySelector('.picker-detail')).toBeNull();
    await userEvent.keyboard('{ArrowDown}');
    expect(options()[0].querySelector('.picker-detail')).toBeNull();
    expect(options()[1].querySelector('.picker-detail')?.textContent).toBe('올리고를 조립합니다.');
    await userEvent.keyboard('{Enter}');
    await expect(p).resolves.toBe('WB010');
    expect(styleAttributes()).toEqual([]);
  });

  it('group headers without a query; a flat ranked list once something is typed', async () => {
    renderLayer();
    openIn(() => pickDialog(ITEMS, opts));
    expect(groups()).toEqual(['Design', 'Build', 'Test']);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '조립' } });
    expect(groups()).toEqual([]);
    expect(options()[0].querySelector('.picker-code')?.textContent).toBe('WB030');
  });

  it('recent picks come first under 최근, and are not repeated in their group', async () => {
    renderLayer();
    const p = openIn(() => pickDialog(ITEMS, opts));
    await userEvent.click(options()[3]);
    await expect(p).resolves.toBe('WT010');
    openIn(() => pickDialog(ITEMS, opts));
    expect(groups()).toEqual(['최근', 'Design', 'Build']);
    expect(options()[0].querySelector('.picker-code')?.textContent).toBe('WT010');
    expect(options()).toHaveLength(4);
  });

  it('works without storage (it throws): no recent group, nothing breaks', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    renderLayer();
    const p = openIn(() => pickDialog(ITEMS, opts));
    expect(groups()).toEqual(['Design', 'Build', 'Test']);
    await userEvent.click(options()[0]);
    await expect(p).resolves.toBe('WD010');
  });

  it('opens with the given query and reports what is typed', async () => {
    renderLayer();
    const seen: string[] = [];
    openIn(() => pickDialog(ITEMS, { ...opts, query: '조립', onQuery: (q) => seen.push(q) }));
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('조립');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'DNA' } });
    expect(seen.at(-1)).toBe('DNA');
  });
});

describe('picker → alias steps', () => {
  const flow = () =>
    pickThen(
      (step) => pickDialog(ITEMS, { ...opts, ...step }),
      (id) => aliasDialog({ id, catalogName: 'x', back: true }),
    );

  it('Esc on the alias step returns to the picker with the previous query; Esc again closes', async () => {
    renderLayer();
    const p = openIn(flow);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '조립' } });
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('textbox')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '별칭 (선택)' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    const box = (await screen.findByRole('combobox')) as HTMLInputElement;
    expect(box.value).toBe('조립');
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Back button does the same, and a submitted alias finishes the flow', async () => {
    renderLayer();
    const p = openIn(flow);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'WT' } });
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: '← 다시 고르기' }));
    const box = (await screen.findByRole('combobox')) as HTMLInputElement;
    expect(box.value).toBe('WT');
    await userEvent.keyboard('{Enter}');
    await userEvent.type(await screen.findByRole('textbox'), '1차{Enter}');
    await expect(p).resolves.toEqual({ value: 'WT010', result: '1차' });
  });

  it('without back, the alias dialog has no Back button and Esc closes it', async () => {
    renderLayer();
    const p = openIn(() => aliasDialog({ id: 'WT010', catalogName: 'x' }));
    expect(screen.queryByRole('button', { name: '← 다시 고르기' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBeUndefined();
  });

  it('the alias title is localised', async () => {
    renderLayer();
    openIn(() => aliasDialog({ id: 'WT010', catalogName: 'x', back: true }));
    expect(screen.getByRole('dialog', { name: '별칭 (선택)' })).toBeTruthy();
    act(() => setLang('en'));
    expect(screen.getByRole('dialog', { name: 'Alias (optional)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Back' })).toBeTruthy();
    void ALIAS_BACK;
  });
});
