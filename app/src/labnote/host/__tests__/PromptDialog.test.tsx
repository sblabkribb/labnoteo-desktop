// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../../i18n/lang';
import { promptDialog } from '../dialogStore';
import { cleanupDialogs, openIn, renderLayer, settled, styleAttributes } from './harness';

afterEach(() => cleanupDialogs());

const box = () => screen.getByRole('textbox') as HTMLInputElement;

describe('입력 대화상자', () => {
  it('제목·질문·채운 값으로 열리고, 입력 칸에 초점이 가며, Enter 로 값을 돌려준다', async () => {
    renderLayer();
    const p = openIn(() => promptDialog({ title: '실험 생성', prompt: '실험 제목', value: '초안', placeholder: '제목' }));
    expect(screen.getByRole('dialog', { name: '실험 생성' })).toBeTruthy();
    expect(screen.getByText('실험 제목')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '실험 제목' })).toBe(box());
    expect(box().value).toBe('초안');
    expect(box().placeholder).toBe('제목');
    expect(document.activeElement).toBe(box());
    await userEvent.type(box(), ' 2{Enter}');
    await expect(p).resolves.toBe('초안 2');
  });

  it('질문이 없으면 입력 칸 이름은 "입력"', () => {
    renderLayer();
    void openIn(() => promptDialog({}));
    expect(screen.getByRole('textbox', { name: '입력' })).toBeTruthy();
  });

  it('Enter during IME composition does not submit', async () => {
    renderLayer();
    const p = openIn(() => promptDialog({ title: '실험 생성' }));
    const state = settled(p);
    fireEvent.change(box(), { target: { value: '세포 배' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    await act(async () => {});
    expect(state.done).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(box(), { target: { value: '세포 배양' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await expect(p).resolves.toBe('세포 배양');
  });

  it('Escape 와 취소 단추는 undefined', async () => {
    renderLayer();
    const a = openIn(() => promptDialog({}));
    await userEvent.keyboard('{Escape}');
    await expect(a).resolves.toBeUndefined();
    const b = openIn(() => promptDialog({}));
    await userEvent.click(screen.getByRole('button', { name: '취소' }));
    await expect(b).resolves.toBeUndefined();
  });

  it('동기 validate 의 메시지는 보이고 제출을 막으며, 입력을 바꾸면 사라진다', async () => {
    renderLayer();
    const p = openIn(() => promptDialog({ validate: (v) => (v.trim() ? null : '제목을 적어 주세요.') }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('제목을 적어 주세요.');
    expect(box().getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(box(), 'a');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await expect(p).resolves.toBe('a');
  });

  it('async validate blocks submit until it resolves null', async () => {
    renderLayer();
    let release!: (msg: string | null) => void;
    const validate = vi.fn(() => new Promise<string | null>((r) => (release = r)));
    const p = openIn(() => promptDialog({ validate }));
    const state = settled(p);
    await userEvent.type(box(), 'dup{Enter}');
    expect(validate).toHaveBeenCalledWith('dup');
    // 검사가 끝나기 전에는 닫히지 않는다. 그동안 Enter 를 또 쳐도 두 번 검사하지 않는다.
    await userEvent.keyboard('{Enter}');
    expect(validate).toHaveBeenCalledTimes(1);
    expect(state.done).toBe(false);
    await act(async () => release('같은 이름이 있습니다.'));
    expect(screen.getByRole('alert').textContent).toBe('같은 이름이 있습니다.');
    expect(state.done).toBe(false);
    await userEvent.type(box(), '2{Enter}');
    expect(validate).toHaveBeenLastCalledWith('dup2');
    await act(async () => release(null));
    await expect(p).resolves.toBe('dup2');
  });

  it('hint warn adds the warn class, and the hint follows every input', async () => {
    renderLayer();
    void openIn(() =>
      promptDialog({ hint: (v) => (v.length > 3 ? { text: `${v.length}자: 너무 깁니다`, warn: true } : { text: `${v.length}자` }) }),
    );
    const hint = () => document.querySelector('.prompt-hint') as HTMLElement;
    expect(hint().textContent).toBe('0자');
    expect(hint().classList.contains('warn')).toBe(false);
    await userEvent.type(box(), 'abcd');
    expect(hint().textContent).toBe('4자: 너무 깁니다');
    expect(hint().classList.contains('warn')).toBe(true);
    expect(box().getAttribute('aria-describedby')).toContain(hint().id);
  });

  it('labels change with setLang while open', async () => {
    renderLayer();
    void openIn(() => promptDialog({}));
    await userEvent.type(box(), '반쯤');
    act(() => setLang('en'));
    expect(screen.getByRole('textbox', { name: 'Input' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'OK' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(box().value).toBe('반쯤');
  });

  it('no element has a style attribute', async () => {
    renderLayer();
    void openIn(() => promptDialog({ title: 'x', prompt: 'y', hint: () => ({ text: 'h', warn: true }), validate: () => 'bad' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(styleAttributes()).toEqual([]);
  });
});
