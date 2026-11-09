// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { choiceDialog } from '../dialogStore';
import { createAppHost } from '../createAppHost';
import type { AppFs } from '../../../fs/tauriLabnoteFs';
import { cleanupDialogs, openIn, renderLayer, styleAttributes } from './harness';

afterEach(() => cleanupDialogs());

const CHOICES = [
  { label: '바꾸기', value: 'convert' },
  { label: '나중에', value: 'later' },
  { label: '다시 묻지 않기', value: 'never' },
] as const;

describe('여러 단추 확인(choice)', () => {
  it('shows the title, the message paragraphs and one button per choice; a click resolves its value', async () => {
    renderLayer();
    const p = openIn(() => choiceDialog('첫 문단\n\n둘째 문단', CHOICES, { title: '예전 형식 노트' }));
    const dialog = screen.getByRole('alertdialog', { name: '예전 형식 노트' });
    expect([...dialog.querySelectorAll('p')].map((x) => x.textContent)).toEqual(['첫 문단', '둘째 문단']);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(['바꾸기', '나중에', '다시 묻지 않기']));
    // 첫 단추가 주 단추이고 초점을 받는다
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '바꾸기' }));
    expect(screen.getByRole('button', { name: '바꾸기' }).classList.contains('primary')).toBe(true);
    expect(styleAttributes()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: '다시 묻지 않기' }));
    await expect(p).resolves.toBe('never');
  });

  it('Escape or the close button resolves undefined', async () => {
    renderLayer();
    const a = openIn(() => choiceDialog('?', CHOICES));
    await userEvent.keyboard('{Escape}');
    await expect(a).resolves.toBeUndefined();
  });

  it('AppHost.choose goes through the dialog store', async () => {
    renderLayer();
    const host = createAppHost({ fs: {} as AppFs, editTarget: () => undefined, openFile: async () => undefined });
    const p = openIn(() => host.choose('본문', CHOICES, { title: '제목' }));
    await userEvent.click(screen.getByRole('button', { name: '나중에' }));
    await expect(p).resolves.toBe('later');
  });
});
