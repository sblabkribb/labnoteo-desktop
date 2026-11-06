import { restoreVault, openVault, type VaultInfo } from '../useVault';

const info: VaultInfo = { root: 'D:\\lab', name: 'lab', hasObsidianConfig: true };

function fake(replies: Record<string, unknown | (() => unknown)>) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args]);
    if (!(cmd in replies)) throw new Error(`unexpected call ${cmd}`);
    const r = replies[cmd];
    const v = typeof r === 'function' ? (r as () => unknown)() : r;
    if (v && typeof v === 'object' && 'reject' in v) throw (v as { reject: unknown }).reject;
    return v;
  };
  return { invoke: invoke as never, calls };
}

describe('보관함 복원', () => {
  it('마지막 보관함이 있으면 선택 화면을 건너뛴다', async () => {
    const f = fake({ vault_current: info });
    expect(await restoreVault(f.invoke)).toEqual({ status: 'ready', vault: info });
    expect(f.calls).toEqual([['vault_current', {}]]);
  });

  it('마지막 보관함 폴더가 사라졌으면 선택 화면을 보여준다', async () => {
    const f = fake({ vault_current: null });
    expect(await restoreVault(f.invoke)).toEqual({ status: 'picker' });
  });

  it('복원 호출이 실패해도 앱은 선택 화면으로 뜬다', async () => {
    const f = fake({ vault_current: { reject: new Error('boom') } });
    expect(await restoreVault(f.invoke)).toEqual({ status: 'picker' });
  });
});

describe('보관함 열기', () => {
  it('고른 폴더를 vault_open 에 path 로 보내고 준비 상태가 된다', async () => {
    const f = fake({ vault_open: info });
    expect(await openVault(f.invoke, 'D:\\lab')).toEqual({ status: 'ready', vault: info });
    expect(f.calls).toEqual([['vault_open', { path: 'D:\\lab' }]]);
  });

  it('열기가 거부되면 선택 화면에 남고 오류 문구를 준다', async () => {
    const f = fake({ vault_open: { reject: { kind: 'vaultNotFound', message: 'x' } } });
    const s = await openVault(f.invoke, 'D:\\gone');
    expect(s.status).toBe('picker');
    expect(s.status === 'picker' && s.error).toBeTruthy();
  });
});
