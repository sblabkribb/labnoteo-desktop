// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner, type PendingUpdate } from '../UpdateBanner';
import { resetUpdateStoreForTest, setUpdateStateForTest, startUpdateChecks, updateState } from '../updateStore';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));

beforeEach(() => resetUpdateStoreForTest());

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
  setUpdateStateForTest({ kind: 'available', update, dismissed: false });
  const r = render(<UpdateBanner beforeInstall={beforeInstall} restart={restart} />);
  return { order, update, restart, ...r };
}

describe('업데이트 알림', () => {
  it('새 버전이 없거나 확인이 실패하면 아무것도 보이지 않는다', async () => {
    const checks = [async () => null, async () => Promise.reject(new Error('offline'))];
    for (const check of checks) {
      resetUpdateStoreForTest();
      const { container, unmount } = render(<UpdateBanner beforeInstall={async () => true} restart={async () => {}} />);
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

  it('주기 확인이 새 버전을 찾으면 알린다', async () => {
    const update: PendingUpdate = { version: '0.3.0', download: vi.fn(), install: vi.fn() };
    render(<UpdateBanner beforeInstall={async () => true} restart={async () => {}} />);
    let stop: () => void = () => {};
    await act(async () => {
      stop = startUpdateChecks({ check: async () => update });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('새 버전 0.3.0 을(를) 쓸 수 있습니다.')).toBeTruthy();
    stop();
  });

  it('새 버전이 있으면 알리고, 누르기 전에는 설치하지 않는다', async () => {
    const s = setup();
    expect(await screen.findByText('새 버전 0.2.0 을(를) 쓸 수 있습니다.')).toBeTruthy();
    expect(s.update.download).not.toHaveBeenCalled();
    expect(s.update.install).not.toHaveBeenCalled();
  });

  it('"나중에"를 누르면 알림을 감추고 내려받지 않는다', async () => {
    const s = setup();
    await userEvent.click(await screen.findByRole('button', { name: '나중에' }));
    expect(s.container.textContent).toBe('');
    expect(updateState()).toMatchObject({ kind: 'available', dismissed: true });
    expect(s.update.download).not.toHaveBeenCalled();
    expect(s.update.install).not.toHaveBeenCalled();
  });

  it('이미 "나중에"를 누른 버전은 보이지 않는다', () => {
    const update: PendingUpdate = { version: '0.2.0', download: vi.fn(), install: vi.fn() };
    setUpdateStateForTest({ kind: 'available', update, dismissed: true });
    const { container } = render(<UpdateBanner beforeInstall={async () => true} restart={async () => {}} />);
    expect(container.textContent).toBe('');
  });

  it('직접 확인하는 동안 확인 중이라고 보인다', () => {
    setUpdateStateForTest({ kind: 'checking', manual: true });
    render(<UpdateBanner beforeInstall={async () => true} restart={async () => {}} />);
    expect(screen.getByRole('status').textContent).toBe('업데이트를 확인하는 중…');
  });

  it('주기 확인 중에는 아무것도 보이지 않는다', () => {
    setUpdateStateForTest({ kind: 'checking', manual: false });
    const { container } = render(<UpdateBanner beforeInstall={async () => true} restart={async () => {}} />);
    expect(container.textContent).toBe('');
  });

  it('누르면 내려받고, 편집을 저장한 뒤 설치하고 다시 시작한다', async () => {
    const s = setup();
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    await vi.waitFor(() => expect(s.order).toEqual(['download', 'save', 'install', 'restart']));
  });

  it('설치하는 동안에는 "나중에"를 누를 수 없다', async () => {
    const s = setup();
    let release: () => void = () => {};
    (s.update.download as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((r) => (release = r)));
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    expect((screen.getByRole('button', { name: '나중에' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
  });

  it('저장하지 못하면 설치하지 않고 알린다', async () => {
    const s = setup({ saved: false });
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    expect((await screen.findByRole('alert')).textContent).toContain('저장하지 못한 편집');
    expect(s.update.install).not.toHaveBeenCalled();
    expect(s.restart).not.toHaveBeenCalled();
  });

  it('내려받기가 실패하면 저장도 설치도 하지 않고 오류를 보인다', async () => {
    const s = setup();
    (s.update.download as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bad signature'));
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    expect((await screen.findByRole('alert')).textContent).toContain('업데이트하지 못했습니다');
    expect(s.order).toEqual([]); // 내려받지 못했으니 저장도 설치도 시도하지 않았다
    expect(s.update.install).not.toHaveBeenCalled();
    expect(s.restart).not.toHaveBeenCalled();
  });

  it('설치가 실패하면 오류를 보이고 다시 시작하지 않는다', async () => {
    const s = setup();
    (s.update.install as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('installer failed'));
    await userEvent.click(await screen.findByRole('button', { name: '지금 업데이트' }));
    expect((await screen.findByRole('alert')).textContent).toContain('업데이트하지 못했습니다');
    expect(s.update.install).toHaveBeenCalledTimes(1); // 설치까지 갔다가 실패했다
    expect(s.order).toEqual(['download', 'save']); // 저장은 설치 전에 이미 끝났다
    expect(s.restart).not.toHaveBeenCalled();
  });
});
