// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeVault } from '../ChangeVault';

describe('보관함 바꾸기 단추', () => {
  it('저장한 뒤에 선택 화면으로 돌아간다', async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => (order.push('flush'), true));
    const onChange = vi.fn(() => order.push('change'));
    render(<ChangeVault flush={flush} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: '보관함 바꾸기' }));
    expect(order).toEqual(['flush', 'change']);
  });

  it('저장하지 못하면 떠나지 않는다: 편집이 사라지지 않게', async () => {
    const onChange = vi.fn();
    render(<ChangeVault flush={async () => false} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: '보관함 바꾸기' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
