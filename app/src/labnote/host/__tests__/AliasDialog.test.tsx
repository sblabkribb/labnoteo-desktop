// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../../i18n/lang';
import { aliasDialog } from '../dialogStore';
import { cleanupDialogs, openIn, renderLayer, settled, styleAttributes } from './harness';

afterEach(() => {
  cleanupDialogs();
  setLang('ko');
});

const box = () => screen.getByRole('textbox') as HTMLInputElement;
const base = { id: 'WT010', catalogName: 'Nucleotide Sequencing', title: '워크플로 생성' };

describe('별칭 대화상자', () => {
  it("alias shows the [id name] prefix and returns '' for an empty submit, undefined on Escape", async () => {
    renderLayer();
    const a = openIn(() => aliasDialog({ ...base, about: '워크플로란', description: '염기서열 분석', placeholder: '별칭' }));
    expect(screen.getByRole('dialog', { name: '워크플로 생성' })).toBeTruthy();
    expect(document.querySelector('.alias-prefix')?.textContent).toBe('[WT010 Nucleotide Sequencing]');
    expect(document.querySelector('.alias-about')?.textContent).toBe('워크플로란');
    expect(document.querySelector('.alias-description')?.textContent).toBe('염기서열 분석');
    expect(box().placeholder).toBe('별칭');
    expect(box().getAttribute('aria-label')).toContain('[WT010 Nucleotide Sequencing]');
    expect(document.activeElement).toBe(box());
    await userEvent.keyboard('{Enter}');
    await expect(a).resolves.toBe('');

    const b = openIn(() => aliasDialog(base));
    await userEvent.type(box(), '샘플A');
    await userEvent.keyboard('{Escape}');
    await expect(b).resolves.toBeUndefined();
  });

  it('the initial value is selected, so typing replaces it', async () => {
    renderLayer();
    const p = openIn(() => aliasDialog({ ...base, value: '이전' }));
    expect(box().value).toBe('이전');
    expect(box().selectionStart).toBe(0);
    expect(box().selectionEnd).toBe(2);
    fireEvent.change(box(), { target: { value: '새 이름' } });
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await expect(p).resolves.toBe('새 이름');
  });

  it('alias Enter during IME composition does not submit', async () => {
    renderLayer();
    const p = openIn(() => aliasDialog(base));
    const state = settled(p);
    fireEvent.change(box(), { target: { value: '시료 준' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    await act(async () => {});
    expect(state.done).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(box(), { target: { value: '시료 준비' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await expect(p).resolves.toBe('시료 준비');
  });

  it('validate blocks the submit and shows its message; the hint follows every input with warn', async () => {
    renderLayer();
    const p = openIn(() =>
      aliasDialog({
        ...base,
        validate: (v) => (v === 'dup' ? '같은 별칭이 있습니다.' : null),
        hint: (v) => (v.length > 3 ? { text: `${v.length}자: 깁니다`, warn: true } : { text: `${v.length}자` }),
      }),
    );
    const hint = () => document.querySelector('.alias .prompt-hint') as HTMLElement;
    expect(hint().textContent).toBe('0자');
    await userEvent.type(box(), 'dup{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('같은 별칭이 있습니다.');
    expect(box().getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(box(), 'e');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(hint().textContent).toBe('4자: 깁니다');
    expect(hint().classList.contains('warn')).toBe(true);
    await userEvent.keyboard('{Enter}');
    await expect(p).resolves.toBe('dupe');
  });

  it('labels change with setLang while open', () => {
    renderLayer();
    void openIn(() => aliasDialog(base));
    act(() => setLang('en'));
    expect(screen.getByRole('button', { name: 'OK' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(box().getAttribute('aria-label')).toBe('Name after [WT010 Nucleotide Sequencing]');
  });

  it('no element has a style attribute', async () => {
    renderLayer();
    void openIn(() =>
      aliasDialog({ ...base, about: 'a', description: 'd', hint: () => ({ text: 'h', warn: true }), validate: () => 'bad' }),
    );
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(styleAttributes()).toEqual([]);
  });
});
