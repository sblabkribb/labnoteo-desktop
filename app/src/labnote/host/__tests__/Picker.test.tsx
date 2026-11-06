// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PickItem } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import { pickDialog, pickManyDialog } from '../dialogStore';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from './harness';

afterEach(() => cleanupDialogs());

const STATUSES: PickItem<string>[] = [
  { label: 'planned', description: '계획됨', value: 'planned' },
  { label: 'in-progress', description: '진행 중', value: 'in-progress' },
  { label: 'completed', description: '완료', detail: '결과까지 적었다', value: 'completed' },
  { label: 'needs-repeat', keywords: ['재실험', '반복'], value: 'needs-repeat' },
  { label: 'cancelled', dimmed: true, value: 'cancelled' },
];

const combobox = () => screen.getByRole('combobox');
const options = () => screen.queryAllByRole('option');
const labelOf = (el: Element) => el.querySelector('.picker-label')?.textContent;
const activeLabel = () => {
  const active = options().find((o) => o.getAttribute('aria-selected') === 'true');
  return active && labelOf(active);
};

describe('고르기 대화상자', () => {
  it('pick resolves the chosen value and opens on selected', async () => {
    renderLayer();
    const p = openIn(() => pickDialog(STATUSES, { title: '상태 바꾸기', selected: 'completed' }));
    expect(screen.getByRole('dialog', { name: '상태 바꾸기' })).toBeTruthy();
    expect(document.activeElement).toBe(combobox());
    // 지금 값이 맨 위에서 골라진 채로 열린다: Enter 는 지금 값을 지킨다
    expect(labelOf(options()[0])).toBe('completed');
    expect(activeLabel()).toBe('completed');
    expect(combobox().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(activeLabel()).toBe('in-progress');
    await userEvent.keyboard('{Enter}');
    await expect(p).resolves.toBe('in-progress');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('설명·상세 줄을 보이고, 흐린 항목에는 dimmed 를 단다', () => {
    renderLayer();
    void openIn(() => pickDialog(STATUSES));
    const completed = options()[2];
    expect(completed.querySelector('.picker-desc')?.textContent).toBe('완료');
    expect(completed.querySelector('.picker-detail')?.textContent).toBe('결과까지 적었다');
    expect(options()[4].classList.contains('dimmed')).toBe(true);
    expect(options()[0].classList.contains('dimmed')).toBe(false);
  });

  it('typing 재실험 finds needs-repeat via keywords', async () => {
    renderLayer();
    const p = openIn(() => pickDialog(STATUSES));
    await userEvent.type(combobox(), '재실험');
    expect(options().map(labelOf)).toEqual(['needs-repeat']);
    await userEvent.keyboard('{Enter}');
    await expect(p).resolves.toBe('needs-repeat');
  });

  it('맞는 것이 없으면 그렇다고 말하고, Enter 는 아무것도 고르지 않는다', async () => {
    renderLayer();
    void openIn(() => pickDialog(STATUSES));
    await userEvent.type(combobox(), 'zzz');
    expect(options()).toEqual([]);
    expect(screen.getByText('맞는 항목이 없습니다.')).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('클릭으로도 고른다', async () => {
    renderLayer();
    const p = openIn(() => pickDialog(STATUSES));
    await userEvent.click(screen.getByText('planned'));
    await expect(p).resolves.toBe('planned');
  });

  it('PageDown/PageUp 은 열 줄씩 움직이고 끝에서 멈춘다; 200 줄 넘게는 그리지 않는다', async () => {
    renderLayer();
    const many = Array.from({ length: 250 }, (_, i) => ({ label: `item ${i}`, value: i }));
    const p = openIn(() => pickDialog(many));
    expect(options()).toHaveLength(200);
    expect(screen.getByText('50개가 더 있습니다. 검색어를 더 적어 좁히세요.')).toBeTruthy();
    await userEvent.keyboard('{PageDown}{PageDown}{ArrowUp}');
    expect(activeLabel()).toBe('item 19');
    await userEvent.keyboard('{PageUp}{PageUp}{PageUp}');
    expect(activeLabel()).toBe('item 0');
    await userEvent.keyboard('{ArrowUp}');
    expect(activeLabel()).toBe('item 0');
    await userEvent.keyboard('{Enter}');
    await expect(p).resolves.toBe(0);
  });

  it('Escape resolves undefined; pickMany Escape resolves []', async () => {
    renderLayer();
    const one = openIn(() => pickDialog(STATUSES));
    await userEvent.keyboard('{Escape}');
    await expect(one).resolves.toBeUndefined();
    const many = openIn(() => pickManyDialog(STATUSES));
    await userEvent.keyboard('{Escape}');
    await expect(many).resolves.toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('IME 조합 중의 Escape 는 대화상자를 닫지 않는다 (조합만 취소된다)', () => {
    renderLayer();
    void openIn(() => pickDialog(STATUSES));
    fireEvent.keyDown(combobox(), { key: 'Escape', isComposing: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('IME 조합을 끝내는 Enter 는 고르지 않는다', () => {
    renderLayer();
    void openIn(() => pickDialog(STATUSES));
    fireEvent.keyDown(combobox(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(combobox(), { key: 'Enter', keyCode: 229 });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('pickMany: 처음 체크 상태로 열리고, Space 로 바꾸고, 걸러도 체크가 남고, Enter 로 체크한 것을 원래 순서로 돌려준다', async () => {
    renderLayer();
    const items = STATUSES.map((s) => ({ ...s, checked: s.value === 'completed' }));
    const p = openIn(() => pickManyDialog(items, { title: '여러 개 고르기' }));
    expect(screen.getByRole('dialog', { name: '여러 개 고르기' })).toBeTruthy();
    const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) }) as HTMLInputElement;
    expect(box('completed').checked).toBe(true);
    // 검색 칸에서 아래 화살표로 목록에 들어가 Space 로 체크한다
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(box('planned'));
    await userEvent.keyboard(' ');
    expect(box('planned').checked).toBe(true);
    // 검색 칸에서 친 빈칸은 글자다(primer design 같은 검색어)
    await userEvent.click(combobox());
    await userEvent.type(combobox(), '재실험');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    await userEvent.keyboard('{ArrowDown} ');
    expect(box('needs-repeat').checked).toBe(true);
    await userEvent.keyboard('{Enter}');
    await expect(p).resolves.toEqual(['planned', 'completed', 'needs-repeat']);
  });

  it('pickMany 의 확인 단추도 체크한 것을 돌려준다', async () => {
    renderLayer();
    const p = openIn(() => pickManyDialog(STATUSES));
    await userEvent.click(screen.getByRole('checkbox', { name: /^cancelled/ }));
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await expect(p).resolves.toEqual(['cancelled']);
  });

  it('labels change with setLang while open', async () => {
    renderLayer();
    void openIn(() => pickDialog(STATUSES));
    await userEvent.type(combobox(), 'zzz');
    expect(screen.getByRole('combobox', { name: '검색' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '닫기' })).toBeTruthy();
    act(() => setLang('en'));
    expect(screen.getByRole('combobox', { name: 'Search' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByText('No matches.')).toBeTruthy();
    expect((combobox() as HTMLInputElement).value).toBe('zzz'); // 다시 마운트되지 않았다
  });

  it('no element has a style attribute', async () => {
    renderLayer();
    void openIn(() => pickDialog(STATUSES, { selected: 'completed' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(styleAttributes()).toEqual([]);
    cleanupDialogs();
    void openIn(() => pickManyDialog(STATUSES));
    expect(styleAttributes()).toEqual([]);
  });
});
