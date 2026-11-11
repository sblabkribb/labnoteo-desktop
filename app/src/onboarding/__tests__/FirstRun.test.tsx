// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FirstRun } from '../FirstRun';
import { useVault, type VaultInfo } from '../../vault/useVault';
import { getLang, setLang } from '../../i18n/lang';

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);

const obsidian: VaultInfo = { root: 'D:\\obs', name: 'obs', hasObsidianConfig: true };
const fresh: VaultInfo = { root: 'D:\\새 보관함', name: '새 보관함', hasObsidianConfig: false };

/** 보낸 커맨드를 기록하는 가짜 invoke. 저장된 보관함은 없다. */
function fakeInvoke() {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (cmd === 'vault_current') return null;
    if (cmd === 'vault_create') return fresh;
    if (cmd === 'vault_open') return obsidian;
    throw new Error(`unexpected call ${cmd}`);
  };
  return { calls, invoke: invoke as never };
}

/** App 과 같은 연결: useVault 가 선택 화면 상태일 때 FirstRun 을 보인다. */
function Harness({ invoke }: { invoke: never }) {
  const { state, open, create } = useVault(invoke);
  if (state.status === 'loading') return <p>loading</p>;
  if (state.status === 'ready') return <p>ready:{state.vault.name}</p>;
  return <FirstRun error={state.error} onOpen={open} onCreate={create} />;
}

beforeEach(() => {
  dialog.open.mockReset();
  dialog.save.mockReset();
});

describe('첫 실행 화면', () => {
  it('테스트 경로 문자열은 실제 백슬래시를 담고 있다', () => {
    expect('D:\\obs'.charCodeAt(2)).toBe(92);
  });

  it('보관함이 없으면 첫 실행 화면을 보여준다', async () => {
    const f = fakeInvoke();
    render(<Harness invoke={f.invoke} />);
    expect(await screen.findByRole('heading', { name: '노트를 둘 곳을 정하세요' })).toBeTruthy();
    // 선택지는 둘뿐이다.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['새 보관함 만들기', '기존 폴더 열기']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(f.calls).toEqual([['vault_current', {}]]);
  });

  it('새 보관함 만들기를 고르면 폴더를 만들고 연다', async () => {
    dialog.save.mockResolvedValue('D:\\새 보관함');
    const f = fakeInvoke();
    render(<Harness invoke={f.invoke} />);
    await userEvent.click(await screen.findByRole('button', { name: '새 보관함 만들기' }));
    expect(await screen.findByText('ready:새 보관함')).toBeTruthy();
    expect(f.calls).toEqual([['vault_current', {}], ['vault_create', { path: 'D:\\새 보관함' }]]);
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('기존 Obsidian 보관함을 골라도 .obsidian 을 건드리지 않는다', async () => {
    dialog.open.mockResolvedValue('D:\\obs');
    const f = fakeInvoke();
    render(<Harness invoke={f.invoke} />);
    await userEvent.click(await screen.findByRole('button', { name: '기존 폴더 열기' }));
    expect(await screen.findByText('ready:obs')).toBeTruthy();
    // 열기만 한다: 만들기, 쓰기, 폴더 만들기, 지우기 커맨드는 하나도 가지 않는다.
    // (.obsidian 을 열지도 쓰지도 않는 것은 Rust 의 vault 테스트가 디스크에서 확인한다.)
    expect(f.calls).toEqual([['vault_current', {}], ['vault_open', { path: 'D:\\obs' }]]);
  });

  it('대화상자를 취소하면 아무 일도 없고 오류도 없다', async () => {
    const f = fakeInvoke();
    render(<Harness invoke={f.invoke} />);
    for (const cancelled of [null, undefined, '', ['D:\\a', 'D:\\b']]) {
      dialog.save.mockResolvedValue(cancelled);
      dialog.open.mockResolvedValue(cancelled);
      await userEvent.click(await screen.findByRole('button', { name: '새 보관함 만들기' }));
      await userEvent.click(screen.getByRole('button', { name: '기존 폴더 열기' }));
    }
    expect(dialog.save).toHaveBeenCalledTimes(4);
    expect(dialog.open).toHaveBeenCalledTimes(4);
    expect(f.calls).toEqual([['vault_current', {}]]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('대화상자가 예외를 던지면 일반 오류 문구를 보이고 아무것도 열지 않는다', async () => {
    dialog.open.mockRejectedValue(new Error('boom'));
    const f = fakeInvoke();
    render(<Harness invoke={f.invoke} />);
    await userEvent.click(await screen.findByRole('button', { name: '기존 폴더 열기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('이 폴더를 열 수 없습니다. 폴더가 맞는지 확인해 주세요.');
    expect(f.calls).toEqual([['vault_current', {}]]);
    // 다시 시도하면 오류가 먼저 지워진다.
    dialog.open.mockResolvedValue(null);
    await userEvent.click(screen.getByRole('button', { name: '기존 폴더 열기' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Rust 가 거부하면 선택 화면에 남고 오류를 보인다', async () => {
    dialog.save.mockResolvedValue('D:\\x');
    const calls: string[] = [];
    const invoke = (async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'vault_current') return null;
      throw { kind: 'io', message: 'denied' };
    }) as never;
    render(<Harness invoke={invoke} />);
    await userEvent.click(await screen.findByRole('button', { name: '새 보관함 만들기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('이 폴더를 열 수 없습니다. 폴더가 맞는지 확인해 주세요.');
    expect(screen.getByRole('button', { name: '기존 폴더 열기' })).toBeTruthy();
    expect(calls).toEqual(['vault_current', 'vault_create']);
  });

  // 첫 화면은 README 의 시작 GIF 에 그대로 찍힌다. README 는 다른 앱 이름을 말하지 않는다(두 언어 모두).
  it('첫 화면 글은 다른 앱 이름(Obsidian, .obsidian)을 말하지 않는다', async () => {
    const before = getLang();
    try {
      for (const lang of ['ko', 'en'] as const) {
        setLang(lang);
        const f = fakeInvoke();
        const view = render(<Harness invoke={f.invoke} />);
        await screen.findByRole('heading');
        expect(view.container.textContent, lang).not.toMatch(/obsidian/i);
        view.unmount();
      }
    } finally {
      setLang(before);
    }
  });
});
