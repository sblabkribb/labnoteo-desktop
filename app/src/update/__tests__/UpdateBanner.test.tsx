// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner, type PendingUpdate } from '../UpdateBanner';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));

function setup(over: { saved?: boolean } = {}) {
  const order: string[] = [];
  const update: PendingUpdate = {
    version: '0.2.0',
    download: vi.fn(async () => void order.push('download')),
    install: vi.fn(async () => void order.push('install')),
  };
  const beforeInstall = vi.fn(async () => {
    order.push('save');
    return over.saved ?? true;
  });
  const restart = vi.fn(async () => void order.push('restart'));
  render(<UpdateBanner beforeInstall={beforeInstall} checkForUpdate={async () => update} restart={restart} />);
  return { order, update, restart };
}

describe('업데이트 알림', () => {
  it('새 버전이 없거나 확인이 실패하면 아무것도 보이지 않는다', async () => {
    const checks = [async () => null, async () => Promise.reject(new Error('offline'))];
    for (const checkForUpdate of checks) {
      const { container } = render(
        <UpdateBanner beforeInstall={async () => true} checkForUpdate={checkForUpdate} restart={async () => {}} />,
      );
      await new Promise((r) => setTimeout(r, 0));
      expect(container.textContent).toBe('');
    }
  });

  it('새 버전이 있으면 알리고, 누르기 전에는 설치하지 않는다', async () => {
    const s = setup();
    expect(await screen.findByText('새 버전 0.2.0 을(를) 쓸 수 있습니다.')).toBeTruthy();
    expect(s.update.install).not.toHaveBeenCalled();
  });

  it('누르면 내려받고, 편집을 저장한 뒤 설치하고 다시 시작한다', async () => {
    const s = setup();
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    await vi.waitFor(() => expect(s.order).toEqual(['download', 'save', 'install', 'restart']));
  });

  it('저장하지 못하면 설치하지 않고 알린다', async () => {
    const s = setup({ saved: false });
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    expect((await screen.findByRole('alert')).textContent).toContain('저장하지 못한 편집');
    expect(s.update.install).not.toHaveBeenCalled();
    expect(s.restart).not.toHaveBeenCalled();
  });

  it('설치가 실패하면 오류를 보이고 다시 시작하지 않는다', async () => {
    const s = setup();
    (s.update.download as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bad signature'));
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    expect((await screen.findByRole('alert')).textContent).toContain('업데이트하지 못했습니다');
    expect(s.restart).not.toHaveBeenCalled();
  });
});
