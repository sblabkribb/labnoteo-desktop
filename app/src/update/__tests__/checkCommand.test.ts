// @vitest-environment jsdom
import { runCheckForUpdates } from '../checkCommand';
import type { UpdateState } from '../updateStore';
import type { CommandContext } from '../../labnote/commands/context';
import { setLang } from '../../i18n/lang';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.1.4') }));

function ctx() {
  const notify = vi.fn();
  return { ctx: { host: { notify } } as unknown as CommandContext, notify };
}

async function run(s: UpdateState) {
  const c = ctx();
  const out = await runCheckForUpdates(c.ctx, { check: async () => s, version: async () => '0.1.4' });
  expect(out).toEqual(s);
  return c.notify;
}

afterEach(() => setLang('ko'));

describe('업데이트 확인 명령', () => {
  it('최신이면 지금 버전을 알린다', async () => {
    setLang('ko');
    const notify = await run({ kind: 'upToDate', manual: true });
    expect(notify).toHaveBeenCalledWith('info', expect.stringContaining('0.1.4'));
  });

  it('확인이 실패하면 경고한다', async () => {
    const notify = await run({ kind: 'failed', manual: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('warn');
  });

  it('받는 중이면 이미 받고 있다고 알린다 (ko, en)', async () => {
    setLang('ko');
    let notify = await run({ kind: 'downloading', version: '0.2.0', received: 1 });
    expect(notify).toHaveBeenCalledWith('info', '새 버전 0.2.0을 이미 받고 있어요.');
    setLang('en');
    notify = await run({ kind: 'downloading', version: '0.2.0', received: 1, total: 9 });
    expect(notify).toHaveBeenCalledWith('info', 'Version 0.2.0 is already being downloaded.');
  });

  it('다 받았으면 왼쪽 아래 업데이트를 누르라고 알린다 (ko, en)', async () => {
    setLang('ko');
    let notify = await run({ kind: 'ready', version: '0.2.0' });
    expect(notify).toHaveBeenCalledWith('info', "새 버전 0.2.0을 받았어요. 왼쪽 아래 '업데이트'를 누르면 적용돼요.");
    setLang('en');
    notify = await run({ kind: 'ready', version: '0.2.0' });
    expect(notify).toHaveBeenCalledWith('info', 'Version 0.2.0 is ready. Click "Update" at the bottom left to install it.');
  });
});
