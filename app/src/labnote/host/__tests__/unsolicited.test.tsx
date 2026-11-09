// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import type { PickItem } from '@labnoteo/core';
import { t } from '../../../i18n/t';
import { choiceDialog, confirmDialog, currentDialog, pickDialog, settleDialog } from '../dialogStore';
import { createAppHost } from '../createAppHost';
import { UNSOLICITED_ARM_MS, unsolicitedHost, whenNotComposing } from '../whenNotComposing';
import type { AppFs } from '../../../fs/tauriLabnoteFs';
import { cleanupDialogs, openIn, renderLayer, settled } from './harness';

afterEach(() => {
  cleanupDialogs();
  vi.useRealTimers();
});

const isOpen = () => currentDialog() !== null;

/** 한글 조합 중인 척하는 뷰: composing 과 contentDOM 만 쓴다. */
function fakeView(composing: boolean) {
  return { composing, contentDOM: document.createElement('div') } as unknown as EditorView & { composing: boolean };
}

const ITEMS: PickItem<string>[] = [
  { label: 'first', value: 'first' },
  { label: 'second', value: 'second' },
];

describe('unsolicited dialogs (A9)', () => {
  it('UNSOLICITED_ARM_MS is 500', () => {
    expect(UNSOLICITED_ARM_MS).toBe(500);
  });

  it('an unsolicited confirm focuses Cancel and ignores Enter for 500 ms', async () => {
    vi.useFakeTimers();
    renderLayer();
    const p = openIn(() => confirmDialog('m', { unsolicited: true }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('dialog.cancel') }));
    const ok = screen.getByRole('button', { name: t('dialog.ok') });
    // 막은 키는 기본 동작(단추 누르기)을 막는다: fireEvent 는 preventDefault 되면 false 를 돌려준다
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Enter' })).toBe(false);
    act(() => vi.advanceTimersByTime(UNSOLICITED_ARM_MS - 1));
    expect(fireEvent.keyDown(ok, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(ok, { key: ' ' })).toBe(false);
    expect(isOpen()).toBe(true);
    act(() => vi.advanceTimersByTime(2));
    expect(fireEvent.keyDown(ok, { key: 'Enter' })).toBe(true);
    fireEvent.click(ok);
    await expect(p).resolves.toBe(true);
  });

  it('an unsolicited confirm still closes on Escape while armed', async () => {
    vi.useFakeTimers();
    renderLayer();
    const p = openIn(() => confirmDialog('m', { unsolicited: true }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await expect(p).resolves.toBe(false);
  });

  it('an unsolicited picker ignores Enter for 500 ms', async () => {
    vi.useFakeTimers();
    renderLayer();
    const p = openIn(() => pickDialog(ITEMS, { title: 'pick', unsolicited: true }));
    const state = settled(p);
    const box = screen.getByRole('combobox');
    act(() => vi.advanceTimersByTime(100));
    fireEvent.keyDown(box, { key: 'Enter' });
    await Promise.resolve();
    expect(state.done).toBe(false);
    expect(isOpen()).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.keyDown(box, { key: 'Enter' });
    await expect(p).resolves.toBe('first');
  });

  it('an unsolicited choice ignores Enter and Space for 500 ms', async () => {
    vi.useFakeTimers();
    renderLayer();
    const p = openIn(() =>
      choiceDialog('m', [{ label: 'yes', value: 'y' }, { label: 'no', value: 'n' }], { unsolicited: true }),
    );
    const yes = screen.getByRole('button', { name: 'yes' });
    expect(fireEvent.keyDown(yes, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(yes, { key: ' ' })).toBe(false);
    act(() => vi.advanceTimersByTime(UNSOLICITED_ARM_MS + 1));
    expect(fireEvent.keyDown(yes, { key: 'Enter' })).toBe(true);
    fireEvent.click(yes);
    await expect(p).resolves.toBe('y');
  });

  it('a plain confirm still focuses its confirm button', () => {
    renderLayer();
    void openIn(() => confirmDialog('m'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('dialog.ok') }));
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Enter' })).toBe(true);
  });

  it('a plain confirm is not danger-coloured when unsolicited', () => {
    renderLayer();
    void openIn(() => confirmDialog('m', { unsolicited: true }));
    expect(screen.getByRole('button', { name: t('dialog.ok') }).classList.contains('danger')).toBe(false);
  });
});

describe('whenNotComposing', () => {
  it('resolves at once when there is no view or it is not composing', async () => {
    await expect(whenNotComposing(() => undefined)).resolves.toBeUndefined();
    await expect(whenNotComposing(() => fakeView(false))).resolves.toBeUndefined();
  });

  it('waits for compositionend while the view is composing', async () => {
    const view = fakeView(true);
    const state = settled(whenNotComposing(() => view));
    await Promise.resolve();
    expect(state.done).toBe(false);
    // 아직 조합 중인데 compositionend 가 오면(다음 조합이 곧 시작) 다시 기다린다
    view.contentDOM.dispatchEvent(new Event('compositionend'));
    await Promise.resolve();
    expect(state.done).toBe(false);
    view.composing = false;
    view.contentDOM.dispatchEvent(new Event('compositionend'));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.done).toBe(true);
  });
});

describe('unsolicitedHost', () => {
  const fs = {} as AppFs;
  const base = () => createAppHost({ fs, editTarget: () => undefined, openFile: async () => undefined });

  it('confirm, pick and choose wait for composition to end, then open with unsolicited: true', async () => {
    renderLayer();
    const view = fakeView(true);
    const host = unsolicitedHost(base(), () => view);
    const answers = [
      host.confirm('c?'),
      host.pick(ITEMS, { title: 'p' }),
      host.choose('ch?', [{ label: 'a', value: 'a' }]),
    ];
    await Promise.resolve();
    expect(isOpen()).toBe(false);
    view.composing = false;
    act(() => {
      view.contentDOM.dispatchEvent(new Event('compositionend'));
    });
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    const kinds: string[] = [];
    while (currentDialog()) {
      const spec = currentDialog()!.spec as { kind: string; unsolicited?: boolean };
      expect(spec.unsolicited).toBe(true);
      kinds.push(spec.kind);
      const entry = currentDialog()!;
      act(() => settleDialog(entry.id, entry.cancelValue));
    }
    expect(kinds.sort()).toEqual(['choice', 'confirm', 'pick']);
    await Promise.all(answers);
  });

  it('keeps the rest of the host', () => {
    const plain = base();
    const host = unsolicitedHost(plain, () => undefined);
    expect(host.fs).toBe(plain.fs);
    expect(host.t).toBe(plain.t);
  });
});
