// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../../i18n/lang';
import { confirmDialog, pickDialog, useDialogOpen } from '../dialogStore';
import { renderHook } from '@testing-library/react';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from './harness';

afterEach(() => cleanupDialogs());

describe('확인 대화상자', () => {
  it('확인 단추는 true, 취소는 false. 확인 단추 이름은 confirmLabel, 없으면 "확인"', async () => {
    renderLayer();
    const a = openIn(() => confirmDialog('넣을까요?', { confirmLabel: '넣기' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    // 위험하지 않은 확인은 확인 단추에 초점: Enter 가 확인한다
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '넣기' }));
    await userEvent.keyboard('{Enter}');
    await expect(a).resolves.toBe(true);
    const b = openIn(() => confirmDialog('넣을까요?'));
    expect(screen.getByRole('button', { name: '확인' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '취소' }));
    await expect(b).resolves.toBe(false);
  });

  it('destructive confirm: Enter cancels', async () => {
    renderLayer();
    const p = openIn(() => confirmDialog('휴지통으로 옮길까요?', { confirmLabel: '삭제', destructive: true }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByRole('button', { name: '삭제' }).classList.contains('danger')).toBe(true);
    await userEvent.keyboard('{Enter}');
    await expect(p).resolves.toBe(false);
  });

  it('has an accessible name (and the message as its description)', () => {
    renderLayer();
    void openIn(() => confirmDialog('지울까요?', { destructive: true }));
    const dialog = screen.getByRole('alertdialog', { name: '확인 요청' });
    const described = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(described?.textContent).toBe('지울까요?');
    act(() => setLang('en'));
    expect(screen.getByRole('alertdialog', { name: 'Please confirm' })).toBeTruthy();
    act(() => setLang('ko'));
  });

  it('Escape 는 false', async () => {
    renderLayer();
    const p = openIn(() => confirmDialog('?'));
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBe(false);
  });

  it('aborting the signal closes the confirm and resolves false', async () => {
    renderLayer();
    const ac = new AbortController();
    const p = openIn(() => confirmDialog('아직 유효한가?', { signal: ac.signal }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    act(() => ac.abort());
    await expect(p).resolves.toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('빈 줄로 나뉜 문단은 따로 된 <p> 이고, 글자는 HTML 로 읽지 않는다', () => {
    renderLayer();
    void openIn(() => confirmDialog('첫 문단\n둘째 줄\n\n<b>둘째</b> 문단'));
    const ps = [...screen.getByRole('alertdialog').querySelectorAll('p')];
    expect(ps.map((p) => p.textContent)).toEqual(['첫 문단\n둘째 줄', '<b>둘째</b> 문단']);
    expect(screen.getByRole('alertdialog').querySelector('b')).toBeNull();
  });

  it('two dialogs queue in order', async () => {
    renderLayer();
    const a = openIn(() => confirmDialog('첫째'));
    const b = openIn(() => pickDialog([{ label: '둘째 항목', value: 2 }], { title: '둘째' }));
    expect(screen.getByText('첫째')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '둘째' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await expect(a).resolves.toBe(true);
    expect(screen.getByRole('dialog', { name: '둘째' })).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    await expect(b).resolves.toBe(2);
  });

  it('while a dialog is open .shell is inert, and Tab from the last button returns to the first', async () => {
    const { shell, outside } = renderLayer();
    const open = renderHook(() => useDialogOpen());
    outside.focus();
    expect(open.result.current).toBe(false);
    const p = openIn(() => confirmDialog('?'));
    expect(open.result.current).toBe(true);
    expect(shell.hasAttribute('inert')).toBe(true);
    const dialog = screen.getByRole('alertdialog');
    const buttons = [...dialog.querySelectorAll('button')];
    buttons[buttons.length - 1].focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(buttons[0]);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    // 대화상자를 닫으면 inert 가 풀리고 초점은 열기 전 자리로 돌아간다
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBe(false);
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(open.result.current).toBe(false);
  });

  it('줄을 이어 연 두 대화상자 사이에는 inert 가 풀리지 않고, 마지막이 닫히면 처음 자리로 돌아간다', async () => {
    const { shell, outside } = renderLayer();
    outside.focus();
    const a = openIn(() => confirmDialog('A'));
    const b = openIn(() => confirmDialog('B'));
    await userEvent.keyboard('{Escape}');
    await expect(a).resolves.toBe(false);
    expect(shell.hasAttribute('inert')).toBe(true);
    expect(screen.getByText('B')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await expect(b).resolves.toBe(false);
    expect(shell.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it('초점은 그림자 루트 안(편집기)으로도 돌아간다', async () => {
    const { shell } = renderLayer();
    const host = document.createElement('div');
    shell.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.tabIndex = 0;
    root.appendChild(inner);
    inner.focus();
    expect(root.activeElement).toBe(inner);
    const p = openIn(() => confirmDialog('?'));
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBe(false);
    expect(root.activeElement).toBe(inner);
  });

  it('labels change with setLang while open', () => {
    renderLayer();
    void openIn(() => confirmDialog('?'));
    act(() => setLang('en'));
    expect(screen.getByRole('button', { name: 'OK' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('no element has a style attribute', () => {
    renderLayer();
    void openIn(() => confirmDialog('a\n\nb', { destructive: true }));
    expect(styleAttributes()).toEqual([]);
  });
});
