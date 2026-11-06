// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VaultPicker } from '../VaultPicker';

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);

beforeEach(() => dialog.open.mockReset());

describe('보관함 선택 화면', () => {
  it('테스트 경로 문자열은 실제 백슬래시를 담고 있다', () => {
    expect('D:\\lab').toHaveLength(6);
    expect('D:\\lab'.charCodeAt(2)).toBe(92);
  });

  it('고른 폴더 경로를 onPick 으로 넘긴다', async () => {
    dialog.open.mockResolvedValue('D:\\lab');
    const onPick = vi.fn();
    render(<VaultPicker onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: '폴더 선택' }));
    expect(onPick).toHaveBeenCalledWith('D:\\lab');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('대화상자를 취소하면(문자열이 아닌 값) 아무 일도 없고 오류도 없다', async () => {
    const onPick = vi.fn();
    render(<VaultPicker onPick={onPick} />);
    for (const cancelled of [null, undefined, ['D:\\a', 'D:\\b']]) {
      dialog.open.mockResolvedValue(cancelled);
      await userEvent.click(screen.getByRole('button', { name: '폴더 선택' }));
    }
    expect(dialog.open).toHaveBeenCalledTimes(3);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('대화상자가 예외를 던지면 일반 오류 문구를 보이고 onPick 은 부르지 않는다', async () => {
    dialog.open.mockRejectedValue(new Error('boom'));
    const onPick = vi.fn();
    render(<VaultPicker onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: '폴더 선택' }));
    expect((await screen.findByRole('alert')).textContent).toBe('이 폴더를 열 수 없습니다. 폴더가 맞는지 확인해 주세요.');
    expect(onPick).not.toHaveBeenCalled();
    // 다시 시도하면 오류가 먼저 지워진다.
    dialog.open.mockResolvedValue(null);
    await userEvent.click(screen.getByRole('button', { name: '폴더 선택' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
