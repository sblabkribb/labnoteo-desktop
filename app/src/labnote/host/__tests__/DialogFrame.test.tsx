// @vitest-environment jsdom
/**
 * DialogFrame: Tab 가두기는 숨은 쪽(설정 창의 hidden 페이지)을 건너뛰고, 대화상자는 늘 이름이 있다(제목, label, 또는 설명).
 * DialogLayer: 대화상자가 열려 있는 동안 #pet-layer 는 inert, 알림 층은 inert 가 아니다(live region 이 살아 있어야 한다).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { DialogFrame } from '../DialogFrame';
import { DialogLayer } from '../DialogLayer';
import { Toaster } from '../Toaster';
import { closeAllDialogs, confirmDialog } from '../dialogStore';
import { clearToasts, notify } from '../toastStore';
import { openIn } from './harness';

afterEach(() => {
  act(() => closeAllDialogs());
  act(() => clearToasts());
  cleanup();
  vi.restoreAllMocks();
});

function PagedDialog() {
  return (
    <DialogFrame title="설정" onCancel={() => {}}>
      <section>
        <button type="button">first page A</button>
        <button type="button">first page B</button>
      </section>
      <section hidden>
        <button type="button">hidden page</button>
      </section>
    </DialogFrame>
  );
}

describe('DialogFrame when focus has fallen to the page (Task 22: a control that turned disabled drops focus to <body>)', () => {
  it('Escape still cancels the top dialog and Tab brings focus back into it; a dialog underneath is left alone', async () => {
    const under = vi.fn();
    const top = vi.fn();
    render(
      <>
        <DialogFrame title="아래" onCancel={under}>
          <button type="button">under</button>
        </DialogFrame>
        <DialogFrame title="위" onCancel={top}>
          <button type="button">first</button>
          <button type="button">last</button>
        </DialogFrame>
      </>,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await userEvent.keyboard('{Tab}');
    // The first control of the top dialog is its close button.
    expect(screen.getByRole('dialog', { name: '위' }).contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '위' }).querySelector('.dialog-close'));
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'last' }));
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Escape}');
    expect(top).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });

  it('does nothing while focus is somewhere else (the dialog handles its own keys)', async () => {
    const cancel = vi.fn();
    render(
      <DialogFrame title="대화" onCancel={cancel}>
        <button type="button">inside</button>
      </DialogFrame>,
    );
    screen.getByRole('button', { name: 'inside' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('DialogFrame Tab trap', () => {
  it('Tab from the last visible control wraps to the first visible one, skipping hidden pages', async () => {
    render(<PagedDialog />);
    const dialog = screen.getByRole('dialog', { name: '설정' });
    const close = dialog.querySelector<HTMLButtonElement>('.dialog-close')!;
    const last = screen.getByRole('button', { name: 'first page B' });
    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(close);
  });

  it('Shift+Tab from the first visible control wraps to the last visible one', async () => {
    render(<PagedDialog />);
    const close = document.querySelector<HTMLButtonElement>('.dialog-close')!;
    close.focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first page B' }));
  });
});

describe('DialogFrame accessible name', () => {
  it('uses label as aria-label when there is no title', () => {
    render(
      <DialogFrame label="고르기" onCancel={() => {}}>
        <button type="button">x</button>
      </DialogFrame>,
    );
    expect(screen.getByRole('dialog', { name: '고르기' })).toBeTruthy();
  });

  it('without title or label, the described-by element names it', () => {
    render(
      <DialogFrame role="alertdialog" describedBy="msg" onCancel={() => {}}>
        <p id="msg">지울까요?</p>
      </DialogFrame>,
    );
    expect(screen.getByRole('alertdialog', { name: '지울까요?' })).toBeTruthy();
  });

  it('warns in dev for an unnamed dialog, not for named ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<DialogFrame title="이름" onCancel={() => {}}>{null}</DialogFrame>);
    render(<DialogFrame label="이름" onCancel={() => {}}>{null}</DialogFrame>);
    render(
      <DialogFrame describedBy="d" onCancel={() => {}}>
        <p id="d">설명</p>
      </DialogFrame>,
    );
    expect(warn).not.toHaveBeenCalled();
    render(<DialogFrame onCancel={() => {}}>{null}</DialogFrame>);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

function AppLike() {
  const shell = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="shell" ref={shell}>
        <button type="button">outside</button>
      </div>
      <DialogLayer blockRef={shell} />
      <Toaster />
      <div id="pet-layer">
        <button type="button">pet</button>
      </div>
    </>
  );
}

describe('DialogLayer and the pet layer', () => {
  it('#pet-layer is inert while a dialog is open and loses inert before focus returns into it', async () => {
    render(<AppLike />);
    const layer = document.getElementById('pet-layer')!;
    const pet = screen.getByRole('button', { name: 'pet' });
    pet.focus();
    let inertAtFocus: boolean | undefined;
    pet.addEventListener('focus', () => (inertAtFocus = layer.hasAttribute('inert')));
    const p = openIn(() => confirmDialog('?'));
    expect(layer.hasAttribute('inert')).toBe(true);
    await userEvent.keyboard('{Escape}');
    await expect(p).resolves.toBe(false);
    expect(layer.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(pet);
    expect(inertAtFocus).toBe(false);
  });

  it('the toaster is never inert and a toast raised under a dialog is in a live region', () => {
    render(<AppLike />);
    const p = openIn(() => confirmDialog('?'));
    act(() => notify('info', '저장했습니다.'));
    const toaster = document.querySelector('.toaster')!;
    expect(toaster.closest('[inert]')).toBeNull();
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('저장했습니다.');
    expect(status.closest('[inert]')).toBeNull();
    act(() => closeAllDialogs());
    void p;
  });
});
