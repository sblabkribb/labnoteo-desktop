// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { clearToasts, currentToasts } from '../labnote/host/toastStore';
import { registerOpenNote } from '../labnote/openNotes';
import type { EditorHandle } from '../editor/Editor';
import { samplesSync } from '../samples/sync';
import { resetUpdateButtonForTest } from '../update/UpdateButton';
import { resetUpdateStoreForTest, setUpdateStateForTest, updateState, type PendingUpdate } from '../update/updateStore';
import { installFakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

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

beforeEach(() => {
  resetUpdateStoreForTest();
  resetUpdateButtonForTest();
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openReady(): Promise<PendingUpdate & { install: ReturnType<typeof vi.fn> }> {
  installFakeVault({ 'Day 1.labnote.md': 'x' });
  render(<App />);
  await screen.findByText('fake-vault');
  // 시작 확인(가짜 플러그인: 새 버전 없음)이 끝난 뒤 다 받은 새 버전을 쥔다
  await vi.waitFor(() => expect(updateState().kind).toBe('upToDate'));
  const u = { version: '0.9.0', download: vi.fn(async () => {}), install: vi.fn(async () => {}) };
  act(() => setUpdateStateForTest({ kind: 'ready', version: '0.9.0' }, u));
  return u;
}

describe('App: 왼쪽 아래 업데이트 버튼', () => {
  it('배너는 없고, 버튼은 상태 줄의 첫 칸에 있다. 처음 받았을 때 알림 한 번', async () => {
    await openReady();
    const notices = document.querySelector('.notices')!;
    expect(notices.querySelector('aside')).toBeNull();
    expect(within(notices as HTMLElement).queryByRole('button')).toBeNull();
    const footer = document.querySelector('footer.statusbar')!;
    const pill = within(footer as HTMLElement).getByRole('button', { name: '업데이트' });
    const firstGroup = footer.querySelector('.statusbar-group')!;
    expect(firstGroup.firstElementChild).toBe(pill);
    expect(currentToasts().filter((x) => x.message.includes('0.9.0'))).toHaveLength(1);
  });

  it('열린 노트 하나라도 저장하지 못하면 설치하지 않는다', async () => {
    const u = await openReady();
    const bad = { busy: () => false, flush: vi.fn(async () => false) } as unknown as EditorHandle;
    const off = registerOpenNote('dirty.labnote.md', bad);
    await userEvent.click(screen.getByRole('button', { name: '업데이트' }));
    await vi.waitFor(() => expect(currentToasts().some((x) => x.message.startsWith('저장하지 못한 노트가 있어요'))).toBe(true));
    expect(bad.flush).toHaveBeenCalled();
    expect(u.install).not.toHaveBeenCalled();
    expect(updateState().kind).toBe('ready');
    off();
  });

  it('샘플 동기화 저장이 throw 하면 설치하지 않고, 모두 저장되면 설치한다', async () => {
    const u = await openReady();
    const spy = vi.spyOn(samplesSync, 'flush').mockRejectedValueOnce(new Error('sync'));
    await userEvent.click(screen.getByRole('button', { name: '업데이트' }));
    await vi.waitFor(() => expect(updateState().kind).toBe('ready'));
    await vi.waitFor(() => expect(currentToasts().some((x) => x.message.startsWith('저장하지 못한'))).toBe(true));
    expect(u.install).not.toHaveBeenCalled();
    spy.mockResolvedValue(undefined);
    await userEvent.click(screen.getByRole('button', { name: '업데이트' }));
    await vi.waitFor(() => expect(u.install).toHaveBeenCalledTimes(1));
  });
});
