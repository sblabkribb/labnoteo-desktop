import { fromPluginData, fromStored, loadVaultSettings, saveVaultSettings } from '../settings';
import {
  isSecretLookingUrl,
  mcpClientCall,
  mcpClientConnect,
  mcpClientSecretSet,
  newServerId,
  cancelAllRequests,
  NetError,
} from '../../integrations/netIpc';
import { fakeInvoke, mcpServerInfoOf } from '../../integrations/__tests__/fakeNet';

const ok = (over: Record<string, unknown> = {}) => ({
  id: '0a1b2c3d',
  name: 'RAPID',
  url: 'https://rapid.kbiofoundry.kr/mcp',
  auth: 'bearer',
  preset: 'rapid',
  enabled: true,
  tools: { search: true, write: false },
  ...over,
});

describe('mcpClientServers 설정', () => {
  it('기본값은 [] 이고, 플러그인 data.json 에서는 가져오지 않는다', () => {
    expect(fromPluginData(undefined).mcpClientServers).toEqual([]);
    expect(fromStored({}).mcpClientServers).toEqual([]);
    expect(fromStored({ mcpClientServers: 'nope' }).mcpClientServers).toEqual([]);
    expect(fromPluginData({ mcpClientServers: [ok()] }).mcpClientServers).toEqual([]);
    // 설정마다 새 배열이다
    expect(fromStored({}).mcpClientServers).not.toBe(fromStored({}).mcpClientServers);
  });

  it('올바른 항목은 그대로 살린다', () => {
    const local = { id: 'deadbeef', name: 'Local', url: 'http://127.0.0.1:9000/mcp', auth: 'none', enabled: false, tools: {} };
    const got = fromStored({ mcpClientServers: [ok(), local] }).mcpClientServers;
    expect(got).toEqual([
      { id: '0a1b2c3d', name: 'RAPID', url: 'https://rapid.kbiofoundry.kr/mcp', auth: 'bearer', preset: 'rapid', enabled: true, tools: { search: true, write: false } },
      { id: 'deadbeef', name: 'Local', url: 'http://127.0.0.1:9000/mcp', auth: 'none', enabled: false, tools: {} },
    ]);
    // 빠진 enabled 는 false, 빠진 tools 는 {}, 불이 아닌 도구 값은 버린다
    const sparse = fromStored({
      mcpClientServers: [{ id: '0a1b2c3d', name: 'X', url: 'https://x.example/mcp', auth: 'none', tools: { a: true, b: 'yes' } }],
    }).mcpClientServers[0];
    expect(sparse).toEqual({ id: '0a1b2c3d', name: 'X', url: 'https://x.example/mcp', auth: 'none', enabled: false, tools: { a: true } });
    expect('preset' in sparse).toBe(false);
  });

  it('틀린 항목은 버린다(비밀처럼 보이는 URL 포함)', () => {
    const bad = [
      ok({ id: 'ABCDEF12' }),
      ok({ id: '0a1b2c3' }),
      ok({ id: 7 }),
      ok({ name: '' }),
      ok({ name: '   ' }),
      ok({ name: 'a'.repeat(41) }),
      ok({ name: 'bad\nname' }),
      ok({ name: 'bad\u0085name' }),
      ok({ url: 'https://x.example/mcp?key=1' }),
      ok({ url: 'https://u:p@x.example/mcp' }),
      ok({ url: 'https://x.example/mcp/a1B2c3D4e5F6g7H8i9J0k1L2' }),
      ok({ url: 'http://10.0.0.5:8000/mcp' }),
      ok({ url: 'ftp://x.example/mcp' }),
      ok({ url: 42 }),
      ok({ auth: 'basic' }),
      ok({ preset: 'other' }),
      ok({ enabled: 'yes' }),
      ok({ tools: [] }),
      ok({ tools: 'all' }),
      null,
      'x',
    ];
    for (const b of bad) expect(fromStored({ mcpClientServers: [b] }).mcpClientServers).toEqual([]);
    expect(fromStored({ mcpClientServers: [ok({ name: 'a'.repeat(40) })] }).mcpClientServers).toHaveLength(1);
    expect(fromStored({ mcpClientServers: [ok({ name: '서버 이름' })] }).mcpClientServers).toHaveLength(1);
  });

  it('평문 http 는 loopback 이거나 허락한 origin 일 때만', () => {
    const got = fromStored({
      allowHttpOrigins: ['http://10.0.0.5:8000'],
      mcpClientServers: [
        ok({ id: '00000001', url: 'http://10.0.0.5:8000/mcp' }),
        ok({ id: '00000002', url: 'http://10.0.0.6/mcp' }),
        ok({ id: '00000003', url: 'http://localhost:7000/mcp' }),
        ok({ id: '00000004', url: 'http://[::1]:7000/mcp' }),
        ok({ id: '00000005', url: 'http://127.0.0.2/mcp' }),
      ],
    }).mcpClientServers.map((s) => s.id);
    expect(got).toEqual(['00000001', '00000003', '00000004', '00000005']);
  });

  it('같은 id 는 한 번만, 많아야 16개', () => {
    const many = Array.from({ length: 17 }, (_, i) => ok({ id: i.toString(16).padStart(8, '0') }));
    expect(fromStored({ mcpClientServers: many }).mcpClientServers).toHaveLength(16);
    const dup = fromStored({ mcpClientServers: [ok(), ok({ url: 'https://b.example/mcp' })] }).mcpClientServers;
    expect(dup.map((s) => s.url)).toEqual(['https://rapid.kbiofoundry.kr/mcp']);
  });

  it('saveVaultSettings 가 키를 쓰고 다시 읽힌다', async () => {
    let stored: string | null = null;
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'settings_vault_read') return stored;
      if (cmd === 'settings_vault_write') {
        stored = String(args?.content);
        return null;
      }
      return null;
    }) as never;
    const { settings } = await loadVaultSettings(invoke);
    await saveVaultSettings({ ...settings, mcpClientServers: [ok() as never] }, invoke);
    expect(JSON.parse(stored!).mcpClientServers).toEqual([ok()]);
    expect((await loadVaultSettings(invoke)).settings.mcpClientServers).toEqual([ok()]);
  });
});

