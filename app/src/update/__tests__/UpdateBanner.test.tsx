// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner, type PendingUpdate } from '../UpdateBanner';
import { resetUpdateStoreForTest, setUpdateStateForTest, startUpdateChecks, updateState } from '../updateStore';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => {}) }));

beforeEach(() => resetUpdateStoreForTest());

/** 잠깐 쓰는 배너(Task 2 가 지운다): 다 받은 새 버전만 보이고, 누르면 저장한 뒤 설치한다. */
describe('업데이트 알림 (임시)', () => {
  it('새 버전이 없거나 확인이 실패하면 아무것도 보이지 않는다', async () => {
    const checks = [async () => null, async () => Promise.reject(new Error('offline'))];
    for (const check of checks) {
      resetUpdateStoreForTest();
      const { container, unmount } = render(<UpdateBanner beforeInstall={async () => true} />);
      let stop: () => void = () => {};
      await act(async () => {
        stop = startUpdateChecks({ check });
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(['upToDate', 'failed']).toContain(updateState().kind);
      expect(container.textContent).toBe('');
      stop();
      unmount();
    }
  });

  it('받는 중에는 보이지 않고, 다 받으면 보인다', async () => {
    let finish!: () => void;
    const update: PendingUpdate = {
      version: '0.3.0',
      download: vi.fn(() => new Promise<void>((r) => (finish = r))),
      install: vi.fn(async () => {}),
    };
    const { container } = render(<UpdateBanner beforeInstall={async () => true} />);
    let stop: () => void = () => {};
    await act(async () => {
      stop = startUpdateChecks({ check: async () => update });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(updateState().kind).toBe('downloading');
    expect(container.textContent).toBe('');
    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('새 버전 0.3.0 을(를) 쓸 수 있습니다.')).toBeTruthy();
    stop();
  });

  it('누르면 저장한 뒤 설치하고, 저장하지 못하면 설치하지 않는다', async () => {
    const order: string[] = [];
    const update: PendingUpdate = {
      version: '0.2.0',
      download: vi.fn(async () => {}),
      install: vi.fn(async () => void order.push('install')),
    };
    let saved = false;
    setUpdateStateForTest({ kind: 'ready', version: '0.2.0' }, update);
    render(
      <UpdateBanner
        beforeInstall={async () => {
          order.push('save');
          return saved;
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '지금 업데이트' }));
    await vi.waitFor(() => expect(updateState().kind).toBe('ready'));
    expect(update.install).not.toHaveBeenCalled();
    saved = true;
    await userEvent.click(screen.getByRole('button', { name: '지금 업데이트' }));
    await vi.waitFor(() => expect(order).toEqual(['save', 'save', 'install']));
  });
});
