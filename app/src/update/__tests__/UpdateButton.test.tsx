// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateButton, TOASTED_KEY, resetUpdateButtonForTest } from '../UpdateButton';
import { resetUpdateStoreForTest, setUpdateStateForTest, updateState, type PendingUpdate, type UpdateState } from '../updateStore';
import { setLang } from '../../i18n/lang';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => {}) }));

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

function fakeUpdate(version = '0.2.0'): PendingUpdate & { install: ReturnType<typeof vi.fn> } {
  return { version, download: vi.fn(async () => {}), install: vi.fn(async () => {}) };
}

beforeEach(() => {
  resetUpdateStoreForTest();
  resetUpdateButtonForTest();
  vi.stubGlobal('localStorage', memoryStorage());
  setLang('ko');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLang('ko');
});

const pill = () => document.querySelector('.update-pill') as HTMLButtonElement | null;

describe('왼쪽 아래 업데이트 버튼', () => {
  it.each<UpdateState>([
    { kind: 'idle' },
    { kind: 'checking', manual: false },
    { kind: 'upToDate', manual: true },
    { kind: 'failed', manual: true },
  ])('%o 에서는 아무것도 그리지 않는다', (s) => {
    setUpdateStateForTest(s);
    const { container } = render(<UpdateButton flushAll={async () => true} toast={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('받는 중(크기 앎): 퍼센트를 보이고 CSSOM 으로만 --update-progress 를 정한다', () => {
    const set = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    setUpdateStateForTest({ kind: 'downloading', version: '0.2.0', received: 42, total: 100 });
    render(<UpdateButton flushAll={async () => true} toast={vi.fn()} />);
    expect(pill()!.textContent).toBe('업데이트 받는 중 42%');
    expect(pill()!.getAttribute('aria-disabled')).toBe('true');
    expect(set).toHaveBeenCalledWith('--update-progress', '42%');
    expect(pill()!.style.getPropertyValue('--update-progress')).toBe('42%');
    set.mockRestore();
    // React 가 쓰는 마크업에는 style 속성이 없다 (CSP style-src 'self')
    expect(renderToStaticMarkup(<UpdateButton flushAll={async () => true} toast={vi.fn()} />)).not.toMatch(/style=/);
  });

  it('받는 중(크기 모름): 퍼센트 없는 글과 정해지지 않은 막대', () => {
    setUpdateStateForTest({ kind: 'downloading', version: '0.2.0', received: 42 });
    render(<UpdateButton flushAll={async () => true} toast={vi.fn()} />);
    expect(pill()!.textContent).toBe('업데이트 받는 중');
    expect(pill()!.dataset.state).toBe('indeterminate');
  });

  it('영어로는 Downloading update 42%', () => {
    setLang('en');
    setUpdateStateForTest({ kind: 'downloading', version: '0.2.0', received: 420, total: 1000 });
    render(<UpdateButton flushAll={async () => true} toast={vi.fn()} />);
    expect(pill()!.textContent).toBe('Downloading update 42%');
  });

  it('받는 중에 눌러도 아무 일도 없다', async () => {
    const u = fakeUpdate();
    setUpdateStateForTest({ kind: 'downloading', version: '0.2.0', received: 1, total: 2 }, u);
    const flushAll = vi.fn(async () => true);
    render(<UpdateButton flushAll={flushAll} toast={vi.fn()} />);
    await userEvent.click(pill()!);
    expect(flushAll).not.toHaveBeenCalled();
    expect(updateState().kind).toBe('downloading');
  });

  it('다 받으면 "업데이트": 알림 영역 안의 글과 버전이 든 툴팁. 누르면 저장한 뒤 설치한다', async () => {
    const order: string[] = [];
    const u = fakeUpdate();
    u.install.mockImplementation(async () => void order.push('install'));
    setUpdateStateForTest({ kind: 'ready', version: '0.2.0' }, u);
    render(
      <UpdateButton
        flushAll={async () => {
          order.push('flush');
          return true;
        }}
        toast={vi.fn()}
      />,
    );
    const b = screen.getByRole('button', { name: '업데이트' });
    expect(b.title).toBe('눌러서 새 버전 0.2.0 적용 (열린 노트는 먼저 저장해요)');
    expect(b.querySelector('[aria-live="polite"]')!.textContent).toBe('업데이트');
    await userEvent.click(b);
    await vi.waitFor(() => expect(order).toEqual(['flush', 'install']));
  });

  it('받는 중에는 알림 영역이 비어 있다 (퍼센트마다 읽지 않는다)', () => {
    setUpdateStateForTest({ kind: 'downloading', version: '0.2.0', received: 1, total: 2 });
    render(<UpdateButton flushAll={async () => true} toast={vi.fn()} />);
    expect(pill()!.querySelector('[aria-live="polite"]')!.textContent).toBe('');
  });

  it('설치 중에는 "업데이트 중…" 과 도는 아이콘, 누를 수 없다', () => {
    setUpdateStateForTest({ kind: 'installing', version: '0.2.0' });
    render(<UpdateButton flushAll={async () => true} toast={vi.fn()} />);
    expect(pill()!.textContent).toBe('업데이트 중…');
    expect(pill()!.getAttribute('aria-disabled')).toBe('true');
    expect(pill()!.querySelector('.icon.spin')).not.toBeNull();
  });

  it('저장하지 못한 노트가 있으면 설치하지 않고 알린 뒤 다시 "업데이트"', async () => {
    const u = fakeUpdate();
    setUpdateStateForTest({ kind: 'ready', version: '0.2.0' }, u);
    const toast = vi.fn();
    render(<UpdateButton flushAll={async () => false} toast={toast} />);
    await userEvent.click(screen.getByRole('button', { name: '업데이트' }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('warn', '저장하지 못한 노트가 있어요. 저장한 뒤 다시 눌러 주세요.'));
    expect(u.install).not.toHaveBeenCalled();
    expect(updateState().kind).toBe('ready');
    expect(pill()!.textContent).toBe('업데이트');
  });

  it('저장이 throw 해도 설치하지 않고 알린다', async () => {
    const u = fakeUpdate();
    setUpdateStateForTest({ kind: 'ready', version: '0.2.0' }, u);
    const toast = vi.fn();
    render(
      <UpdateButton
        flushAll={async () => {
          throw new Error('disk');
        }}
        toast={toast}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '업데이트' }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('warn', expect.stringContaining('저장하지 못한')));
    expect(u.install).not.toHaveBeenCalled();
  });

  it('받기 실패: "업데이트 다시 시도" 와 이유 툴팁, 누르면 다시 받는다', async () => {
    const u = fakeUpdate();
    setUpdateStateForTest({ kind: 'downloadFailed', version: '0.2.0', attempts: 3 }, u);
    render(<UpdateButton flushAll={async () => true} toast={vi.fn()} />);
    const b = screen.getByRole('button', { name: '업데이트 다시 시도' });
    expect(b.title).toBe('업데이트를 받지 못했어요. 눌러서 다시 시도해요.');
    await userEvent.click(b);
    expect(u.download).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(updateState().kind).toBe('ready'));
  });

  it('설치 실패: 다른 툴팁, 누르면 저장부터 다시 한다', async () => {
    const u = fakeUpdate();
    setUpdateStateForTest({ kind: 'installFailed', version: '0.2.0' }, u);
    const flushAll = vi.fn(async () => true);
    render(<UpdateButton flushAll={flushAll} toast={vi.fn()} />);
    const b = screen.getByRole('button', { name: '업데이트 다시 시도' });
    expect(b.title).toBe('업데이트를 적용하지 못했어요. 눌러서 다시 시도해요.');
    expect(b.querySelector('.icon')).not.toBeNull();
    await userEvent.click(b);
    await vi.waitFor(() => expect(u.install).toHaveBeenCalledTimes(1));
    expect(flushAll).toHaveBeenCalledTimes(1);
  });

  it('어떤 버전이 처음 ready 가 되면 알림 한 번. 같은 버전은 다시 그려도(다시 켜도) 알리지 않는다', () => {
    const toast = vi.fn();
    setUpdateStateForTest({ kind: 'downloading', version: '0.2.0', received: 1, total: 2 });
    const first = render(<UpdateButton flushAll={async () => true} toast={toast} />);
    act(() => setUpdateStateForTest({ kind: 'ready', version: '0.2.0' }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('info', "새 버전 0.2.0을 받았어요. 왼쪽 아래 '업데이트'를 누르면 적용돼요.");
    // installing → ready (저장 실패) 로 돌아와도 다시 알리지 않는다
    act(() => setUpdateStateForTest({ kind: 'installing', version: '0.2.0' }));
    act(() => setUpdateStateForTest({ kind: 'ready', version: '0.2.0' }));
    expect(toast).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(localStorage.getItem(TOASTED_KEY)).toBe('0.2.0');
    render(<UpdateButton flushAll={async () => true} toast={toast} />);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('다시 켠 뒤에도 localStorage 에 적힌 버전이면 알리지 않고, 새 버전이면 알린다', () => {
    localStorage.setItem(TOASTED_KEY, '0.2.0');
    const toast = vi.fn();
    setUpdateStateForTest({ kind: 'ready', version: '0.2.0' });
    render(<UpdateButton flushAll={async () => true} toast={toast} />);
    expect(toast).not.toHaveBeenCalled();
    act(() => setUpdateStateForTest({ kind: 'ready', version: '0.3.0' }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('info', expect.stringContaining('0.3.0'));
  });

  it('localStorage 가 throw 해도 그리고 한 번 알린다', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    vi.stubGlobal('localStorage', broken);
    const toast = vi.fn();
    setUpdateStateForTest({ kind: 'ready', version: '0.4.0' });
    const r = render(<UpdateButton flushAll={async () => true} toast={toast} />);
    expect(pill()!.textContent).toBe('업데이트');
    expect(toast).toHaveBeenCalledTimes(1);
    r.rerender(<UpdateButton flushAll={async () => true} toast={toast} />);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('오류에는 알림을 띄우지 않는다', () => {
    const toast = vi.fn();
    setUpdateStateForTest({ kind: 'downloadFailed', version: '0.2.0', attempts: 3 });
    const r = render(<UpdateButton flushAll={async () => true} toast={toast} />);
    act(() => setUpdateStateForTest({ kind: 'installFailed', version: '0.2.0' }));
    r.unmount();
    expect(toast).not.toHaveBeenCalled();
  });
});