describe('isSecretLookingUrl / newServerId', () => {
  it('Rust 와 같은 규칙', () => {
    expect(isSecretLookingUrl('https://x.example/mcp/a1B2c3D4e5F6g7H8i9J0k1L2')).toBe(true);
    expect(isSecretLookingUrl('https://x.example/sk_live_1234567890abcdefghij/mcp')).toBe(true);
    expect(isSecretLookingUrl('https://x.example/mcp')).toBe(false);
    expect(isSecretLookingUrl('https://x.example/a1B2c3D4e5F6g7H8i9J0k1L')).toBe(false); // 23 chars
    expect(isSecretLookingUrl('https://x.example/mcp/abcdefghijklmnopqrstuvwxyz')).toBe(false); // letters only
    expect(isSecretLookingUrl('https://x.example/123456789012345678901234567')).toBe(false); // digits only
    expect(isSecretLookingUrl('not a url')).toBe(false);
  });

  it('newServerId 는 8자리 소문자 16진수이고 매번 다르다', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newServerId()));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(ids.size).toBe(50);
  });
});

describe('MCP 클라이언트 IPC 래퍼', () => {
  it('mcpClientCall 은 trackRequest 를 거쳐 취소가 Rust 에 닿는다', async () => {
    let release: (v: unknown) => void = () => undefined;
    const fake = fakeInvoke({
      mcp_client_call: () => new Promise((r) => (release = r)),
      net_cancel: () => true,
    });
    const ctl = new AbortController();
    const p = mcpClientCall('0a1b2c3d', 'search', { q: 'x' }, 'req-1', fake.invoke, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    release({ text: 'late', isError: false, truncated: false, omitted: 0 });
    expect(fake.calls).toEqual([
      ['mcp_client_call', { id: '0a1b2c3d', tool: 'search', args: { q: 'x' }, requestId: 'req-1' }],
      ['net_cancel', { requestId: 'req-1' }],
    ]);
  });

  it('mcpClientCall 은 보관함을 바꾸면 취소되고, id 를 안 주면 새로 만든다', async () => {
    const fake = fakeInvoke({ mcp_client_call: () => new Promise(() => undefined), net_cancel: () => true });
    const p = mcpClientCall('0a1b2c3d', 'search', {}, undefined, fake.invoke);
    await cancelAllRequests(fake.invoke);
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    const rid = fake.calls[0][1].requestId;
    expect(typeof rid).toBe('string');
    expect(fake.calls[1]).toEqual(['net_cancel', { requestId: rid }]);
  });

  it('mcpClientCall 결과를 그대로 돌려준다', async () => {
    const fake = fakeInvoke({ mcp_client_call: () => ({ text: 'hi', isError: false, truncated: false, omitted: 0 }) });
    expect(await mcpClientCall('0a1b2c3d', 't', {}, undefined, fake.invoke)).toEqual({ text: 'hi', isError: false, truncated: false, omitted: 0 });
  });

  it('거절은 NetError 이고, 토큰은 오류 글에 남지 않는다', async () => {
    const fake = fakeInvoke({
      mcp_client_connect: () => {
        throw { kind: 'mcpAuth', message: 'raw-rust-text' };
      },
      mcp_client_secret_set: (a) => {
        throw { kind: 'badInput', message: `bad ${String(a.value)}` };
      },
    });
    const e = await mcpClientConnect('0a1b2c3d', fake.invoke).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetError);
    expect((e as NetError).kind).toBe('mcpAuth');
    const s = await mcpClientSecretSet('0a1b2c3d', 'test-token-123', fake.invoke).catch((x: unknown) => x);
    expect((s as NetError).kind).toBe('badInput');
    expect((s as NetError).message).not.toContain('test-token-123');
  });

  it('mcpServerInfoOf 가짜는 McpServerInfo 모양이다', async () => {
    const info = mcpServerInfoOf({ name: 'RAPID', tools: ['a', 'b'] });
    const fake = fakeInvoke({ mcp_client_connect: () => info });
    const got = await mcpClientConnect('0a1b2c3d', fake.invoke);
    expect(got.tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(got.tools[0]).toMatchObject({ readOnly: false, destructive: false, tooLarge: false });
  });
});
